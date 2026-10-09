import { json, safe, checkPin } from '../_lib/guard.js';

export const onRequestPost = safe(async ({ request, env }) => {
  const rejected = await checkPin(request, env);
  return rejected || json({ ok: true });
});
