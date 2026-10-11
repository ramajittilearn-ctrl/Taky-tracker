import { json, safe, checkPin, methodNotAllowed } from '../../_lib/guard.js';
import { ID_RE, TYPES, updateIndex } from '../../_lib/photos.js';

// GET /api/photos/<id> (open): image bytes, type from validated metadata only.
export const onRequestGet = safe(async ({ params, env }) => {
  const id = String(params.id || '');
  if (!ID_RE.test(id)) return json({ error: 'invalid_id' }, 400);
  const { value, metadata } = await env.MILESTONES.getWithMetadata('photo:' + id, 'arrayBuffer');
  if (!value || !metadata || !TYPES.has(metadata.type)) return json({ error: 'not_found' }, 404);
  return new Response(value, {
    headers: {
      'content-type': metadata.type,
      'x-content-type-options': 'nosniff',
      'cache-control': 'public, max-age=31536000, immutable',
      'content-security-policy': "default-src 'none'; sandbox",
    },
  });
});

// DELETE /api/photos/<id> (PIN-gated): remove from index first, then the image.
export const onRequestDelete = safe(async ({ request, params, env }) => {
  const rejected = await checkPin(request, env);
  if (rejected) return rejected;
  const id = String(params.id || '');
  if (!ID_RE.test(id)) return json({ error: 'invalid_id' }, 400);
  const { value, metadata } = await env.MILESTONES.getWithMetadata('photo:' + id, 'arrayBuffer');
  if (!value || !metadata) return json({ error: 'not_found' }, 404);
  const ms = metadata.ms;
  const ok = await updateIndex(env, ms, (list) => list.filter((e) => e.id !== id), (list) => !list.some((e) => e.id === id));
  if (!ok) return json({ error: 'index_write_failed' }, 500);
  await env.MILESTONES.delete('photo:' + id);
  return json({ ok: true });
});

export const onRequest = methodNotAllowed('GET, DELETE');
