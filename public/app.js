/* Roadtrip Map — app logic. Local-first: everything lives in IndexedDB on this
   device. Publishing a trip uploads a copy to Netlify Blobs via /api/trips. */
"use strict";

/* ---------------- IndexedDB ---------------- */
const DB_NAME = "roadtrip-map", DB_VERSION = 1;
let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
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
    req.onsuccess = () => { _db = req.result; res(_db); };
    req.onerror = () => rej(req.error);
  });
}
function tx(store, mode, fn) {
  return openDB().then(db => new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
    t.onerror = () => rej(t.error);
  }));
}
const idb = {
  put: (s, v) => tx(s, "readwrite", os => { os.put(v); return v; }),
  del: (s, k) => tx(s, "readwrite", os => os.delete(k)),
  get: (s, k) => openDB().then(db => new Promise((res, rej) => {
    const r = db.transaction(s).objectStore(s).get(k);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  })),
  all: (s) => openDB().then(db => new Promise((res, rej) => {
    const r = db.transaction(s).objectStore(s).getAll();
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  })),
  byIndex: (s, idx, val) => openDB().then(db => new Promise((res, rej) => {
    const r = db.transaction(s).objectStore(s).index(idx).getAll(val);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  })),
};
const kvGet = k => idb.get("kv", k).then(r => r && r.v);
const kvSet = (k, v) => idb.put("kv", { k, v });

/* ---------------- helpers ---------------- */
const $ = id => document.getElementById(id);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
let toastTimer = null;
function toast(msg, ms = 3200) {
  const t = $("toast"); t.textContent = msg; t.style.display = "block";
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.style.display = "none", ms);
}
function busy(msg) {
  if (msg === false) { $("busy").classList.remove("open"); return; }
  $("busyText").textContent = msg; $("busy").classList.add("open");
}
function fmtDate(ts) {
  if (!ts) return "no date";
  return new Date(ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/* ---------------- image processing ---------------- */
const MAX_DIM = 2048, THUMB_DIM = 400, JPEG_Q = 0.85;

async function decodeBitmap(blob) {
  try { return await createImageBitmap(blob, { imageOrientation: "from-image" }); }
  catch { return await createImageBitmap(blob); } // some browsers reject the option
}
function scaleToBlob(bitmap, maxDim, q) {
  const ratio = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * ratio), h = Math.round(bitmap.height * ratio);
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  c.getContext("2d").drawImage(bitmap, 0, 0, w, h);
  return new Promise(res => c.toBlob(res, "image/jpeg", q));
}
async function processFile(fileBlob, name, tripId) {
  let meta = null;
  try {
    meta = await exifr.parse(fileBlob, { gps: true, pick: [
      "DateTimeOriginal", "CreateDate", "ModifyDate",
      "GPSLatitude", "GPSLongitude", "GPSLatitudeRef", "GPSLongitudeRef"
    ]});
  } catch (e) { console.warn("EXIF parse failed for", name, e); }
  const lat = meta && typeof meta.latitude === "number" ? meta.latitude : null;
  const lng = meta && typeof meta.longitude === "number" ? meta.longitude : null;
  const d = meta && (meta.DateTimeOriginal || meta.CreateDate || meta.ModifyDate);
  const ts = d instanceof Date && !isNaN(d) ? d.getTime() : null;

  let blob = fileBlob, thumb = null, w = 0, h = 0;
  try {
    const bmp = await decodeBitmap(fileBlob);
    w = bmp.width; h = bmp.height;
    blob = await scaleToBlob(bmp, MAX_DIM, JPEG_Q);
    thumb = await scaleToBlob(bmp, THUMB_DIM, 0.8);
    bmp.close && bmp.close();
  } catch (e) {
    console.warn("Could not decode image (HEIC?)", name, e);
  }
  const photo = { id: uid(), tripId, name: name || "photo", ts, lat, lng, w, h, blob, thumb };
  await idb.put("photos", photo);
  return photo;
}

/* ---------------- state ---------------- */
let trips = [], currentTripId = null, photos = [];   // photos = current trip, sorted
let map, markerLayer, routeLine, markersById = {};
const objUrls = new Map(); // photoId -> object URL (thumbs)
let viewerMode = null; // { id, pass, name } when viewing a shared trip

function thumbUrl(p) {
  if (objUrls.has(p.id)) return objUrls.get(p.id);
  const b = p.thumb || p.blob;
  if (!b) return "";
  const u = URL.createObjectURL(b);
  objUrls.set(p.id, u);
  return u;
}
function sortPhotos(list) {
  return list.slice().sort((a, b) => (a.ts ?? Infinity) - (b.ts ?? Infinity));
}

/* ---------------- map ---------------- */
function initMap() {
  map = L.map("map", { zoomControl: false }).setView([48.8, 16.6], 5);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(map);
  markerLayer = L.layerGroup().addTo(map);
}
function renderMap() {
  markerLayer.clearLayers(); markersById = {};
  if (routeLine) { routeLine.remove(); routeLine = null; }
  const located = photos.filter(p => p.lat != null && p.lng != null);
  if (!located.length) return;

  const pts = [];
  for (const p of located) {
    pts.push([p.lat, p.lng]);
    const icon = L.divIcon({
      className: "", iconSize: [44, 44], iconAnchor: [22, 40], popupAnchor: [0, -40],
      html: `<div class="photo-marker" style="background-image:url('${thumbUrl(p)}')"></div>`
    });
    const m = L.marker([p.lat, p.lng], { icon }).addTo(markerLayer);
    m.bindPopup(() => {
      const div = document.createElement("div");
      const img = document.createElement("img");
      img.className = "popup-img"; img.src = thumbUrl(p);
      img.onclick = () => openPhotoView(p);
      const cap = document.createElement("div");
      cap.className = "popup-cap"; cap.textContent = fmtDate(p.ts);
      div.append(img, cap);
      return div;
    });
    m.on("popupopen", () => setActiveThumb(p.id));
    markersById[p.id] = m;
  }
  routeLine = L.polyline(pts, { color: "#0e7490", weight: 3.5, opacity: .85, dashArray: "8 7" }).addTo(map);
  map.fitBounds(routeLine.getBounds(), { padding: [50, 50], maxZoom: 14 });
}
function setActiveThumb(id) {
  document.querySelectorAll("#strip .thumb").forEach(el =>
    el.classList.toggle("active", el.dataset.id === id));
}

/* ---------------- strip + empty state ---------------- */
function renderStrip() {
  const strip = $("strip"); strip.innerHTML = "";
  for (const p of photos) {
    const img = document.createElement("img");
    img.className = "thumb" + (p.lat == null ? " nogps" : "");
    img.dataset.id = p.id; img.src = thumbUrl(p); img.loading = "lazy";
    img.title = p.lat == null ? "No location in this photo" : fmtDate(p.ts);
    img.onclick = () => {
      if (p.lat != null && markersById[p.id]) {
        map.setView([p.lat, p.lng], Math.max(map.getZoom(), 12));
        markersById[p.id].openPopup();
      } else openPhotoView(p);
    };
    strip.appendChild(img);
  }
  $("empty").classList.toggle("hidden", photos.length > 0);
}
function renderAll() { renderMap(); renderStrip(); }

/* ---------------- trips ---------------- */
async function loadTrips() {
  trips = (await idb.all("trips")).sort((a, b) => b.createdAt - a.createdAt);
  currentTripId = await kvGet("currentTripId");
  if (!trips.find(t => t.id === currentTripId)) currentTripId = trips[0]?.id ?? null;
  renderTripSelect();
}
function renderTripSelect() {
  const sel = $("tripSelect"); sel.innerHTML = "";
  if (!trips.length) {
    const o = document.createElement("option");
    o.textContent = "No trip — tap ☰"; sel.appendChild(o);
    return;
  }
  for (const t of trips) {
    const o = document.createElement("option");
    o.value = t.id; o.textContent = t.name; sel.appendChild(o);
  }
  sel.value = currentTripId;
}
async function switchTrip(id) {
  currentTripId = id; await kvSet("currentTripId", id);
  await loadPhotos(); renderTripSelect(); renderAll();
}
async function loadPhotos() {
  for (const u of objUrls.values()) URL.revokeObjectURL(u);
  objUrls.clear();
  photos = currentTripId ? sortPhotos(await idb.byIndex("photos", "tripId", currentTripId)) : [];
}
async function createTrip(name) {
  const t = { id: uid(), name, createdAt: Date.now(), published: null };
  await idb.put("trips", t); trips.unshift(t);
  await switchTrip(t.id);
  return t;
}
async function ensureTrip() {
  if (currentTripId) return currentTripId;
  const t = await createTrip("My trip");
  return t.id;
}
async function deleteTrip(t) {
  if (!confirm(`Delete trip “${t.name}” and its photos from this device?`)) return;
  const ps = await idb.byIndex("photos", "tripId", t.id);
  for (const p of ps) await idb.del("photos", p.id);
  await idb.del("trips", t.id);
  trips = trips.filter(x => x.id !== t.id);
  if (currentTripId === t.id) { currentTripId = trips[0]?.id ?? null; await kvSet("currentTripId", currentTripId); }
  await loadPhotos(); renderTripSelect(); renderAll(); renderTripList();
}
function renderTripList() {
  const box = $("tripList"); box.innerHTML = "";
  if (!trips.length) box.innerHTML = '<p>No trips yet — create your first one.</p>';
  for (const t of trips) {
    const row = document.createElement("div"); row.className = "trip-row";
    const nm = document.createElement("span");
    nm.textContent = t.name + (t.published ? " ↗" : "");
    const open = document.createElement("button"); open.className = "btn btn-primary"; open.textContent = "Open";
    open.onclick = async () => { await switchTrip(t.id); $("dlgTrips").close(); };
    const ren = document.createElement("button"); ren.className = "btn btn-ghost"; ren.textContent = "Rename";
    ren.onclick = () => promptName("Rename trip", t.name, async name => {
      t.name = name; await idb.put("trips", t); renderTripSelect(); renderTripList();
      markDirtyAndSync(t.id);
    });
    const del = document.createElement("button"); del.className = "btn btn-warn"; del.textContent = "✕";
    del.onclick = () => deleteTrip(t);
    row.append(nm, open, ren, del); box.appendChild(row);
  }
}
function promptName(title, initial, cb) {
  $("dlgNameTitle").textContent = title;
  const inp = $("tripNameInput"); inp.value = initial || "";
  const dlg = $("dlgName"); dlg.showModal(); inp.focus();
  $("btnNameOk").onclick = () => {
    const v = inp.value.trim(); if (!v) return;
    dlg.close(); cb(v);
  };
  $("btnNameCancel").onclick = () => dlg.close();
}

/* ---------------- import ---------------- */
async function importFiles(files) {
  if (!files.length) return;
  const tripId = await ensureTrip();
  let ok = 0, noGps = 0;
  for (let i = 0; i < files.length; i++) {
    busy(`Adding photo ${i + 1} / ${files.length}…`);
    try {
      const p = await processFile(files[i], files[i].name, tripId);
      ok++; if (p.lat == null) noGps++;
    } catch (e) { console.error(e); }
  }
  busy(false);
  await loadPhotos(); renderAll();
  toast(noGps ? `Added ${ok} photos (${noGps} without location — shown in the strip only)` : `Added ${ok} photos`);
  markDirtyAndSync(tripId);
}
async function drainInbox() {
  const items = await idb.all("inbox");
  if (!items.length) return;
  const tripId = await ensureTrip();
  let ok = 0, noGps = 0;
  for (let i = 0; i < items.length; i++) {
    busy(`Importing shared photo ${i + 1} / ${items.length}…`);
    try {
      const p = await processFile(items[i].blob, items[i].name, tripId);
      ok++; if (p.lat == null) noGps++;
    } catch (e) { console.error(e); }
    await idb.del("inbox", items[i].id);
  }
  busy(false);
  await loadPhotos(); renderAll();
  const tripName = trips.find(t => t.id === tripId)?.name || "trip";
  toast(`Added ${ok} shared photos to “${tripName}”` + (noGps ? ` — ${noGps} had no location` : ""));
  markDirtyAndSync(tripId);
}

/* ---------------- fullscreen photo ---------------- */
let photoViewCurrent = null, photoViewUrl = null;
async function openPhotoView(p) {
  // in viewer mode the full-size photo is fetched lazily, on first open
  if (viewerMode && !p.blob) {
    busy("Loading photo…");
    try {
      const r = await fetch(`/api/trips/${viewerMode.id}/photos/${p.id}`, {
        headers: { "x-trip-key": viewerMode.pass },
      });
      if (r.ok) p.blob = await r.blob();
    } catch (e) { console.warn(e); }
    busy(false);
  }
  if (!p.blob && !p.thumb) { toast("Could not load this photo"); return; }
  photoViewCurrent = p;
  if (photoViewUrl) URL.revokeObjectURL(photoViewUrl);
  photoViewUrl = URL.createObjectURL(p.blob || p.thumb);
  $("photoViewImg").src = photoViewUrl;
  $("photoViewCap").textContent = fmtDate(p.ts) + (p.lat == null ? " · no location" : "");
  $("btnPhotoDelete").style.display = viewerMode ? "none" : "";
  $("photoView").classList.add("open");
}
function closePhotoView() {
  $("photoView").classList.remove("open");
  if (photoViewUrl) { URL.revokeObjectURL(photoViewUrl); photoViewUrl = null; }
}

/* ---------------- publish / share ---------------- */
async function publishTrip(pass) {
  const trip = trips.find(t => t.id === currentTripId);
  if (!trip) return;
  const list = photos;
  if (!list.length) { toast("Add some photos first"); return; }
  try {
    busy("Publishing trip…");
    const metaRes = await fetch("/api/trips", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tripId: trip.published?.id || null,
        password: pass,
        name: trip.name,
        photos: list.map(p => ({ id: p.id, name: p.name, ts: p.ts, lat: p.lat, lng: p.lng })),
      }),
    });
    if (metaRes.status === 401) { busy(false); toast("Wrong password for the already-published trip"); return; }
    if (!metaRes.ok) throw new Error("publish failed: " + metaRes.status);
    const { id } = await metaRes.json();
    for (let i = 0; i < list.length; i++) {
      busy(`Uploading photo ${i + 1} / ${list.length}…`);
      const p = list[i];
      if (!(await uploadPhotoPair(id, pass, p))) throw new Error("photo upload failed");
    }
    trip.published = { id, password: pass, uploadedIds: list.map(p => p.id), dirty: false, thumbsDone: true };
    await idb.put("trips", trip);
    busy(false);
    const link = `${location.origin}/#/trip/${id}`;
    $("shareForm").style.display = "none";
    $("shareResult").style.display = "block";
    $("shareLink").textContent = link;
    $("btnCopyLink").onclick = async () => {
      try { await navigator.clipboard.writeText(link); toast("Link copied"); } catch { }
      if (navigator.share) navigator.share({ title: trip.name, text: `Our trip “${trip.name}” — password: ask me 😉`, url: link }).catch(() => { });
    };
  } catch (e) {
    console.error(e); busy(false);
    toast("Publishing failed — is the site deployed on Netlify with the function?");
  }
}

/* ---------------- live sync of published trips ----------------
   Once a trip is published, later changes (added/removed photos, rename)
   are pushed to the shared copy automatically. If offline, the trip is
   marked dirty and synced next time the app is opened/visible. */
let syncInFlight = false;
/* uploads thumbnail + full image for one photo; returns false on failure */
async function uploadPhotoPair(pubId, pass, p) {
  const headers = { "x-trip-key": pass, "content-type": "image/jpeg" };
  try {
    if (p.thumb) {
      const tr = await fetch(`/api/trips/${pubId}/thumbs/${p.id}`, { method: "PUT", headers, body: p.thumb });
      if (!tr.ok) return false;
    }
    const b = p.blob || p.thumb;
    if (!b) return true; // nothing decodable to upload; meta only
    const r = await fetch(`/api/trips/${pubId}/photos/${p.id}`, { method: "PUT", headers, body: b });
    return r.ok;
  } catch { return false; }
}
async function markDirtyAndSync(tripId) {
  const trip = trips.find(t => t.id === tripId);
  if (!trip?.published) return;
  trip.published.dirty = true;
  await idb.put("trips", trip);
  syncPublishedTrip(trip);
}
async function syncPublishedTrip(trip) {
  if (!trip?.published || syncInFlight) return;
  syncInFlight = true;
  const pub = trip.published;
  try {
    const list = sortPhotos(await idb.byIndex("photos", "tripId", trip.id));
    const r = await fetch("/api/trips", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tripId: pub.id,
        password: pub.password,
        name: trip.name,
        photos: list.map(p => ({ id: p.id, name: p.name, ts: p.ts, lat: p.lat, lng: p.lng })),
      }),
    });
    if (!r.ok) throw new Error("meta sync failed " + r.status);
    const uploaded = new Set(pub.uploadedIds || []);
    for (const p of list) {
      if (uploaded.has(p.id)) continue;
      if (!(await uploadPhotoPair(pub.id, pub.password, p))) throw new Error("photo sync failed");
      uploaded.add(p.id);
      pub.uploadedIds = [...uploaded];
      await idb.put("trips", trip);
    }
    // one-time backfill of thumbnails for trips published before thumbs existed
    if (!pub.thumbsDone) {
      for (const p of list) {
        if (!p.thumb) continue;
        await fetch(`/api/trips/${pub.id}/thumbs/${p.id}`, {
          method: "PUT", headers: { "x-trip-key": pub.password, "content-type": "image/jpeg" }, body: p.thumb,
        });
      }
      pub.thumbsDone = true;
      await idb.put("trips", trip);
    }
    pub.uploadedIds = pub.uploadedIds ? pub.uploadedIds.filter(id => list.some(p => p.id === id)) : [];
    pub.dirty = false;
    await idb.put("trips", trip);
    toast("Shared link updated");
  } catch (e) {
    console.warn("sync postponed:", e.message);
    pub.dirty = true;
    await idb.put("trips", trip);
  } finally {
    syncInFlight = false;
  }
}
async function syncAllDirty() {
  for (const t of trips) {
    if (t.published && (t.published.dirty || !t.published.thumbsDone)) await syncPublishedTrip(t);
  }
}

/* ---------------- shared-trip viewer mode ---------------- */
function parseViewerHash() {
  const m = location.hash.match(/^#\/trip\/([A-Za-z0-9_-]+)$/);
  return m ? m[1] : null;
}
async function startViewer(tripId) {
  document.body.classList.add("viewer");
  $("tripSelect").classList.add("hidden");
  $("btnTrips").classList.add("hidden");
  $("btnAdd").classList.add("hidden");
  $("btnShare").classList.add("hidden");
  $("viewerTitle").style.display = "block";
  $("viewerTitle").textContent = "Shared trip";
  $("emptyHint").innerHTML = "Enter the password to view this shared trip.";

  const dlg = $("dlgPass");
  const tryOpen = async () => {
    const pass = $("viewPass").value;
    if (!pass) return;
    busy("Loading trip…");
    try {
      const r = await fetch(`/api/trips/${tripId}`, { headers: { "x-trip-key": pass } });
      if (r.status === 401) { busy(false); toast("Wrong password"); dlg.showModal(); return; }
      if (!r.ok) throw new Error("load failed " + r.status);
      const data = await r.json();
      viewerMode = { id: tripId, pass, name: data.name };
      $("viewerTitle").textContent = data.name;
      document.title = data.name + " — Roadtrip Map";
      // fetch only small thumbnails up front (auth header ⇒ can't use plain
      // <img src>); the full-size photo is downloaded on demand when opened
      const ps = [];
      const metas = sortPhotos(data.photos || []);
      for (let i = 0; i < metas.length; i++) {
        busy(`Loading thumbnails ${i + 1} / ${metas.length}…`);
        const pm = metas[i];
        let thumb = null;
        try {
          let pr = await fetch(`/api/trips/${tripId}/thumbs/${pm.id}`, { headers: { "x-trip-key": pass } });
          if (pr.status === 404) // trip published before thumbnails existed
            pr = await fetch(`/api/trips/${tripId}/photos/${pm.id}`, { headers: { "x-trip-key": pass } });
          if (pr.ok) thumb = await pr.blob();
        } catch (e) { console.warn(e); }
        ps.push({ ...pm, thumb, blob: null, tripId });
      }
      photos = sortPhotos(ps);
      busy(false);
      renderAll();
      if (!photos.length) toast("This trip has no photos yet");
    } catch (e) {
      console.error(e); busy(false);
      toast("Could not load this trip");
      dlg.showModal();
    }
  };
  $("btnPassOk").onclick = () => { dlg.close(); tryOpen(); };
  $("viewPass").onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); dlg.close(); tryOpen(); } };
  dlg.showModal();
}

/* ---------------- wiring ---------------- */
async function main() {
  initMap();

  const viewerTripId = parseViewerHash();
  if (viewerTripId) { await startViewer(viewerTripId); return; }

  // owner mode
  if (navigator.storage?.persist) navigator.storage.persist();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(console.warn);

  await loadTrips();
  await loadPhotos();
  renderAll();
  await drainInbox();
  syncAllDirty();

  $("tripSelect").onchange = e => switchTrip(e.target.value);
  $("btnAdd").onclick = () => $("filePick").click();
  $("filePick").onchange = e => { importFiles([...e.target.files]); e.target.value = ""; };
  $("btnTrips").onclick = () => { renderTripList(); $("dlgTrips").showModal(); };
  $("btnTripsClose").onclick = () => $("dlgTrips").close();
  $("btnNewTrip").onclick = () => {
    $("dlgTrips").close();
    promptName("New trip", "", name => createTrip(name));
  };
  $("btnShare").onclick = () => {
    if (!currentTripId || !photos.length) { toast("Add some photos to a trip first"); return; }
    const trip = trips.find(t => t.id === currentTripId);
    $("shareForm").style.display = "block";
    $("shareResult").style.display = "none";
    $("sharePass").value = trip.published?.password || "";
    $("dlgShare").showModal();
  };
  $("btnShareCancel").onclick = () => $("dlgShare").close();
  $("btnShareClose").onclick = () => $("dlgShare").close();
  $("btnSharePublish").onclick = () => {
    const pass = $("sharePass").value;
    if (pass.length < 4) { toast("Password must be at least 4 characters"); return; }
    publishTrip(pass);
  };
  $("btnPhotoClose").onclick = closePhotoView;
  $("btnPhotoDelete").onclick = async () => {
    if (!photoViewCurrent || viewerMode) return;
    await idb.del("photos", photoViewCurrent.id);
    closePhotoView();
    await loadPhotos(); renderAll();
    toast("Photo removed");
    markDirtyAndSync(currentTripId);
  };
  // re-check inbox when returning to the app (e.g. right after sharing photos)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") { drainInbox(); syncAllDirty(); }
  });
  window.addEventListener("online", () => syncAllDirty());
  navigator.serviceWorker?.addEventListener("message", ev => {
    if (ev.data === "inbox-updated") drainInbox();
  });
}

main().catch(e => { console.error(e); toast("Something went wrong starting the app"); });
