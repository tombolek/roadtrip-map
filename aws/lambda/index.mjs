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
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getSignedCookies } from "@aws-sdk/cloudfront-signer";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import crypto from "node:crypto";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const sm = new SecretsManagerClient({});

const TABLE = process.env.TABLE;
const BUCKET = process.env.MEDIA_BUCKET;
const CF_DOMAIN = process.env.CF_DOMAIN;            // e.g. d123.cloudfront.net
const KEY_PAIR_ID = process.env.CF_KEY_PAIR_ID;     // CloudFront public key id
const SECRET_ARN = process.env.PRIVATE_KEY_SECRET_ARN;
const COOKIE_TTL = 48 * 60 * 60;                    // seconds
const UPLOAD_TTL = 60 * 60;

let _pk;
async function privateKey() {
  if (!_pk) _pk = (await sm.send(new GetSecretValueCommand({ SecretId: SECRET_ARN }))).SecretString;
  return _pk;
}

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
    /* ---------- POST /api/publish ---------- */
    if (method === "POST" && path.endsWith("/publish")) {
      const { tripId, password, name, photos, need, dayNotes, track } = body;
      // dual secrets; legacy clients may still send a single `password`
      const viewPassword = body.viewPassword || password;
      const editKey = body.editKey || password;
      if (!editKey || String(editKey).length < 4) return json(400, { error: "editor code too short" });
      if (!name || !Array.isArray(photos)) return json(400, { error: "missing name/photos" });
      if (photos.length > 2000) return json(400, { error: "too many photos" });

      // route track: array of [lat,lng] finite pairs, capped
      let cleanTrack = [];
      if (Array.isArray(track)) {
        cleanTrack = track
          .filter(pt => Array.isArray(pt) && Number.isFinite(pt[0]) && Number.isFinite(pt[1]))
          .slice(0, 1000)
          .map(pt => [Math.round(pt[0] * 1e5) / 1e5, Math.round(pt[1] * 1e5) / 1e5]);
      }

      const clean = photos.map(p => ({
        id: cleanId(p.id),
        name: String(p.name || "photo").slice(0, 120),
        ts: typeof p.ts === "number" ? p.ts : null,
        lat: typeof p.lat === "number" ? p.lat : null,
        lng: typeof p.lng === "number" ? p.lng : null,
        caption: String(p.caption || "").slice(0, 500),
      }));

      // day notes: a small map of dayKey -> short text (owner-authored)
      const cleanNotes = {};
      if (dayNotes && typeof dayNotes === "object") {
        for (const [k, v] of Object.entries(dayNotes)) {
          if (typeof v === "string" && v.trim()) {
            cleanNotes[String(k).slice(0, 20)] = v.slice(0, 500);
          }
        }
      }

      let id, salt, hash, esalt, ehash;
      if (tripId) {
        const rec = await getTrip(cleanId(tripId));
        if (!rec) return json(404, { error: "not found" });
        if (!verifyEdit(editKey, rec)) return json(401, { error: "unauthorized" });
        id = cleanId(tripId);
        // keep existing view hash unless a viewPassword is explicitly provided
        salt = rec.salt; hash = rec.hash;
        if (body.viewPassword) ({ salt, hash } = hashPassword(body.viewPassword));
        // upgrade legacy trips (no editor hash) to a distinct editor code
        esalt = rec.esalt; ehash = rec.ehash;
        if (!ehash || body.editKey) ({ salt: esalt, hash: ehash } = hashPassword(editKey));
        await deleteOrphans(id, new Set(clean.map(p => p.id)));
      } else {
        id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
        ({ salt, hash } = hashPassword(viewPassword));
        ({ salt: esalt, hash: ehash } = hashPassword(editKey));
      }

      await ddb.send(new PutCommand({
        TableName: TABLE,
        Item: { tripId: id, name: String(name).slice(0, 80), photos: clean, dayNotes: cleanNotes, track: cleanTrack, salt, hash, esalt, ehash, updatedAt: Date.now() },
      }));

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
      const rec = await getTrip(id);
      if (!rec) return json(404, { error: "not found" });
      // a viewer password grants read; the editor code grants edit (and read).
      // check editor first so a distinct editor code isn't shadowed.
      let role = null;
      if (verifyEdit(password || "", rec) && rec.ehash) role = "editor";
      else if (verifyView(password || "", rec)) role = "viewer";
      else if (verifyEdit(password || "", rec)) role = "editor"; // legacy (no ehash)
      if (!role) return json(401, { error: "unauthorized" });

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
      ];
      return json(200, { id, role, name: rec.name, photos: rec.photos, dayNotes: rec.dayNotes || {}, track: rec.track || [] }, { cookies });
    }

    /* ---------- POST /api/unpublish — remove a shared trip entirely ---------- */
    if (method === "POST" && path.endsWith("/unpublish")) {
      const { tripId, password } = body;
      const id = cleanId(tripId || "");
      const rec = await getTrip(id);
      if (!rec) return json(200, { ok: true });          // already gone — idempotent
      if (!verifyEdit(password || "", rec)) return json(401, { error: "unauthorized" });
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
