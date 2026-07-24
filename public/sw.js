/* Roadtrip Map — service worker.
   1. Receives photos shared from Android (Web Share Target POST) and stores
      them into the IndexedDB "inbox" — entirely on-device.
   2. Caches the app shell + CDN libs for offline use. */
"use strict";

const CACHE = "roadtrip-v5";
const SHELL = [
  "/", "/index.html", "/app.js", "/manifest.webmanifest",
  "/icons/icon-192.png", "/icons/icon-512.png",
];
const CDN_HOSTS = ["cdnjs.cloudflare.com", "cdn.jsdelivr.net"];

/* ---- IndexedDB (must match app.js schema) ---- */
const DB_NAME = "roadtrip-map", DB_VERSION = 1;
function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("trips")) db.createObjectStore("trips", { keyPath: "id" });
      if (!db.objectStoreNames.contains("photos")) {
        const s = db.createObjectStore("photos", { keyPath: "id" });
        s.createIndex("tripId", "tripId");
      }
      if (!db.objectStoreNames.contains("inbox")) db.createObjectStore("inbox", { keyPath: "id" });
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv", { keyPath: "k" });
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
async function stashInInbox(files) {
  const db = await openDB();
  await new Promise((res, rej) => {
    const t = db.transaction("inbox", "readwrite");
    const os = t.objectStore("inbox");
    for (const f of files) {
      os.put({
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 9),
        name: f.name || "shared-photo",
        type: f.type || "image/jpeg",
        blob: f,
        receivedAt: Date.now(),
      });
    }
    t.oncomplete = res; t.onerror = () => rej(t.error);
  });
  const clients = await self.clients.matchAll({ type: "window" });
  clients.forEach(c => c.postMessage("inbox-updated"));
}

/* ---- lifecycle ---- */
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

/* ---- fetch ---- */
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);

  // Android share target: photos POSTed here by the OS
  if (e.request.method === "POST" && url.pathname === "/share-target") {
    e.respondWith((async () => {
      try {
        const form = await e.request.formData();
        // Collect files from every field (Files app may not use "photos"),
        // and keep anything that looks like an image regardless of MIME type
        // (Android often shares as application/octet-stream from Files).
        const files = [];
        for (const [, v] of form.entries()) {
          if (v && typeof v === "object" && "size" in v && v.size) {
            const type = v.type || "";
            const name = (v.name || "").toLowerCase();
            const looksImage = type.startsWith("image/") ||
              /\.(jpe?g|png|heic|heif|webp|gif|bmp|tiff?)$/.test(name) ||
              type === "" || type === "application/octet-stream";
            if (looksImage) files.push(v);
          }
        }
        await stashInInbox(files);
      } catch (err) { console.error("share-target failed", err); }
      return Response.redirect("/?shared=1", 303);
    })());
    return;
  }

  if (e.request.method !== "GET") return;          // let API calls pass through
  if (url.pathname.startsWith("/api/")) return;    // never cache trip data
  if (url.pathname.startsWith("/tile") || url.hostname.includes("openstreetmap")) return; // live map tiles

  // CDN libs: cache-first
  if (CDN_HOSTS.includes(url.hostname)) {
    e.respondWith(caches.open(CACHE).then(async c => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const resp = await fetch(e.request);
      if (resp.ok) c.put(e.request, resp.clone());
      return resp;
    }));
    return;
  }

  // same-origin shell: network-first with cache fallback
  if (url.origin === location.origin) {
    e.respondWith((async () => {
      try {
        const resp = await fetch(e.request);
        if (resp.ok) (await caches.open(CACHE)).put(e.request, resp.clone());
        return resp;
      } catch {
        const hit = await caches.match(e.request, { ignoreSearch: true });
        return hit || caches.match("/index.html");
      }
    })());
  }
});
