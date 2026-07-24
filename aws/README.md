# Roadtrip Map — AWS architecture

This replaces the Netlify Blobs + Function backend with an AWS stack designed to
serve hundreds of photos fast, by checking the trip password **once** and then
letting CloudFront's CDN deliver every image directly (cached at the edge).

```
                    ┌──────────────────────── CloudFront (one domain) ─────────────────────────┐
   Browser ───────► │  /*        → S3 SiteBucket   (the PWA: html, js, icons)                   │
                    │  /api/*    → Lambda           (publish + auth)                            │
                    │  /trips/*  → S3 MediaBucket   (photos + thumbs, signed-cookie protected)  │
                    └───────────────────────────────────────────────────────────────────────────┘
                                        │                         │
                                   DynamoDB TripsTable       Secrets Manager
                                   (name, photos[],          (CloudFront signing
                                    salt, PBKDF2 hash)         private key)
```

## How access control works

- **Password hashes** live only in DynamoDB (salted PBKDF2), never in S3, never
  sent to the browser.
- `POST /api/auth` verifies the password once and returns **CloudFront signed
  cookies** scoped to `/trips/<id>/*` for 48h. The browser then loads every
  photo/thumbnail as a normal `<img src="/trips/...">` — CloudFront validates the
  cookie and serves from cache. No per-image function call, no re-download on
  repeat visits.
- **Uploads** go direct to S3: `POST /api/publish` writes the trip record and
  returns short-lived **presigned PUT URLs**, so the owner's phone uploads
  photos + thumbs to S3 in parallel, never through the Lambda.

## Why this scales where Netlify Blobs didn't

| Concern | Old (Netlify) | New (AWS) |
|---|---|---|
| Image delivery | every image via a function | direct from CloudFront edge cache |
| Repeat visits | re-downloaded each time | served from CDN + browser cache |
| Uploads | sequential, via function | parallel, direct-to-S3 presigned |
| Auth cost | per-image password check | one check → 48h signed cookie |
| Ceiling | slow at a few hundred photos | thousands, no code change |

## Files

- `template.yaml` — CloudFormation/SAM: S3 (site + media), CloudFront (+ OAC,
  public key, key group), Lambda + Function URL, DynamoDB, Secrets Manager, IAM.
- `lambda/index.mjs` — the `/api/publish` and `/api/auth` handlers.
- `DEPLOY.md` — step-by-step CloudShell runbook.

## Regions

Deploy in whatever region you like; CloudFront is global. The managed cache /
origin-request policy IDs in the template are global AWS defaults.
