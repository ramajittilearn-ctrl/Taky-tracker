Seed data copied from the old server (no secrets). It holds only 6 records; the 18 milestones themselves (titles, amounts, checklists) live in `public/index.html`, and a normal Save writes all 18 ids.
Import into Cloudflare KV:
`npx wrangler kv key put --namespace-id <ID> milestones --path seed/milestones.json --remote`
