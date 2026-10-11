// Shared helpers: JSON responses, error wrapper, PIN check with rate limiting.
export const FAIL_MAX = 5;          // wrong PINs per IP per window
export const GLOBAL_MAX = 20;       // wrong PINs across all IPs per window
export const FAIL_TTL = 600;        // 10 min window
// NOTE: KV is eventually consistent and read-modify-write is not atomic, so
// these counters are best-effort (concurrent bursts may slip a few extra tries).

export const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

// Any thrown error -> JSON 500, never an HTML stack trace.
export const safe = (fn) => async (ctx) => {
  try { return await fn(ctx); }
  catch (err) { console.error('handler error', err && err.message); return json({ error: 'server_error' }, 500); }
};

// JSON 405 for unsupported methods.
export const methodNotAllowed = (allow) => () =>
  new Response(JSON.stringify({ error: 'method_not_allowed' }), {
    status: 405,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', allow },
  });

// Read a request body with a hard byte cap, independent of Content-Length (may lie, or be absent/chunked).
// Returns Uint8Array, or null if the cap is exceeded.
export async function readLimited(request, max) {
  const cl = request.headers.get('content-length');
  if (cl && Number(cl) > max) return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { try { await reader.cancel(); } catch (_) {} return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(total); let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
const readCount = async (env, k) => parseInt((await env.MILESTONES.get(k)) || '0', 10) || 0;

// Returns a Response if the request must be rejected, otherwise null.
// Only CF-Connecting-IP is trusted (Cloudflare sets it); X-Forwarded-For is ignored.
export async function checkPin(request, env) {
  const hash = env.TRACKER_PIN_HASH;
  if (!/^[0-9a-f]{64}$/i.test(hash || '')) return json({ error: 'pin_not_configured' }, 503);
  let ip = (request.headers.get('cf-connecting-ip') || '').trim().slice(0, 64);
  if (!ip) { ip = 'local'; console.warn('ALERT: no CF-Connecting-IP, using shared "local" rate-limit bucket'); }
  const ipKey = 'rl:' + ip;
  const [ipCount, globalCount] = await Promise.all([readCount(env, ipKey), readCount(env, 'rl:global')]);
  if (ipCount >= FAIL_MAX || globalCount >= GLOBAL_MAX) return json({ error: 'too_many_attempts' }, 429);
  const pin = request.headers.get('x-edit-pin');
  if (!pin) return json({ error: 'pin_required' }, 401); // missing header: not a strike
  let ok = false;
  if (pin.length <= 64) {
    const given = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pin)));
    ok = timingSafeEqual(given, hexToBytes(hash));
  }
  if (!ok) {
    await env.MILESTONES.put(ipKey, String(ipCount + 1), { expirationTtl: FAIL_TTL });
    await env.MILESTONES.put('rl:global', String(globalCount + 1), { expirationTtl: FAIL_TTL });
    return json({ error: 'wrong_pin' }, 401);
  }
  if (ipCount > 0) await env.MILESTONES.delete(ipKey); // correct PIN resets this IP
  return null;
}
