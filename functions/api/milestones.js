import { json, safe, checkPin, readLimited, methodNotAllowed } from '../_lib/guard.js';
import { IDS, isRealDate } from '../_lib/ids.js';

const KEY = 'milestones';
const PREV_KEYS = ['milestones:prev1', 'milestones:prev2', 'milestones:prev3']; // 3 backup generations
const MIN_RECORDS = 15; // a write leaving fewer records needs X-Force-Write: 1
const MAX_BODY = 256 * 1024;
const MAX_NOTE = 300;
const MAX_REMOVED = 3;

const DEFAULT_RECORDS = {
  '1': { done: true, date: '2026-09-06', note: 'ชำระงวด 1 แล้ว' },
  '1.1': { done: true, date: '2026-10-06', note: 'ชำระงวด 1.1 แล้ว' },
};

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Strict validation for writes. Returns records (null-prototype object) or null if invalid.
function validateRecords(raw) {
  if (!isPlain(raw)) return null;
  const keys = Object.keys(raw);
  if (keys.length === 0) return null; // {} must never wipe data
  const out = Object.create(null);
  for (const id of keys) {
    if (!IDS.has(id)) return null; // unknown ids incl. constructor / __proto__
    const r = raw[id];
    if (!isPlain(r)) return null;
    const rec = {};
    if (r.done !== undefined) { if (typeof r.done !== 'boolean') return null; rec.done = r.done; }
    if (r.date !== undefined) {
      if (typeof r.date !== 'string' || (r.date !== '' && !isRealDate(r.date))) return null;
      rec.date = r.date;
    }
    if (r.note !== undefined) {
      if (typeof r.note !== 'string' || r.note.length > MAX_NOTE) return null;
      rec.note = r.note;
    }
    out[id] = rec;
  }
  return out;
}

// Lenient filter for data already stored (only known ids survive).
function cleanStored(raw) {
  if (!isPlain(raw)) return null;
  const out = Object.create(null);
  for (const id of Object.keys(raw)) if (IDS.has(id) && isPlain(raw[id])) out[id] = raw[id];
  return out;
}

async function readStore(env) {
  const stored = await env.MILESTONES.get(KEY, 'json');
  if (isPlain(stored)) {
    return {
      updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : new Date().toISOString(),
      records: cleanStored(stored.records) || { ...DEFAULT_RECORDS },
    };
  }
  const store = { updatedAt: new Date().toISOString(), records: { ...DEFAULT_RECORDS } };
  await env.MILESTONES.put(KEY, JSON.stringify(store));
  return store;
}

export const onRequestGet = safe(async ({ env }) => json(await readStore(env)));

export const onRequestPut = safe(async ({ request, env }) => {
  // PIN + rate limit first, before the body is read or parsed.
  const rejected = await checkPin(request, env);
  if (rejected) return rejected;
  const bytes = await readLimited(request, MAX_BODY); // 413 early on Content-Length, and while streaming (lying/chunked)
  if (!bytes) return json({ error: 'payload_too_large' }, 413);
  let body;
  try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch (_) { return json({ error: 'invalid_json' }, 400); }
  const records = validateRecords(isPlain(body) && body.records !== undefined ? body.records : body);
  if (!records) return json({ error: 'invalid_records' }, 400);
  const force = request.headers.get('x-force-write') === '1'; // PIN already verified above

  const current = await readStore(env);
  const removed = Object.keys(current.records).filter((id) => !(id in records)).length;
  if (!force && removed > MAX_REMOVED) return json({ error: 'too_many_removed' }, 409);
  if (!force && Object.keys(records).length < MIN_RECORDS) return json({ error: 'too_few_records', min: MIN_RECORDS }, 409);

  // Rotate backups: prev2->prev3, prev1->prev2, current->prev1
  const [cur, p1, p2] = await Promise.all([env.MILESTONES.get(KEY), env.MILESTONES.get(PREV_KEYS[0]), env.MILESTONES.get(PREV_KEYS[1])]);
  if (p2) await env.MILESTONES.put(PREV_KEYS[2], p2);
  if (p1) await env.MILESTONES.put(PREV_KEYS[1], p1);
  if (cur) await env.MILESTONES.put(PREV_KEYS[0], cur);
  const store = { updatedAt: new Date().toISOString(), records };
  await env.MILESTONES.put(KEY, JSON.stringify(store));
  return json(store);
});
export const onRequest = methodNotAllowed('GET, PUT');
