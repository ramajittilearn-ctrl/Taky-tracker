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

## Deploy
1. Cloudflare dashboard: KV namespace; Pages project from this GitHub repo (the Cloudflare GitHub app needs access to this repo). Build command: none; output dir: `public`.
2. Pages > Settings > Bindings: KV namespace binding `MILESTONES` (Production + Preview). `wrangler.toml` already carries the namespace id; do not change its layout.
3. Pages > Settings > Variables and Secrets: secret `TRACKER_PIN_HASH` = SHA-256 hex of the PIN (`printf '%s' "$PIN" | sha256sum`). Redeploy.
4. Import seed (optional, else defaults are used):
   `npx wrangler kv key put --namespace-id <ID> milestones --path seed/milestones.json --remote`

## Local
`cp .dev.vars.example .dev.vars` (fill a throwaway hash), then `npx wrangler pages dev public --kv MILESTONES --port 8788`. Never commit `.dev.vars` or a real PIN.

## Tests
`PORT=8811 PIN=<throwaway> ./test/run.sh` seeds a fresh local KV from `seed/milestones.json`, starts wrangler itself, asserts every case and exits non-zero on any failure.
