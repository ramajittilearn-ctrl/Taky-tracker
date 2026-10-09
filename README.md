# Taky tracker (Cloudflare Pages + Functions + KV)

- `public/` static UI (`index.html`), `functions/api/milestones.js` (GET open, PUT needs `X-Edit-Pin`), `functions/api/health.js`.
- Data: one JSON value `{updatedAt, records}` under KV key `milestones` (binding `MILESTONES`). GET seeds defaults if missing.
- Wrong-PIN rate limit: KV key `rl:<ip>`, TTL 600s, 5 failures -> 429 (best effort; KV is eventually consistent).

## Deploy
1. Cloudflare dashboard: create a KV namespace; create a Pages project from this GitHub repo (the Cloudflare GitHub app needs access to this repo - needs Taky). Build command: none; output dir: `public`.
2. Pages > Settings > Bindings: KV namespace binding `MILESTONES` (Production + Preview).
3. Pages > Settings > Variables and Secrets: secret `TRACKER_PIN_HASH` = SHA-256 hex of the PIN (`printf '%s' "$PIN" | sha256sum`). Redeploy.
4. Import seed (optional, else defaults are used):
   `npx wrangler kv key put --binding MILESTONES milestones --path seed/milestones.json --remote`

## Local
`cp .dev.vars.example .dev.vars` (fill hash), then `npx wrangler pages dev public --kv MILESTONES --port 8788`.
Never commit `.dev.vars`.
