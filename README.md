# Taky tracker (Cloudflare Pages + Functions + KV)

- `public/` static UI (`index.html`) + `_headers` (noindex, X-Frame-Options DENY, CSP). Only `public/` is deployed.
- `functions/api/milestones.js` - GET open, PUT needs `X-Edit-Pin`. `functions/api/check-pin.js` - POST, checks a PIN without saving (the UI uses it to say "wrong PIN" before editing). `functions/api/health.js`.
- Data: one JSON value `{updatedAt, records}` under KV key `milestones` (binding `MILESTONES`). GET seeds defaults if missing.
- Unsupported methods return JSON `405`; errors are JSON, never HTML.

## Safety rules on writes (PUT /api/milestones)
- PIN is checked before the body is read. Body max 256 KB (`413`, rejected early on Content-Length and also while streaming, so a lying or chunked body is capped too).
- Only known milestone ids, `done` boolean, `date` a real calendar date (`YYYY-MM-DD`, round-tripped: `2026-13-99` is rejected), `note` <= 300 chars.
- Erosion guard: a write that removes more than 3 records, or leaves fewer than 15 records, is refused with `409` unless the header `X-Force-Write: 1` is sent (still needs the valid PIN). The UI Reset button uses it; normal Save always sends all 18 ids.
- 3 backup generations are rotated on every write: KV keys `milestones:prev1` (newest), `prev2`, `prev3`. Restore with `npx wrangler kv key get --namespace-id <ID> milestones:prev1 --remote > restore.json` then `kv key put ... milestones --path restore.json --remote`.

## PIN and rate limit
- Only the SHA-256 hash is stored (secret `TRACKER_PIN_HASH`). PIN goes in header `X-Edit-Pin`; the browser keeps it in `sessionStorage` only.
- Wrong PINs are counted only when a PIN is sent and wrong (a missing header is not a strike; a correct PIN resets that IP's counter). Limits per 10 minutes: **5 wrong PINs per IP** (`rl:<ip>`) **and a global cap of 20 wrong PINs across all IPs** (`rl:global`) - when either is reached everyone gets `429`, even with the right PIN, until the window expires. Only `CF-Connecting-IP` is trusted. If it is missing, a shared `local` bucket is used and a `console.warn` alert is logged.
- Counters live in KV, so they are best effort (KV is eventually consistent).
- `POST /api/check-pin` uses the same checks and strikes.

## Construction photos
**For Taky (phone):** 1) open the tracker link. 2) Tap a milestone (or the "Site progress photos" box at the top for photos that belong to no milestone). 3) Tap **Add photos** and enter the edit PIN once (it is remembered only until you close the tab). 4) Pick one or more photos from the gallery or camera. 5) For each photo set the **work date** (defaults to today; change it to the day the work happened) and an optional caption (max 200 chars, Thai first then English is fine). 6) Tap **Upload** and wait for "Done n/n". Tap a thumbnail to see it full size.

- Browser resizes before upload: longest side 1600 px, JPEG quality 0.8, EXIF rotation honoured (typically 200-500 KB). **A photo that is already <= 1600 px and <= 2 MB is uploaded unchanged** (no recompress). Re-encoded photos lose all EXIF including GPS; unchanged ones keep whatever they contain. (Burned-in text on the picture is never touched.)
- HEIC that the browser cannot decode shows a Thai/English message; use JPEG ("Most Compatible") instead.
- API: `POST /api/photos?milestone=<id, optional>&date=YYYY-MM-DD&caption=...` (raw image body, `X-Edit-Pin`), `GET /api/photos[?milestone=<id|_general>]` (open list, newest first), `GET /api/photos/<id>` (open, image bytes, `nosniff`, 1-year immutable cache), `DELETE /api/photos/<id>` (PIN). Same PIN check, per-IP limit and global cap as saving milestones.
- Server checks magic bytes (JPEG/PNG/WebP only; the client Content-Type is ignored), max 2 MB per photo, 12 photos per milestone, 400 total (`MAX_PHOTOS_TOTAL` env can lower it for tests). Photos with no milestone live under `_general` (cap = total cap).
- Storage (KV, same `MILESTONES` binding): `photo:<uuid>` = image bytes (+ metadata with the validated type), `photos:index:<milestoneId|_general>` = JSON list `{id, milestoneId, date, caption, size, createdAt}`. Upload writes the image first, then the index (re-read, merge, write, verify, retry); if the index write fails the image is deleted. Delete removes from the index first.
- Free-plan limits (no paid plan needed): KV free = 1 GB storage, 1,000 writes/day, 100,000 reads/day, 1,000 lists/day, 25 MB/value. At ~300 KB/photo 1 GB is ~3,000 photos (cap is 400). Each upload costs ~2 KV writes (image + index) plus a wrong-PIN counter write only on failures, so **1,000 writes/day is about 400-500 photos/day max**, and Save/backups (4 writes) and PIN counters share that same budget. Each upload also does one KV list (total-count check).
- Captions are rendered as text only (never HTML). The PIN stays in `sessionStorage`.

## Deploy
1. Cloudflare dashboard: KV namespace; Pages project from this GitHub repo (the Cloudflare GitHub app needs access to this repo). Build command: none; output dir: `public`.
2. Pages > Settings > Bindings: KV namespace binding `MILESTONES` (Production + Preview). `wrangler.toml` already carries the namespace id; do not change its layout.
3. Pages > Settings > Variables and Secrets: secret `TRACKER_PIN_HASH` = SHA-256 hex of the PIN (`printf '%s' "$PIN" | sha256sum`). Redeploy.
4. Import seed (optional, else defaults are used):
   `npx wrangler kv key put --namespace-id <ID> milestones --path seed/milestones.json --remote`

## Local
`cp .dev.vars.example .dev.vars` (fill a throwaway hash), then `npx wrangler pages dev public --kv MILESTONES --port 8788`. Never commit `.dev.vars` or a real PIN.

## Tests
`PORT=8811 PIN=<throwaway> ./test/run.sh` (needs Playwright in `PW_DIR`, default /workspace/pw-test: `npm i playwright && npx playwright install chromium`) seeds a fresh local KV from `seed/milestones.json`, starts wrangler itself, asserts every API case, then runs the Playwright UI suite (`test/ui.cjs`, real 4000x3000 JPEG, 390 px mobile checks), and exits non-zero on any failure.
