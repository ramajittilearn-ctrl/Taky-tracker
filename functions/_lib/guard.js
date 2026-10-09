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
  const ip = (request.headers.get('cf-connecting-ip') || '').trim().slice(0, 64) || 'local';
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
