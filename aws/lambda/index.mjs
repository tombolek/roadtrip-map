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
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
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
function verify(password, rec) {
  const { hash } = hashPassword(password, rec.salt);
  const a = Buffer.from(hash, "hex"), b = Buffer.from(rec.hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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
      const { tripId, password, name, photos, need } = body;
      if (!password || String(password).length < 4) return json(400, { error: "password too short" });
      if (!name || !Array.isArray(photos)) return json(400, { error: "missing name/photos" });
      if (photos.length > 2000) return json(400, { error: "too many photos" });

      const clean = photos.map(p => ({
        id: cleanId(p.id),
        name: String(p.name || "photo").slice(0, 120),
        ts: typeof p.ts === "number" ? p.ts : null,
        lat: typeof p.lat === "number" ? p.lat : null,
        lng: typeof p.lng === "number" ? p.lng : null,
      }));

      let id, salt, hash;
      if (tripId) {
        const rec = await getTrip(cleanId(tripId));
        if (!rec) return json(404, { error: "not found" });
        if (!verify(password, rec)) return json(401, { error: "unauthorized" });
        id = cleanId(tripId); salt = rec.salt; hash = rec.hash;
        await deleteOrphans(id, new Set(clean.map(p => p.id)));
      } else {
        id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
        ({ salt, hash } = hashPassword(password));
      }

      await ddb.send(new PutCommand({
        TableName: TABLE,
        Item: { tripId: id, name: String(name).slice(0, 80), photos: clean, salt, hash, updatedAt: Date.now() },
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
      if (!verify(password || "", rec)) return json(401, { error: "unauthorized" });

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
      return json(200, { id, name: rec.name, photos: rec.photos }, { cookies });
    }

    return json(405, { error: "method not allowed" });
  } catch (e) {
    console.error(e);
    return json(500, { error: "server error" });
  }
};
