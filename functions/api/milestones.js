import { json, safe, checkPin } from '../_lib/guard.js';

const KEY = 'milestones';
const PREV_KEY = 'milestones:prev';
const MAX_BODY = 256 * 1024;
const MAX_NOTE = 300;
const MAX_REMOVED = 3;
const IDS = new Set(['1', '1.1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16', '17']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
      if (typeof r.date !== 'string' || (r.date !== '' && !DATE_RE.test(r.date))) return null;
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
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY) return json({ error: 'payload_too_large' }, 413);
  let body;
  try { body = JSON.parse(text); } catch (_) { return json({ error: 'invalid_json' }, 400); }
  const records = validateRecords(isPlain(body) && body.records !== undefined ? body.records : body);
  if (!records) return json({ error: 'invalid_records' }, 400);

  const current = await readStore(env);
  const removed = Object.keys(current.records).filter((id) => !(id in records)).length;
  if (removed > MAX_REMOVED) return json({ error: 'too_many_removed' }, 409);

  const prev = await env.MILESTONES.get(KEY);
  if (prev) await env.MILESTONES.put(PREV_KEY, prev); // keep previous copy
  const store = { updatedAt: new Date().toISOString(), records };
  await env.MILESTONES.put(KEY, JSON.stringify(store));
  return json(store);
});
