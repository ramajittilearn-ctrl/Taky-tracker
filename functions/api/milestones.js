const KEY = 'milestones';
const MAX_BODY = 256 * 1024;
const FAIL_MAX = 5;
const FAIL_TTL = 600;

const DEFAULT_RECORDS = {
  '1': { done: true, date: '2026-09-06', note: 'ชำระงวด 1 แล้ว' },
  '1.1': { done: true, date: '2026-10-06', note: 'ชำระงวด 1.1 แล้ว' },
};

function sanitizeRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  if (typeof raw.done === 'boolean') out.done = raw.done;
  if (typeof raw.date === 'string') out.date = raw.date;
  if (typeof raw.note === 'string') out.note = raw.note;
  return out;
}

function sanitizeRecords(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const [id, value] of Object.entries(raw)) {
    if (typeof id !== 'string' || !id.trim()) continue;
    const rec = sanitizeRecord(value);
    if (rec) out[id] = rec;
  }
  return out;
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

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

async function readStore(env) {
  const stored = await env.MILESTONES.get(KEY, 'json');
  if (stored && typeof stored === 'object') {
    return {
      updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : new Date().toISOString(),
      records: sanitizeRecords(stored.records) || { ...DEFAULT_RECORDS },
    };
  }
  const store = { updatedAt: new Date().toISOString(), records: { ...DEFAULT_RECORDS } };
  await env.MILESTONES.put(KEY, JSON.stringify(store));
  return store;
}

export async function onRequestGet({ env }) {
  try {
    return json(await readStore(env));
  } catch (err) {
    console.error('GET /api/milestones', err);
    return json({ error: 'failed_to_read_milestones' }, 500);
  }
}

// Returns a Response if the request must be rejected, otherwise null.
async function checkPin(request, env) {
  const hash = env.TRACKER_PIN_HASH;
  if (!/^[0-9a-f]{64}$/i.test(hash || '')) return json({ error: 'pin_not_configured' }, 503);
  const ip = (request.headers.get('cf-connecting-ip') || 'unknown').trim();
  const rlKey = 'rl:' + ip;
  const count = parseInt((await env.MILESTONES.get(rlKey)) || '0', 10) || 0;
  if (count >= FAIL_MAX) return json({ error: 'too_many_attempts' }, 429);
  const pin = request.headers.get('x-edit-pin');
  let ok = false;
  if (typeof pin === 'string' && pin.length > 0 && pin.length <= 64) {
    const given = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pin)));
    ok = timingSafeEqual(given, hexToBytes(hash));
  }
  if (!ok) {
    // Best-effort counter (KV is eventually consistent); TTL = 10 min window.
    await env.MILESTONES.put(rlKey, String(count + 1), { expirationTtl: FAIL_TTL });
    return json({ error: 'wrong_pin' }, 401);
  }
  return null;
}

export async function onRequestPut({ request, env }) {
  const rejected = await checkPin(request, env);
  if (rejected) return rejected;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).length > MAX_BODY) return json({ error: 'payload_too_large' }, 413);
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch (_) { return json({ error: 'invalid_records' }, 400); }
    body = body || {};
    const incoming = body.records !== undefined ? body.records : body;
    const records = sanitizeRecords(incoming);
    if (!records) return json({ error: 'invalid_records' }, 400);
    const store = { updatedAt: new Date().toISOString(), records };
    await env.MILESTONES.put(KEY, JSON.stringify(store));
    return json(store);
  } catch (err) {
    console.error('PUT /api/milestones', err);
    return json({ error: 'failed_to_write_milestones' }, 500);
  }
}
