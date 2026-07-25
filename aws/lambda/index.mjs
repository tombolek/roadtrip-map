/* Roadtrip Map — AWS backend Lambda (behind CloudFront /api/*).
   Routes:
     POST /api/publish  — create/update a trip in DynamoDB, return presigned
                          S3 PUT URLs so the browser uploads photos+thumbs
                          directly to S3 in parallel.
     POST /api/auth     — verify the trip password, return trip metadata and
                          set 48h CloudFront signed cookies so the browser can
                          fetch images straight from the CDN (/trips/<id>/*).
   Secrets (password hashes) live only in DynamoDB; image bytes only in S3. */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, UpdateCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getSignedCookies } from "@aws-sdk/cloudfront-signer";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import crypto from "node:crypto";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const sm = new SecretsManagerClient({});

const TABLE = process.env.TABLE;
const ACCOUNTS_TABLE = process.env.ACCOUNTS_TABLE;
const BUCKET = process.env.MEDIA_BUCKET;
const CF_DOMAIN = process.env.CF_DOMAIN;            // e.g. d123.cloudfront.net
const KEY_PAIR_ID = process.env.CF_KEY_PAIR_ID;     // CloudFront public key id
const SECRET_ARN = process.env.PRIVATE_KEY_SECRET_ARN;
const SESSION_SECRET_ARN = process.env.SESSION_SECRET_ARN;
const COOKIE_TTL = 48 * 60 * 60;                    // seconds (media cookies)
const SESSION_TTL = 30 * 24 * 60 * 60;              // seconds (owner login)
const UPLOAD_TTL = 60 * 60;

let _pk, _sess;
async function privateKey() {
  if (!_pk) _pk = (await sm.send(new GetSecretValueCommand({ SecretId: SECRET_ARN }))).SecretString;
  return _pk;
}
async function sessionSecret() {
  if (!_sess) _sess = (await sm.send(new GetSecretValueCommand({ SecretId: SESSION_SECRET_ARN }))).SecretString;
  return _sess;
}

/* ---- owner session tokens (HMAC-signed, stateless) ---- */
const b64url = b => Buffer.from(b).toString("base64url");
async function makeSession(username, initials) {
  const payload = b64url(JSON.stringify({ u: username, i: initials, exp: Math.floor(Date.now() / 1000) + SESSION_TTL }));
  const sig = crypto.createHmac("sha256", await sessionSecret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}
async function readSession(event) {
  try {
    const cookies = event.cookies || [];
    const raw = cookies.map(c => c.split("=")).find(([k]) => k === "rt_sess")?.slice(1).join("=");
    if (!raw) return null;
    const [payload, sig] = raw.split(".");
    const expect = crypto.createHmac("sha256", await sessionSecret()).update(payload).digest("base64url");
    if (sig !== expect) return null;
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!data.exp || Math.floor(Date.now() / 1000) > data.exp) return null;
    return { username: data.u, initials: data.i };
  } catch { return null; }
}

/* ---- accounts ---- */
const getAccount = username => ddb.send(new GetCommand({ TableName: ACCOUNTS_TABLE, Key: { username } })).then(r => r.Item);

/* ---- password hashing (PBKDF2, salted) ---- */
function hashPassword(password, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, "hex") : crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 32, "sha256");
  return { salt: salt.toString("hex"), hash: hash.toString("hex") };
}
function hashMatches(password, saltHex, hashHex) {
  if (!saltHex || !hashHex) return false;
  const { hash } = hashPassword(password || "", saltHex);
  const a = Buffer.from(hash, "hex"), b = Buffer.from(hashHex, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// view password: rec.salt/rec.hash
function verifyView(password, rec) { return hashMatches(password, rec.salt, rec.hash); }
// editor code: rec.esalt/rec.ehash; legacy trips (no editor hash) fall back to
// the single original password so existing trips keep working until re-shared
function verifyEdit(code, rec) {
  if (rec.ehash) return hashMatches(code, rec.esalt, rec.ehash);
  return hashMatches(code, rec.salt, rec.hash);
}

const json = (statusCode, obj, extra = {}) => ({
  statusCode,
  headers: { "content-type": "application/json", ...(extra.headers || {}) },
  ...(extra.cookies ? { cookies: extra.cookies } : {}),
  body: JSON.stringify(obj),
});

const cleanId = s => String(s).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
const getTrip = id => ddb.send(new GetCommand({ TableName: TABLE, Key: { tripId: id } })).then(r => r.Item);

async function deleteOrphans(id, keepIds) {
  for (const kind of ["photos", "thumbs"]) {
    const prefix = `trips/${id}/${kind}/`;
    let token;
    do {
      const out = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }));
      const toDelete = (out.Contents || [])
        .filter(o => !keepIds.has(o.Key.split("/").pop()))
        .map(o => ({ Key: o.Key }));
      if (toDelete.length) await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: toDelete } }));
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);
  }
}

export const handler = async (event) => {
  const method = event.requestContext?.http?.method;
  const path = event.rawPath || "";
  let body = {};
  try { body = event.body ? JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, "base64").toString() : event.body) : {}; }
  catch { return json(400, { error: "bad json" }); }

  try {
    /* ---------- POST /api/login ---------- */
    if (method === "POST" && path.endsWith("/login")) {
      const username = String(body.username || "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 30);
      const acct = await getAccount(username);
      if (!acct || !hashMatches(body.password || "", acct.salt, acct.hash))
        return json(401, { error: "wrong username or password" });
      const token = await makeSession(username, acct.initials);
      const attrs = `Domain=${CF_DOMAIN}; Path=/; Secure; HttpOnly; SameSite=Lax`;
      // owner also gets CloudFront media cookies for ALL trips so any trip's
      // images load in the management UI
      const exp = Math.floor(Date.now() / 1000) + COOKIE_TTL;
      const policy = JSON.stringify({ Statement: [{ Resource: `https://${CF_DOMAIN}/trips/*`, Condition: { DateLessThan: { "AWS:EpochTime": exp } } }] });
      const signed = getSignedCookies({ keyPairId: KEY_PAIR_ID, privateKey: await privateKey(), policy });
      const mattr = `Domain=${CF_DOMAIN}; Path=/trips/; Secure; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_TTL}`;
      return json(200, { username, initials: acct.initials, name: acct.name, mustChangePw: !!acct.mustChangePw }, {
        cookies: [
          `rt_sess=${token}; ${attrs}; Max-Age=${SESSION_TTL}`,
          `CloudFront-Policy=${signed["CloudFront-Policy"]}; ${mattr}`,
          `CloudFront-Signature=${signed["CloudFront-Signature"]}; ${mattr}`,
          `CloudFront-Key-Pair-Id=${signed["CloudFront-Key-Pair-Id"]}; ${mattr}`,
        ],
      });
    }

    /* ---------- POST /api/logout ---------- */
    if (method === "POST" && path.endsWith("/logout")) {
      const clear = `Domain=${CF_DOMAIN}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
      return json(200, { ok: true }, { cookies: [`rt_sess=; ${clear}`] });
    }

    /* ---------- GET /api/me — who am I ---------- */
    if (method === "GET" && path.endsWith("/me")) {
      const s = await readSession(event);
      if (!s) return json(401, { error: "not logged in" });
      const acct = await getAccount(s.username);
      return json(200, { username: s.username, initials: s.initials, name: acct?.name, mustChangePw: !!acct?.mustChangePw });
    }

    /* ---------- POST /api/change-password (session required) ---------- */
    if (method === "POST" && path.endsWith("/change-password")) {
      const s = await readSession(event);
      if (!s) return json(401, { error: "not logged in" });
      const acct = await getAccount(s.username);
      if (!acct || !hashMatches(body.currentPassword || "", acct.salt, acct.hash))
        return json(401, { error: "current password is wrong" });
      if (!body.newPassword || String(body.newPassword).length < 6)
        return json(400, { error: "new password must be at least 6 characters" });
      const { salt, hash } = hashPassword(body.newPassword);
      await ddb.send(new UpdateCommand({
        TableName: ACCOUNTS_TABLE, Key: { username: s.username },
        UpdateExpression: "SET salt = :s, #h = :h REMOVE mustChangePw",
        ExpressionAttributeNames: { "#h": "hash" },
        ExpressionAttributeValues: { ":s": salt, ":h": hash },
      }));
      return json(200, { ok: true });
    }

    /* ---------- GET /api/trips — list all household trips (session required) ---------- */
    if (method === "GET" && path.endsWith("/trips")) {
      const s = await readSession(event);
      if (!s) return json(401, { error: "not logged in" });
      const items = [];
      let start;
      do {
        const out = await ddb.send(new ScanCommand({
          TableName: TABLE, ExclusiveStartKey: start,
          ProjectionExpression: "tripId, #n, updatedAt, photos, dayNotes, disabled, shared, viewCount, uniqueCount, lastAccess, dailyViews",
          ExpressionAttributeNames: { "#n": "name" },
        }));
        for (const t of out.Items || []) items.push(t);
        start = out.LastEvaluatedKey;
      } while (start);
      const trips = items.map(t => ({
        id: t.tripId, name: t.name, updatedAt: t.updatedAt || 0,
        photoCount: Array.isArray(t.photos) ? t.photos.length : 0,
        disabled: !!t.disabled, shared: !!t.shared,
        viewCount: t.viewCount || 0, uniqueCount: t.uniqueCount || 0, lastAccess: t.lastAccess || null,
        dailyViews: t.dailyViews || {},
      })).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      return json(200, { trips });
    }

    /* ---------- POST /api/publish ---------- */
    if (method === "POST" && path.endsWith("/publish")) {
      const session = await readSession(event);
      const { tripId, password, name, photos, need, dayNotes, track } = body;
      // new model: writes are authorized by an owner session. Legacy clients
      // still send an editor code (accepted until the frontend fully migrates).
      const viewPassword = body.viewPassword || password;
      const editKey = body.editKey || password;
      if (!name || !Array.isArray(photos)) return json(400, { error: "missing name/photos" });
      if (photos.length > 2000) return json(400, { error: "too many photos" });
      // an update must carry a valid tripId; a create must omit it entirely
      if (tripId != null && tripId !== "" && !cleanId(tripId)) return json(400, { error: "invalid tripId" });
      if (!session && (!editKey || String(editKey).length < 4)) return json(401, { error: "not authorized" });

      // route track: array of [lat,lng] finite pairs, capped
      let cleanTrack = [];
      if (Array.isArray(track)) {
        cleanTrack = track
          .filter(pt => Array.isArray(pt) && Number.isFinite(pt[0]) && Number.isFinite(pt[1]))
          .slice(0, 1000)
          .map(pt => [Math.round(pt[0] * 1e5) / 1e5, Math.round(pt[1] * 1e5) / 1e5]);
      }

      const stamp = session?.initials || null;
      const clean = photos.map(p => ({
        id: cleanId(p.id),
        name: String(p.name || "photo").slice(0, 120),
        ts: typeof p.ts === "number" ? p.ts : null,
        lat: typeof p.lat === "number" ? p.lat : null,
        lng: typeof p.lng === "number" ? p.lng : null,
        caption: String(p.caption || "").slice(0, 500),
        uploadedBy: String(p.uploadedBy || stamp || "").slice(0, 4),
      }));

      const cleanNotes = {};
      if (dayNotes && typeof dayNotes === "object") {
        for (const [k, v] of Object.entries(dayNotes)) {
          if (typeof v === "string" && v.trim()) cleanNotes[String(k).slice(0, 20)] = v.slice(0, 500);
        }
      }

      let rec = null, id, salt, hash, esalt, ehash;
      if (tripId) {
        rec = await getTrip(cleanId(tripId));
        if (!rec) return json(404, { error: "not found" });
        if (!session && !verifyEdit(editKey, rec)) return json(401, { error: "unauthorized" });
        id = cleanId(tripId);
        salt = rec.salt; hash = rec.hash;
        if (body.viewPassword) ({ salt, hash } = hashPassword(body.viewPassword));
        esalt = rec.esalt; ehash = rec.ehash;
        if (body.editKey && !session) ({ salt: esalt, hash: ehash } = hashPassword(editKey));
        await deleteOrphans(id, new Set(clean.map(p => p.id)));
      } else {
        id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
        if (viewPassword) ({ salt, hash } = hashPassword(viewPassword));
        if (editKey && !session) ({ salt: esalt, hash: ehash } = hashPassword(editKey));
      }

      const item = {
        tripId: id, name: String(name).slice(0, 80),
        photos: clean, dayNotes: cleanNotes, track: cleanTrack,
        disabled: typeof body.disabled === "boolean" ? body.disabled : (rec?.disabled || false),
        viewCount: rec?.viewCount || 0, uniqueCount: rec?.uniqueCount || 0, lastAccess: rec?.lastAccess || null,
        dailyViews: rec?.dailyViews || {},
        shared: !!salt,                       // has a family view password
        updatedAt: Date.now(),
      };
      if (salt) { item.salt = salt; item.hash = hash; }
      if (esalt) { item.esalt = esalt; item.ehash = ehash; }
      await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));

      // presigned direct-to-S3 upload URLs (only for the ids the client still needs)
      const wanted = Array.isArray(need) ? new Set(need.map(cleanId)) : null;
      const uploads = {};
      for (const p of clean) {
        if (wanted && !wanted.has(p.id)) continue;
        uploads[p.id] = {
          photo: await getSignedUrl(s3, new PutObjectCommand({
            Bucket: BUCKET, Key: `trips/${id}/photos/${p.id}`, ContentType: "image/jpeg" }), { expiresIn: UPLOAD_TTL }),
          thumb: await getSignedUrl(s3, new PutObjectCommand({
            Bucket: BUCKET, Key: `trips/${id}/thumbs/${p.id}`, ContentType: "image/jpeg" }), { expiresIn: UPLOAD_TTL }),
        };
      }
      return json(200, { id, uploads });
    }

    /* ---------- POST /api/auth ---------- */
    if (method === "POST" && path.endsWith("/auth")) {
      const { tripId, password } = body;
      const id = cleanId(tripId || "");
      if (!id) return json(400, { error: "missing tripId" });
      const rec = await getTrip(id);
      if (!rec) return json(404, { error: "not found" });
      const owner = await readSession(event);   // logged-in owner may preview any trip
      // a viewer password grants read; the editor code grants edit (and read).
      let role = null;
      if (owner) role = "editor";
      else if (verifyEdit(password || "", rec) && rec.ehash) role = "editor";
      else if (verifyView(password || "", rec)) role = "viewer";
      else if (verifyEdit(password || "", rec)) role = "editor"; // legacy (no ehash)
      if (!role) return json(401, { error: "unauthorized" });
      if (rec.disabled && !owner) return json(410, { error: "this shared link has been deactivated" });

      // record a view (viewers only; owner previews don't count). Unique-ish via
      // a long-lived per-visitor cookie.
      let extraCookies = [];
      if (role === "viewer") {
        const seen = (event.cookies || []).some(c => c.startsWith(`rt_v_${id}=`));
        // per-day bucket (recompute the whole map to avoid nested-path issues
        // and to work for trips created before daily tracking existed)
        const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
        const dv = rec.dailyViews || {};
        dv[today] = (dv[today] || 0) + 1;
        const expr = seen
          ? "ADD viewCount :one SET lastAccess = :now, dailyViews = :dv"
          : "ADD viewCount :one, uniqueCount :one SET lastAccess = :now, dailyViews = :dv";
        try {
          await ddb.send(new UpdateCommand({
            TableName: TABLE, Key: { tripId: id },
            UpdateExpression: expr,
            ExpressionAttributeValues: { ":one": 1, ":now": Date.now(), ":dv": dv },
          }));
        } catch (e) { console.warn("stat update failed", e); }
        if (!seen) extraCookies.push(`rt_v_${id}=1; Domain=${CF_DOMAIN}; Path=/; Secure; SameSite=Lax; Max-Age=31536000`);
      }

      const exp = Math.floor(Date.now() / 1000) + COOKIE_TTL;
      const policy = JSON.stringify({
        Statement: [{
          Resource: `https://${CF_DOMAIN}/trips/${id}/*`,
          Condition: { DateLessThan: { "AWS:EpochTime": exp } },
        }],
      });
      const signed = getSignedCookies({ keyPairId: KEY_PAIR_ID, privateKey: await privateKey(), policy });
      const attrs = `Domain=${CF_DOMAIN}; Path=/trips/${id}/; Secure; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_TTL}`;
      const cookies = [
        `CloudFront-Policy=${signed["CloudFront-Policy"]}; ${attrs}`,
        `CloudFront-Signature=${signed["CloudFront-Signature"]}; ${attrs}`,
        `CloudFront-Key-Pair-Id=${signed["CloudFront-Key-Pair-Id"]}; ${attrs}`,
        ...extraCookies,
      ];
      return json(200, { id, role, name: rec.name, photos: rec.photos, dayNotes: rec.dayNotes || {}, track: rec.track || [] }, { cookies });
    }

    /* ---------- POST /api/set-disabled — activate/deactivate a share link (owner) ---------- */
    if (method === "POST" && path.endsWith("/set-disabled")) {
      const owner = await readSession(event);
      if (!owner) return json(401, { error: "not logged in" });
      const id = cleanId(body.tripId || "");
      if (!id) return json(400, { error: "missing tripId" });
      const rec = await getTrip(id);
      if (!rec) return json(404, { error: "not found" });
      await ddb.send(new UpdateCommand({
        TableName: TABLE, Key: { tripId: id },
        UpdateExpression: "SET disabled = :d",
        ExpressionAttributeValues: { ":d": !!body.disabled },
      }));
      return json(200, { ok: true, disabled: !!body.disabled });
    }

    /* ---------- POST /api/unpublish — remove a shared trip entirely ---------- */
    if (method === "POST" && path.endsWith("/unpublish")) {
      const { tripId, password } = body;
      const id = cleanId(tripId || "");
      if (!id) return json(400, { error: "missing tripId" });
      const rec = await getTrip(id);
      if (!rec) return json(200, { ok: true });          // already gone — idempotent
      const owner = await readSession(event);
      if (!owner && !verifyEdit(password || "", rec)) return json(401, { error: "unauthorized" });
      // delete all image objects, then the DynamoDB record
      let token;
      do {
        const out = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `trips/${id}/`, ContinuationToken: token }));
        const objs = (out.Contents || []).map(o => ({ Key: o.Key }));
        if (objs.length) await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: objs } }));
        token = out.IsTruncated ? out.NextContinuationToken : undefined;
      } while (token);
      await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { tripId: id } }));
      return json(200, { ok: true });
    }

    return json(405, { error: "method not allowed" });
  } catch (e) {
    console.error(e);
    return json(500, { error: "server error" });
  }
};
