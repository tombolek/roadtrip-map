/* Roadtrip Map — app logic. Local-first: everything lives in IndexedDB on this
   device. Publishing uploads a copy to S3 (presigned direct upload); viewers
   authenticate once (/api/auth) and load images straight from CloudFront. */
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
  // require FINITE numbers — some photos have partial GPS EXIF that parses to
  // NaN, which is typeof "number" but would break the map; treat as no-location
  let lat = meta && Number.isFinite(meta.latitude) ? meta.latitude : null;
  let lng = meta && Number.isFinite(meta.longitude) ? meta.longitude : null;
  if (lat === null || lng === null) { lat = null; lng = null; }
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
  const photo = { id: uid(), tripId, name: name || "photo", ts, lat, lng, w, h, blob, thumb, uploadedBy: account?.initials || "" };
  await idb.put("photos", photo);
  return photo;
}

/* ---------------- state ---------------- */
let trips = [], currentTripId = null, photos = [];   // photos = current trip, sorted
let map, markerLayer, routeLine, trackLine, markersById = {};
const objUrls = new Map(); // photoId -> object URL (thumbs)
let viewerMode = null; // { id, pass, name } when viewing a shared trip
let account = null;    // { username, initials, name } when logged in as owner

function thumbUrl(p) {
  // viewer mode: thumbnails come straight from CloudFront (signed cookie set)
  if (p.thumbSrc) return p.thumbSrc;
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
// a photo is "located" only with two finite coordinates (guards against NaN
// from partial GPS EXIF, and against legacy NaN values already in storage)
function hasGeo(p) { return Number.isFinite(p.lat) && Number.isFinite(p.lng); }

/* ---------------- Google Timeline import (real route) ---------------- */
function parseGeoString(s) {
  if (s && typeof s === "object") s = s.latLng || s.latlng || s;   // some formats nest it
  if (typeof s !== "string") return null;
  let m = s.match(/(-?\d+\.\d+)\s*°?\s*,\s*(-?\d+\.\d+)\s*°?/); // "geo:lat,lng" or "lat°, lng°"
  if (!m) return null;
  const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
  return (Number.isFinite(lat) && Number.isFinite(lng)) ? [lat, lng] : null;
}
// pull {lat,lng,t} points out of the various Google Timeline export shapes
function extractTrack(json) {
  const pts = [];
  const push = (g, t) => { if (g) pts.push({ lat: g[0], lng: g[1], t: t || 0 }); };
  // Format 1 — Takeout Records.json / Location History
  if (json && Array.isArray(json.locations)) {
    for (const l of json.locations) {
      let lat = null, lng = null;
      if (Number.isFinite(l.latitudeE7)) { lat = l.latitudeE7 / 1e7; lng = l.longitudeE7 / 1e7; }
      else if (Number.isFinite(l.latitude)) { lat = l.latitude; lng = l.longitude; }
      const t = l.timestamp ? Date.parse(l.timestamp) : (l.timestampMs ? +l.timestampMs : 0);
      if (Number.isFinite(lat) && Number.isFinite(lng)) pts.push({ lat, lng, t: t || 0 });
    }
  }
  // Format 2 — on-device semantic export (array, or {semanticSegments:[...]})
  const segs = Array.isArray(json) ? json : (json && Array.isArray(json.semanticSegments) ? json.semanticSegments : null);
  if (segs) {
    for (const s of segs) {
      const t = s.startTime ? Date.parse(s.startTime) : 0;
      if (Array.isArray(s.timelinePath)) for (const p of s.timelinePath) push(parseGeoString(p.point), t);
      if (s.activity) { push(parseGeoString(s.activity.start), t); push(parseGeoString(s.activity.end), t); }
      if (s.visit && s.visit.topCandidate) push(parseGeoString(s.visit.topCandidate.placeLocation), t);
    }
  }
  return pts;
}
async function importTimelineFile(file) {
  const trip = currentTrip();
  if (!trip) { toast("Create or open a trip first"); return; }
  busy("Reading timeline…");
  let json;
  try { json = JSON.parse(await file.text()); }
  catch { busy(false); toast("That doesn't look like a JSON export"); return; }
  let raw = extractTrack(json);
  if (!raw.length) { busy(false); toast("No location points found in that file"); return; }
  raw.sort((a, b) => (a.t || 0) - (b.t || 0));
  // clip to the trip's photo date range (±1 day) when both have timestamps
  const photoTs = photos.map(p => p.ts).filter(Boolean);
  if (photoTs.length && raw.some(p => p.t > 0)) {
    const lo = Math.min(...photoTs) - 864e5, hi = Math.max(...photoTs) + 864e5;
    const clipped = raw.filter(p => p.t >= lo && p.t <= hi);
    if (clipped.length >= 2) raw = clipped;
  }
  // downsample so the stored/synced route stays small
  const MAXP = 800;
  let coords = raw.map(p => [p.lat, p.lng]);
  if (coords.length > MAXP) { const step = Math.ceil(coords.length / MAXP); coords = coords.filter((_, i) => i % step === 0); }
  trip.track = coords;
  await idb.put("trips", trip);
  busy(false);
  $("dlgTrips").close();
  setView("map");
  renderAll();
  markDirtyAndSync(currentTripId);
  toast(`Imported route (${coords.length} points)`);
}
async function clearTimeline() {
  const trip = currentTrip();
  if (!trip || !trip.track?.length) { toast("No route to clear"); return; }
  trip.track = [];
  await idb.put("trips", trip);
  renderTripList(); updateRouteStatus(); renderAll(); markDirtyAndSync(currentTripId);
  toast("Route cleared");
}
function tripTrack() {
  return viewerMode ? viewerTrack : (currentTrip()?.track || []);
}
function updateRouteStatus() {
  const el = $("routeStatus"); if (!el) return;
  const n = currentTrip()?.track?.length || 0;
  el.textContent = n ? `· ${n} points imported` : "· none yet";
}

/* ---------------- map ---------------- */
function initMap() {
  map = L.map("map", { zoomControl: false }).setView([48.8, 16.6], 5);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(map);
  markerLayer = L.layerGroup().addTo(map);
  map.on("click", onMapClick);
}

/* ---- manually place a photo without (or with wrong) GPS ---- */
let placingPhotoId = null;
function startPlacing(p) {
  if (viewerMode || !p) return;
  placingPhotoId = p.id;
  closePhotoView();
  setView("map");
  $("placeBanner").classList.remove("hidden");
  $("placeBannerText").textContent = `Tap the map to place this photo`;
}
function stopPlacing() { placingPhotoId = null; $("placeBanner").classList.add("hidden"); }
async function onMapClick(e) {
  if (!placingPhotoId) return;
  const p = photos.find(x => x.id === placingPhotoId) || await idb.get("photos", placingPhotoId);
  stopPlacing();
  if (!p) return;
  p.lat = e.latlng.lat; p.lng = e.latlng.lng;
  await idb.put("photos", p);
  await loadPhotos(); renderAll();
  markDirtyAndSync(currentTripId);
  if (markersById[p.id]) markersById[p.id].openPopup();
  toast("Location set");
}
function renderMap() {
  markerLayer.clearLayers(); markersById = {};
  if (routeLine) { routeLine.remove(); routeLine = null; }
  if (trackLine) { trackLine.remove(); trackLine = null; }
  const located = photos.filter(hasGeo);
  const track = tripTrack();
  if (!located.length && track.length < 2) return;

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
  if (track.length >= 2) {
    // real driven route from Google Timeline — solid line, replaces the
    // straight-line connector; markers still sit on top
    trackLine = L.polyline(track, { color: "#0e7490", weight: 4, opacity: .8 }).addTo(map);
  } else if (pts.length >= 2) {
    routeLine = L.polyline(pts, { color: "#0e7490", weight: 3.5, opacity: .85, dashArray: "8 7" }).addTo(map);
  }
  const all = pts.concat(track);
  if (all.length) map.fitBounds(L.latLngBounds(all), { padding: [50, 50], maxZoom: 14 });
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
    img.className = "thumb" + (hasGeo(p) ? "" : " nogps");
    img.dataset.id = p.id; img.src = thumbUrl(p); img.loading = "lazy";
    img.title = hasGeo(p) ? fmtDate(p.ts) : "No location in this photo";
    img.onclick = () => {
      if (hasGeo(p) && markersById[p.id]) {
        map.setView([p.lat, p.lng], Math.max(map.getZoom(), 12));
        markersById[p.id].openPopup();
      } else openPhotoView(p);
    };
    strip.appendChild(img);
  }
  $("empty").classList.toggle("hidden", photos.length > 0);
}
function renderAll() { renderMap(); renderStrip(); if (currentView === "gallery") renderGallery(); }

/* ---------------- gallery / timeline view ---------------- */
let currentView = "map"; // "map" | "gallery"
let selectMode = false;                 // owner batch-select in gallery
const selectedIds = new Set();
let viewerDayNotes = {};                 // day notes when viewing a shared trip
let viewerTrack = [];                     // real route [[lat,lng]...] when viewing a shared trip

function currentTrip() { return trips.find(t => t.id === currentTripId); }
function getDayNote(key) {
  if (viewerMode) return viewerDayNotes[key] || "";
  return (currentTrip()?.dayNotes || {})[key] || "";
}
async function setDayNote(key, text) {
  const trip = currentTrip(); if (!trip) return;
  trip.dayNotes = trip.dayNotes || {};
  const v = (text || "").trim();
  if (v) trip.dayNotes[key] = v; else delete trip.dayNotes[key];
  await idb.put("trips", trip);
  markDirtyAndSync(currentTripId);
}
function dayLabel(ts) {
  if (!ts) return "Undated";
  return new Date(ts).toLocaleDateString(undefined,
    { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}
function dayKey(ts) {
  if (!ts) return "zzz-undated"; // sorts last
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function fillDayNote(wrap, key) {
  wrap.innerHTML = "";
  const note = getDayNote(key);
  if (viewerMode) {
    if (note) { const d = document.createElement("div"); d.className = "gal-note-text"; d.textContent = note; wrap.appendChild(d); }
    return;
  }
  if (note) {
    const d = document.createElement("div"); d.className = "gal-note-text"; d.textContent = note;
    d.title = "Tap to edit"; d.onclick = () => editDayNote(wrap, key);
    wrap.appendChild(d);
  } else {
    const add = document.createElement("button"); add.className = "gal-note-add"; add.textContent = "+ Add day note";
    add.onclick = () => editDayNote(wrap, key);
    wrap.appendChild(add);
  }
}
function editDayNote(wrap, key) {
  wrap.innerHTML = "";
  const ta = document.createElement("textarea"); ta.rows = 2; ta.maxLength = 500;
  ta.value = getDayNote(key); ta.placeholder = "Add a note for this day…";
  ta.addEventListener("blur", async () => { await setDayNote(key, ta.value); fillDayNote(wrap, key); });
  wrap.appendChild(ta); ta.focus();
}
function renderCell(p) {
  const cell = document.createElement("div");
  cell.className = "gal-cell" + (hasGeo(p) ? "" : " nogps") + (selectedIds.has(p.id) ? " sel" : "");
  cell.title = hasGeo(p) ? fmtDate(p.ts) : "No location in this photo";
  const img = document.createElement("img");
  img.src = thumbUrl(p); img.loading = "lazy"; img.alt = p.name || "photo";
  cell.appendChild(img);
  if (p.caption) { const c = document.createElement("div"); c.className = "cap"; c.textContent = p.caption; cell.appendChild(c); }
  if (p.uploadedBy) { const bd = document.createElement("div"); bd.className = "up-badge"; bd.textContent = p.uploadedBy; cell.appendChild(bd); }
  const chk = document.createElement("div"); chk.className = "chk"; chk.textContent = selectedIds.has(p.id) ? "✓" : "";
  cell.appendChild(chk);
  cell.onclick = () => {
    if (selectMode) {
      if (selectedIds.has(p.id)) selectedIds.delete(p.id); else selectedIds.add(p.id);
      cell.classList.toggle("sel"); chk.textContent = selectedIds.has(p.id) ? "✓" : "";
      const cnt = document.querySelector(".gal-toolbar .spacer");
      if (cnt) cnt.textContent = `${selectedIds.size} selected`;
      const del = document.querySelector(".gal-toolbar .btn-warn");
      if (del) del.disabled = selectedIds.size === 0;
    } else openPhotoView(p);
  };
  return cell;
}
async function deleteSelected() {
  if (!selectedIds.size) return;
  const n = selectedIds.size;
  if (!confirm(`Delete ${n} photo${n > 1 ? "s" : ""} from this trip?`)) return;
  for (const pid of selectedIds) await idb.del("photos", pid);
  selectMode = false; selectedIds.clear();
  await loadPhotos(); renderAll();
  markDirtyAndSync(currentTripId);
  toast(`Deleted ${n} photo${n > 1 ? "s" : ""}`);
}
function renderGallery() {
  const g = $("gallery");
  g.innerHTML = "";
  g.classList.toggle("selecting", selectMode);

  // owner toolbar: Select / (Cancel · count · Delete)
  if (!viewerMode) {
    const tb = document.createElement("div"); tb.className = "gal-toolbar";
    if (!selectMode) {
      const spacer = document.createElement("div"); spacer.className = "spacer";
      const sel = document.createElement("button"); sel.className = "btn btn-ghost"; sel.textContent = "Select";
      sel.onclick = () => { if (!photos.length) return; selectMode = true; selectedIds.clear(); renderGallery(); };
      tb.append(spacer, sel);
    } else {
      const cancel = document.createElement("button"); cancel.className = "btn btn-ghost"; cancel.textContent = "Cancel";
      cancel.onclick = () => { selectMode = false; selectedIds.clear(); renderGallery(); };
      const count = document.createElement("div"); count.className = "spacer"; count.textContent = `${selectedIds.size} selected`;
      const del = document.createElement("button"); del.className = "btn btn-warn"; del.textContent = "Delete";
      del.disabled = selectedIds.size === 0; del.onclick = deleteSelected;
      tb.append(cancel, count, del);
    }
    g.appendChild(tb);
  }

  if (!photos.length) {
    g.insertAdjacentHTML("beforeend", '<div class="gal-empty">No photos yet.</div>');
    return;
  }
  // photos are already sorted ascending by time; group consecutively by day
  let curKey = null, grid = null;
  for (const p of photos) {
    const k = dayKey(p.ts);
    if (k !== curKey) {
      curKey = k;
      const day = document.createElement("div"); day.className = "gal-day";
      const h = document.createElement("h3"); h.textContent = dayLabel(p.ts);
      const note = document.createElement("div"); note.className = "gal-note"; fillDayNote(note, k);
      grid = document.createElement("div"); grid.className = "gal-grid";
      day.append(h, note, grid);
      g.appendChild(day);
    }
    grid.appendChild(renderCell(p));
  }
}
function setView(view) {
  currentView = view;
  if (view !== "gallery" && selectMode) { selectMode = false; selectedIds.clear(); }
  const gallery = view === "gallery";
  $("gallery").classList.toggle("hidden", !gallery);
  $("strip").style.display = gallery ? "none" : "";
  $("tabMap").classList.toggle("active", !gallery);
  $("tabGallery").classList.toggle("active", gallery);
  if (gallery) renderGallery();
  else if (map) setTimeout(() => map.invalidateSize(), 0); // map was covered; refresh tiles
}

/* ---------------- trips ---------------- */
// Cloud-first: the trip list comes from the server. IndexedDB is just a working
// cache. Trips are keyed locally by their cloud id (local id === cloud id).
async function loadTrips() {
  let cloud = [];
  try {
    const r = await fetch("/api/trips", { credentials: "same-origin" });
    if (r.ok) cloud = (await r.json()).trips || [];
  } catch (e) { console.warn("trip list fetch failed", e); }
  const cloudIds = new Set(cloud.map(t => t.id));
  // clean start: drop any local trips (+photos) that aren't cloud-backed
  for (const lt of await idb.all("trips")) {
    if (!lt.published?.id || !cloudIds.has(lt.published.id)) {
      for (const p of await idb.byIndex("photos", "tripId", lt.id)) await idb.del("photos", p.id);
      await idb.del("trips", lt.id);
    }
  }
  const byId = new Map((await idb.all("trips")).map(t => [t.id, t]));
  for (const ct of cloud) {
    const lt = byId.get(ct.id) || { id: ct.id, published: { id: ct.id, uploadedIds: [], dirty: false, loaded: false }, dayNotes: {}, track: [] };
    lt.name = ct.name; lt.createdAt = ct.updatedAt || lt.createdAt || Date.now();
    lt.disabled = ct.disabled; lt.viewCount = ct.viewCount; lt.uniqueCount = ct.uniqueCount;
    lt.lastAccess = ct.lastAccess; lt.photoCount = ct.photoCount;
    await idb.put("trips", lt);
  }
  trips = (await idb.all("trips")).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  currentTripId = await kvGet("currentTripId");
  if (!trips.find(t => t.id === currentTripId)) currentTripId = trips[0]?.id ?? null;
  renderTripSelect();
}
// fetch a trip's full metadata (photos, notes, route) from the cloud on open
async function loadTripFromCloud(trip) {
  try {
    const r = await fetch("/api/auth", {
      method: "POST", headers: { "content-type": "application/json" },
      credentials: "same-origin", body: JSON.stringify({ tripId: trip.published.id }),
    });
    if (!r.ok) return;
    const data = await r.json();
    trip.name = data.name; trip.dayNotes = data.dayNotes || {}; trip.track = data.track || [];
    const serverIds = new Set((data.photos || []).map(p => p.id));
    const local = await idb.byIndex("photos", "tripId", trip.id);
    const localById = new Map(local.map(p => [p.id, p]));
    for (const lp of local) if (lp.remote && !serverIds.has(lp.id)) await idb.del("photos", lp.id);
    for (const pm of (data.photos || [])) {
      const ex = localById.get(pm.id);
      if (ex && !ex.remote) continue; // keep locally-added blobs
      await idb.put("photos", {
        id: pm.id, tripId: trip.id, name: pm.name, ts: pm.ts, lat: pm.lat, lng: pm.lng,
        caption: pm.caption || "", uploadedBy: pm.uploadedBy || "",
        thumbSrc: `/trips/${trip.published.id}/thumbs/${pm.id}`, fullSrc: `/trips/${trip.published.id}/photos/${pm.id}`, remote: true,
      });
    }
    trip.published.uploadedIds = [...serverIds];
    trip.published.loaded = true;
    await idb.put("trips", trip);
  } catch (e) { console.warn("trip load failed", e); }
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
  selectMode = false; selectedIds.clear();
  const trip = trips.find(t => t.id === id);
  if (trip?.published && !trip.published.loaded) { busy("Loading trip…"); await loadTripFromCloud(trip); busy(false); }
  await loadPhotos(); renderTripSelect(); renderAll();
}
async function loadPhotos() {
  for (const u of objUrls.values()) URL.revokeObjectURL(u);
  objUrls.clear();
  photos = currentTripId ? sortPhotos(await idb.byIndex("photos", "tripId", currentTripId)) : [];
}
async function createTrip(name) {
  busy("Creating trip…");
  try {
    const r = await fetch("/api/publish", {
      method: "POST", headers: { "content-type": "application/json" },
      credentials: "same-origin", body: JSON.stringify({ name, photos: [] }),
    });
    if (!r.ok) throw new Error("create failed " + r.status);
    const { id } = await r.json();
    const t = { id, name, createdAt: Date.now(), published: { id, uploadedIds: [], dirty: false, loaded: true }, dayNotes: {}, track: [] };
    await idb.put("trips", t); trips.unshift(t);
    busy(false);
    await switchTrip(id);
    return t;
  } catch (e) { console.error(e); busy(false); toast("Couldn't create trip — check your connection"); }
}
async function ensureTrip() {
  if (currentTripId) return currentTripId;
  const t = await createTrip("My trip");
  return t?.id;
}
async function deleteTrip(t) {
  if (!confirm(`Delete trip “${t.name}” for everyone? This removes it and its photos permanently.`)) return;
  busy("Deleting trip…");
  try {
    await fetch("/api/unpublish", {
      method: "POST", headers: { "content-type": "application/json" },
      credentials: "same-origin", body: JSON.stringify({ tripId: t.published?.id || t.id }),
    });
  } catch (e) { console.warn("remote delete failed", e); }
  for (const p of await idb.byIndex("photos", "tripId", t.id)) await idb.del("photos", p.id);
  await idb.del("trips", t.id);
  trips = trips.filter(x => x.id !== t.id);
  if (currentTripId === t.id) { currentTripId = trips[0]?.id ?? null; await kvSet("currentTripId", currentTripId); }
  busy(false);
  await loadPhotos(); renderTripSelect(); renderAll(); renderTripList();
  toast("Trip deleted");
}
function renderTripList() {
  const box = $("tripList"); box.innerHTML = "";
  if (!trips.length) box.innerHTML = '<p>No trips yet — create your first one.</p>';
  for (const t of trips) {
    const row = document.createElement("div"); row.className = "trip-row";
    const nm = document.createElement("span"); nm.textContent = t.name;
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
function looksLikeImage(f) {
  const t = (f.type || "").toLowerCase();
  const n = (f.name || "").toLowerCase();
  return t.startsWith("image/") || t === "" || t === "application/octet-stream" ||
    /\.(jpe?g|png|heic|heif|webp|gif|bmp|tiff?)$/.test(n);
}
async function importFiles(files) {
  files = files.filter(looksLikeImage);
  if (!files.length) { toast("No images selected"); return; }
  const tripId = await ensureTrip();
  let ok = 0, noGps = 0;
  for (let i = 0; i < files.length; i++) {
    busy(`Adding photo ${i + 1} / ${files.length}…`);
    try {
      const p = await processFile(files[i], files[i].name, tripId);
      ok++; if (!hasGeo(p)) noGps++;
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
      ok++; if (!hasGeo(p)) noGps++;
    } catch (e) { console.error(e); }
    await idb.del("inbox", items[i].id);
  }
  busy(false);
  await loadPhotos(); renderAll();
  const tripName = trips.find(t => t.id === tripId)?.name || "trip";
  toast(`Added ${ok} shared photos to “${tripName}”` + (noGps ? ` — ${noGps} had no location` : ""));
  markDirtyAndSync(tripId);
}

/* ---------------- fullscreen photo (swipeable) ---------------- */
let photoViewCurrent = null, photoViewUrl = null, photoViewIndex = 0;
function showPhotoAt(i) {
  if (i < 0 || i >= photos.length) return;
  photoViewIndex = i;
  const p = photos[i];
  photoViewCurrent = p;
  if (photoViewUrl) { URL.revokeObjectURL(photoViewUrl); photoViewUrl = null; }
  let src;
  if (p.fullSrc) src = p.fullSrc;                       // viewer: CloudFront URL
  else if (p.blob || p.thumb) { photoViewUrl = URL.createObjectURL(p.blob || p.thumb); src = photoViewUrl; }
  else { toast("Could not load this photo"); return; }
  $("photoViewImg").src = src;
  $("photoViewCap").textContent = fmtDate(p.ts) + (hasGeo(p) ? "" : " · no location") + (p.uploadedBy ? ` · added by ${p.uploadedBy}` : "");
  const cap = $("pvCaption");
  cap.value = p.caption || "";
  cap.readOnly = !!viewerMode;
  cap.placeholder = viewerMode ? "" : "Add a caption…";
  $("btnPhotoDelete").style.display = viewerMode ? "none" : "";
  $("btnPhotoLocate").textContent = hasGeo(p) ? "Move location" : "Set location";
  $("pvPrev").disabled = i <= 0;
  $("pvNext").disabled = i >= photos.length - 1;
  $("photoView").classList.add("open");
}
function openPhotoView(p) {
  const i = photos.findIndex(x => x.id === p.id);
  showPhotoAt(i >= 0 ? i : 0);
}
function closePhotoView() {
  $("photoView").classList.remove("open");
  if (photoViewUrl) { URL.revokeObjectURL(photoViewUrl); photoViewUrl = null; }
}
// wired once, works in both owner and viewer modes
function initPhotoViewControls() {
  $("btnPhotoClose").onclick = closePhotoView;
  $("pvPrev").onclick = () => showPhotoAt(photoViewIndex - 1);
  $("pvNext").onclick = () => showPhotoAt(photoViewIndex + 1);
  $("btnPhotoLocate").onclick = () => startPlacing(photoViewCurrent);
  $("placeCancel").onclick = stopPlacing;
  document.addEventListener("keydown", e => {
    if (!$("photoView").classList.contains("open")) return;
    if (e.key === "Escape") closePhotoView();
    else if (e.key === "ArrowLeft") showPhotoAt(photoViewIndex - 1);
    else if (e.key === "ArrowRight") showPhotoAt(photoViewIndex + 1);
  });
  // swipe left/right on the image stage
  const stage = $("pvStage");
  let sx = 0, sy = 0, tracking = false;
  stage.addEventListener("touchstart", e => {
    const t = e.changedTouches[0]; sx = t.clientX; sy = t.clientY; tracking = true;
  }, { passive: true });
  stage.addEventListener("touchend", e => {
    if (!tracking) return; tracking = false;
    const t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5)
      showPhotoAt(photoViewIndex + (dx < 0 ? 1 : -1));
  }, { passive: true });
  // caption editing (no-op in viewer mode)
  const cap = $("pvCaption");
  const saveCaption = async () => {
    if (viewerMode || !photoViewCurrent) return;
    const val = cap.value.trim();
    if ((photoViewCurrent.caption || "") === val) return;
    photoViewCurrent.caption = val;
    await idb.put("photos", photoViewCurrent);
    const idx = photos.findIndex(x => x.id === photoViewCurrent.id);
    if (idx >= 0) photos[idx].caption = val;
    if (currentView === "gallery") renderGallery();
    markDirtyAndSync(currentTripId);
  };
  cap.addEventListener("change", saveCaption);
  cap.addEventListener("blur", saveCaption);
}

/* ---------------- share (set the family view password) ---------------- */
async function publishTrip(viewPassword) {
  const trip = trips.find(t => t.id === currentTripId);
  if (!trip) return;
  const list = photos;
  try {
    busy("Setting up sharing…");
    const r = await fetch("/api/publish", {
      method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin",
      body: JSON.stringify({
        tripId: trip.published.id, viewPassword, name: trip.name,
        photos: list.map(p => ({ id: p.id, name: p.name, ts: p.ts, lat: p.lat, lng: p.lng, caption: p.caption || "", uploadedBy: p.uploadedBy || "" })),
        dayNotes: trip.dayNotes || {}, track: trip.track || [], need: [],
      }),
    });
    if (r.status === 401) { busy(false); toast("Please log in again"); return; }
    if (!r.ok) throw new Error("share failed: " + r.status);
    trip.viewPassword = viewPassword;
    await idb.put("trips", trip);
    busy(false);
    const viewLink = `${location.origin}/#/trip/${trip.published.id}`;
    $("shareForm").style.display = "none";
    $("shareResult").style.display = "block";
    $("shareLink").textContent = `${viewLink}   ·   password: ${viewPassword}`;
    $("btnCopyLink").onclick = async () => {
      try { await navigator.clipboard.writeText(`${viewLink}\nPassword: ${viewPassword}`); toast("View link copied"); } catch { }
      if (navigator.share) navigator.share({ title: trip.name, text: `Our trip “${trip.name}”`, url: viewLink }).catch(() => { });
    };
  } catch (e) {
    console.error(e); busy(false);
    toast("Couldn't set up sharing — try again");
  }
}

/* ---------------- live sync of published trips ----------------
   Once a trip is published, later changes (added/removed photos, rename)
   are pushed to the shared copy automatically. If offline, the trip is
   marked dirty and synced next time the app is opened/visible. */
let syncInFlight = false;
/* PUT a blob straight to S3 using a presigned URL (content-type must match
   what the Lambda signed the URL with — image/jpeg) */
async function putPresigned(url, blob) {
  try {
    const r = await fetch(url, { method: "PUT", headers: { "content-type": "image/jpeg" }, body: blob });
    return r.ok;
  } catch { return false; }
}
/* uploads thumbnail + full image for one photo via its presigned URL pair */
async function uploadPair(entry, p) {
  if (!entry) return true;
  if (p.thumb && entry.thumb && !(await putPresigned(entry.thumb, p.thumb))) return false;
  const full = p.blob || p.thumb;
  if (full && entry.photo && !(await putPresigned(entry.photo, full))) return false;
  return true;
}
/* upload many photos in parallel (bounded concurrency) with progress */
async function uploadAllPairs(list, uploads, onProgress) {
  const CONC = 5;
  const queue = list.filter(p => uploads[p.id]);
  let done = 0, ok = true, i = 0;
  async function worker() {
    while (i < queue.length) {
      const p = queue[i++];
      if (!(await uploadPair(uploads[p.id], p))) ok = false;
      onProgress && onProgress(++done);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, queue.length) }, worker));
  return ok;
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
    const uploaded = new Set(pub.uploadedIds || []);
    const need = list.filter(p => !uploaded.has(p.id)).map(p => p.id);
    const r = await fetch("/api/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",                 // owner session cookie authorizes the write
      body: JSON.stringify({
        tripId: pub.id,
        name: trip.name,
        photos: list.map(p => ({ id: p.id, name: p.name, ts: p.ts, lat: p.lat, lng: p.lng, caption: p.caption || "", uploadedBy: p.uploadedBy || "" })),
        dayNotes: trip.dayNotes || {},
        track: trip.track || [],
        need,
      }),
    });
    if (r.status === 401) { syncInFlight = false; return; } // session expired; leave dirty, will retry
    if (!r.ok) throw new Error("meta sync failed " + r.status);
    const { uploads } = await r.json();
    const ok = await uploadAllPairs(list.filter(p => need.includes(p.id)), uploads);
    if (!ok) throw new Error("photo sync failed");
    pub.uploadedIds = list.map(p => p.id);   // meta already dropped removed photos server-side
    pub.dirty = false;
    await idb.put("trips", trip);
    toast("Saved");
  } catch (e) {
    console.warn("sync postponed:", e.message);
    pub.dirty = true;
    await idb.put("trips", trip);
  } finally {
    syncInFlight = false;
  }
}
async function syncAllDirty() {
  for (const t of trips) if (t.published?.dirty) await syncPublishedTrip(t);
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

  // (fullscreen viewer controls are wired in initPhotoViewControls, before the
  // viewer branch in main(), so nav/swipe/close work here too)

  // remember the password for this trip for 48h so viewers aren't re-prompted
  const PASS_KEY = "rtpass_" + tripId, PASS_TTL = 48 * 60 * 60 * 1000;
  const savePass = pass => {
    try { localStorage.setItem(PASS_KEY, JSON.stringify({ pass, exp: Date.now() + PASS_TTL })); } catch {}
  };
  const loadSavedPass = () => {
    try {
      const raw = localStorage.getItem(PASS_KEY);
      if (!raw) return null;
      const { pass, exp } = JSON.parse(raw);
      if (!exp || Date.now() > exp) { localStorage.removeItem(PASS_KEY); return null; }
      return pass;
    } catch { return null; }
  };

  const dlg = $("dlgPass");
  const tryOpen = async (presetPass) => {
    const pass = presetPass ?? $("viewPass").value;
    if (!pass) return;
    busy("Loading trip…");
    try {
      // one password check → server sets 48h CloudFront signed cookies, so the
      // browser can then load every image straight from the CDN with <img src>
      const r = await fetch("/api/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ tripId, password: pass }),
      });
      if (r.status === 401) {
        busy(false); localStorage.removeItem(PASS_KEY);
        toast("Wrong password"); dlg.showModal(); return;
      }
      if (!r.ok) throw new Error("load failed " + r.status);
      savePass(pass);
      const data = await r.json();
      viewerMode = { id: tripId, pass, name: data.name };
      viewerDayNotes = data.dayNotes || {};
      viewerTrack = Array.isArray(data.track) ? data.track : [];
      $("viewerTitle").textContent = data.name;
      document.title = data.name + " — Roadtrip Map";
      // no per-image fetching: thumbnails + full photos are plain CDN URLs, the
      // browser lazy-loads and caches them, cookies authorize each request
      photos = sortPhotos((data.photos || []).map(pm => ({
        ...pm, tripId,
        thumbSrc: `/trips/${tripId}/thumbs/${pm.id}`,
        fullSrc: `/trips/${tripId}/photos/${pm.id}`,
      })));
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

  // if we already have a valid saved password, open straight away
  const saved = loadSavedPass();
  if (saved) tryOpen(saved);
  else dlg.showModal();
}

/* ---------------- owner auth ---------------- */
async function apiMe() {
  try { const r = await fetch("/api/me", { credentials: "same-origin" }); return r.ok ? await r.json() : null; } catch { return null; }
}
async function apiLogout() {
  try { await fetch("/api/logout", { method: "POST", credentials: "same-origin" }); } catch { }
  location.reload();
}
function updateAccountChip() {
  const el = $("acctLine");
  if (el) el.textContent = account ? `Signed in as ${account.name || account.username}` : "";
}
function showLogin() {
  return new Promise(resolve => {
    const dlg = $("dlgLogin"), err = $("loginError");
    let chosen = "tom";
    const set = u => { chosen = u; document.querySelectorAll("#loginWho .who").forEach(b => b.classList.toggle("active", b.dataset.u === u)); };
    document.querySelectorAll("#loginWho .who").forEach(b => b.onclick = () => set(b.dataset.u));
    set("tom"); err.textContent = ""; $("loginPass").value = "";
    const go = async () => {
      const pw = $("loginPass").value; if (!pw) return;
      err.textContent = ""; busy("Signing in…");
      let res = null;
      try { const r = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ username: chosen, password: pw }) }); if (r.ok) res = await r.json(); } catch { }
      busy(false);
      if (!res) { err.textContent = "Wrong username or password."; return; }
      account = { username: res.username, initials: res.initials, name: res.name };
      dlg.close();
      if (res.mustChangePw) await showChangePw(pw);
      resolve();
    };
    $("btnLoginGo").onclick = go;
    $("loginPass").onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); go(); } };
    dlg.showModal();
  });
}
function showChangePw(prefillCurrent) {
  return new Promise(resolve => {
    const dlg = $("dlgChangePw"), err = $("cpwError");
    $("cpwCurrent").value = prefillCurrent || ""; $("cpwNew").value = ""; $("cpwConfirm").value = ""; err.textContent = "";
    const go = async () => {
      const cur = $("cpwCurrent").value, a = $("cpwNew").value, b = $("cpwConfirm").value;
      if (!cur) { err.textContent = "Enter your current password."; return; }
      if (a.length < 6) { err.textContent = "New password: at least 6 characters."; return; }
      if (a !== b) { err.textContent = "New passwords don't match."; return; }
      busy("Updating password…");
      let r; try { r = await fetch("/api/change-password", { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ currentPassword: cur, newPassword: a }) }); } catch { }
      busy(false);
      if (!r || r.status === 401) { err.textContent = "Current password is wrong."; return; }
      if (!r.ok) { err.textContent = "Couldn't update password."; return; }
      dlg.close(); toast("Password updated"); resolve();
    };
    $("btnCpwGo").onclick = go;
    $("btnCpwCancel").onclick = () => { dlg.close(); resolve(); };
    dlg.showModal();
  });
}

/* ---------------- wiring ---------------- */
async function main() {
  if (typeof L === "undefined")
    throw new Error("Map library failed to load — check your connection and reload");
  if (typeof exifr === "undefined")
    throw new Error("EXIF library failed to load — check your connection and reload");
  initMap();

  // Map / Gallery toggle + fullscreen viewer controls — wired in both modes
  $("tabMap").onclick = () => setView("map");
  $("tabGallery").onclick = () => setView("gallery");
  initPhotoViewControls();

  const viewerTripId = parseViewerHash();
  if (viewerTripId) { await startViewer(viewerTripId); return; }

  // owner mode — require login
  if (navigator.storage?.persist) navigator.storage.persist();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(console.warn);

  let me = await apiMe();
  if (me) {
    account = { username: me.username, initials: me.initials, name: me.name };
    if (me.mustChangePw) await showChangePw();
  } else {
    await showLogin();
  }
  updateAccountChip();

  await loadTrips();
  if (currentTripId) await switchTrip(currentTripId);   // loads the trip's photos from the cloud
  else { await loadPhotos(); renderAll(); }
  await drainInbox();
  syncAllDirty();

  $("tripSelect").onchange = e => switchTrip(e.target.value);
  $("btnAdd").onclick = () => $("filePick").click();
  $("filePick").onchange = e => { importFiles([...e.target.files]); e.target.value = ""; };
  $("btnTrips").onclick = () => { renderTripList(); updateRouteStatus(); $("dlgTrips").showModal(); };
  $("btnImportTimeline").onclick = () => $("timelinePick").click();
  $("timelinePick").onchange = e => { const f = e.target.files[0]; e.target.value = ""; if (f) importTimelineFile(f); };
  $("btnClearTimeline").onclick = clearTimeline;
  $("btnTripsClose").onclick = () => $("dlgTrips").close();
  $("btnNewTrip").onclick = () => {
    $("dlgTrips").close();
    promptName("New trip", "", name => createTrip(name));
  };
  $("btnShare").onclick = () => {
    if (!currentTripId) { toast("Create or open a trip first"); return; }
    const trip = trips.find(t => t.id === currentTripId);
    $("shareForm").style.display = "block";
    $("shareResult").style.display = "none";
    $("sharePass").value = trip.viewPassword || "";
    $("dlgShare").showModal();
  };
  $("btnShareCancel").onclick = () => $("dlgShare").close();
  $("btnShareClose").onclick = () => $("dlgShare").close();
  $("btnSharePublish").onclick = () => {
    const vp = $("sharePass").value.trim();
    if (vp.length < 4) { toast("View password must be at least 4 characters"); return; }
    publishTrip(vp);
  };
  $("btnLogout").onclick = apiLogout;
  $("btnChangePw").onclick = () => { $("dlgTrips").close(); showChangePw(); };
  $("btnPhotoDelete").onclick = async () => {
    if (!photoViewCurrent || viewerMode) return;
    await idb.del("photos", photoViewCurrent.id);
    await loadPhotos(); renderAll();
    markDirtyAndSync(currentTripId);
    if (!photos.length) { closePhotoView(); toast("Photo removed"); return; }
    showPhotoAt(Math.min(photoViewIndex, photos.length - 1));
    toast("Photo removed");
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

main().catch(e => {
  console.error(e);
  const msg = e && e.message ? e.message : String(e);
  toast("Startup error: " + msg, 10000);
});
