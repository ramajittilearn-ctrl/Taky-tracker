import { methodNotAllowed } from '../_lib/guard.js';

export function onRequestGet() {
  return Response.json({ ok: true, service: 'apartment-progress-tracker', runtime: 'cloudflare-pages' });
}
export const onRequest = methodNotAllowed('GET');
