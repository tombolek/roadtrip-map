/* Roadtrip Map — trip sharing API (Netlify Function + Netlify Blobs).
   Trips are stored under trips/<id>/meta.json + trips/<id>/photos/<pid>.
   Every read and photo upload requires the trip password (x-trip-key header),
   verified against a salted PBKDF2 hash stored with the trip. */
import { getStore } from "@netlify/blobs";

export const config = {
  path: ["/api/trips", "/api/trips/:id", "/api/trips/:id/photos/:pid"],
};

const MAX_PHOTO_BYTES = 5 * 1024 * 1024; // downscaled photos are well under this
const enc = new TextEncoder();

async function hashPassword(password, saltHex) {
  const salt = saltHex
    ? Uint8Array.from(saltHex.match(/.{2}/g).map(b => parseInt(b, 16)))
    : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 }, key, 256);
  const toHex = a => [...new Uint8Array(a)].map(b => b.toString(16).padStart(2, "0")).join("");
  return { salt: toHex(salt.buffer ? salt.buffer : salt), hash: toHex(bits) };
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

async function requireAuth(store, id, pass) {
  const meta = await store.get(`trips/${id}/meta.json`, { type: "json" });
  if (!meta) return { err: json({ error: "not found" }, 404) };
  const { hash } = await hashPassword(pass || "", meta.salt);
  if (!timingSafeEqual(hash, meta.hash)) return { err: json({ error: "unauthorized" }, 401) };
  return { meta };
}

export default async (req, context) => {
  const store = getStore("roadtrip");
  const { id, pid } = context.params ?? {};
  const headerKey = req.headers.get("x-trip-key") || "";

  /* ---- POST /api/trips — publish new or update existing ---- */
  if (req.method === "POST" && !id) {
    let body;
    try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
    const { tripId, password, name, photos } = body || {};
    if (!password || String(password).length < 4) return json({ error: "password too short" }, 400);
    if (!name || !Array.isArray(photos)) return json({ error: "missing name/photos" }, 400);
    if (photos.length > 500) return json({ error: "too many photos" }, 400);

    const cleanPhotos = photos.map(p => ({
      id: String(p.id).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40),
      name: String(p.name || "photo").slice(0, 120),
      ts: typeof p.ts === "number" ? p.ts : null,
      lat: typeof p.lat === "number" ? p.lat : null,
      lng: typeof p.lng === "number" ? p.lng : null,
    }));

    let outId, salt, hash;
    if (tripId) {
      // update: password must match the existing trip
      const auth = await requireAuth(store, String(tripId), password);
      if (auth.err) return auth.err;
      outId = String(tripId); salt = auth.meta.salt; hash = auth.meta.hash;
      // remove photos that no longer exist in the trip
      const keep = new Set(cleanPhotos.map(p => p.id));
      const { blobs } = await store.list({ prefix: `trips/${outId}/photos/` });
      for (const b of blobs) {
        const old = b.key.split("/").pop();
        if (!keep.has(old)) await store.delete(b.key);
      }
    } else {
      outId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
      ({ salt, hash } = await hashPassword(password));
    }

    await store.setJSON(`trips/${outId}/meta.json`, {
      name: String(name).slice(0, 80),
      photos: cleanPhotos,
      salt, hash,
      updatedAt: Date.now(),
    });
    return json({ id: outId });
  }

  /* ---- GET /api/trips/:id — trip meta (auth) ---- */
  if (req.method === "GET" && id && !pid) {
    const auth = await requireAuth(store, id, headerKey);
    if (auth.err) return auth.err;
    const { name, photos, updatedAt } = auth.meta;
    return json({ name, photos, updatedAt });
  }

  /* ---- PUT /api/trips/:id/photos/:pid — upload photo bytes (auth) ---- */
  if (req.method === "PUT" && id && pid) {
    const auth = await requireAuth(store, id, headerKey);
    if (auth.err) return auth.err;
    const safePid = String(pid).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
    if (!auth.meta.photos.some(p => p.id === safePid)) return json({ error: "unknown photo" }, 400);
    const buf = await req.arrayBuffer();
    if (buf.byteLength === 0 || buf.byteLength > MAX_PHOTO_BYTES) return json({ error: "bad size" }, 413);
    await store.set(`trips/${id}/photos/${safePid}`, buf);
    return json({ ok: true });
  }

  /* ---- GET /api/trips/:id/photos/:pid — photo bytes (auth) ---- */
  if (req.method === "GET" && id && pid) {
    const auth = await requireAuth(store, id, headerKey);
    if (auth.err) return auth.err;
    const safePid = String(pid).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
    const blob = await store.get(`trips/${id}/photos/${safePid}`, { type: "arrayBuffer" });
    if (!blob) return json({ error: "not found" }, 404);
    return new Response(blob, {
      headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=3600" },
    });
  }

  return json({ error: "method not allowed" }, 405);
};
