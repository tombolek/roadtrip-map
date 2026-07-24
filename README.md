# Roadtrip Map

A local-first PWA that puts your photos on a map using their EXIF location + time,
connects them chronologically into trips, and lets you publish a password-protected
copy of a trip to share with family.

## How it works

- **Your photos stay on your device.** Everything is stored in the browser's
  IndexedDB. Photos are downscaled to max 2048 px for storage (originals stay in
  Google Photos).
- **Android share target.** After installing the PWA, select photos in Google
  Photos → Share → **Roadtrip Map**. The service worker receives them on-device;
  nothing is uploaded.
- **Sharing a trip** uploads a copy (downscaled photos + route) to Netlify Blobs
  via a Netlify Function. Viewers need the link **and** the password you chose
  (stored server-side only as a salted PBKDF2 hash).

## Deploy to Netlify

The Function + Blobs part means you can't use plain drag-and-drop (that only
deploys static files). Two easy options:

### Option A — Netlify CLI (fastest)

```bash
npm install -g netlify-cli
cd roadtrip-map
npm install
netlify login
netlify init        # create a new site
netlify deploy --prod
```

### Option B — GitHub

Push this folder to a GitHub repo, then in Netlify: **Add new site → Import from
Git**. Build settings are read from `netlify.toml` (publish dir `public`, no build
command needed).

Netlify Blobs works out of the box on both — no extra configuration.

## Install on your phone

Open the site in Chrome on Android → menu → **Add to Home screen / Install app**.
After install, "Roadtrip Map" appears in the Android share sheet.

## Using it

1. Create a trip (☰ → New trip).
2. Add photos: share from Google Photos, or ＋ to pick files.
3. Photos with GPS appear as markers connected by a dashed route line, in time
   order. Photos without GPS show only in the bottom strip (orange border).
4. Share: ↗ → choose a password → Publish → send the link + password to family.
   Publishing again later updates the shared copy (same password).

## Notes & caveats

- **Google Photos may strip location on share.** If shared photos land without
  GPS, check Google Photos → your account → Photos settings → Sharing → turn OFF
  "Hide photo location data". Alternatively pick files from the camera folder.
- **HEIC**: most Android Chrome versions can't decode HEIC in the browser. Google
  Photos usually shares JPEG, so this rarely matters.
- Shared-trip links are random IDs; access requires the password. Fine for family
  sharing, not for secrets.
- Trip data on the viewer's side is fetched fresh each visit; nothing is
  installed for them — the link works in any browser.

## Roadmap (v2 ideas)

- Google Maps Timeline import: export Timeline JSON on your phone
  (Settings → Location → Timeline → Export) and drop it in to draw the real
  driven route under the photos.
- Photo captions, per-day grouping, animated trip playback.
