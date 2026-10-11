// Shared photo helpers (KV layout: photo:<id> = image bytes + metadata; photos:index:<ms|_general> = JSON array).
import { IDS, isRealDate } from './ids.js';

export const GENERAL = '_general';
export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
export const MAX_PER_MILESTONE = 12;
export const DEFAULT_MAX_TOTAL = 400;
export const MAX_CAPTION = 200;
export const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export const maxTotal = (env) => { const n = parseInt(env.MAX_PHOTOS_TOTAL, 10); return n > 0 ? n : DEFAULT_MAX_TOTAL; };
export const indexKey = (ms) => 'photos:index:' + ms;

// '' / missing / '_general' -> GENERAL (no milestone); known id -> id; anything else -> null (invalid).
export function normMilestone(v) {
  if (v === null || v === undefined || v === '' || v === GENERAL) return GENERAL;
  return IDS.has(v) ? v : null;
}
export const publicMs = (ms) => (ms === GENERAL ? '' : ms);
export const allIndexIds = () => [...IDS, GENERAL];

// Magic bytes decide the type; the client's Content-Type is never trusted.
export function sniffType(b) {
  if (b.length > 12 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 12 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length > 12 && String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}

export function today() { // calendar date in Asia/Bangkok (UTC+7)
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

export function cleanCaption(v) {
  if (v === null || v === undefined) return '';
  const s = String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return [...s].length > MAX_CAPTION ? null : s;
}
export { isRealDate };

export async function readIndex(env, ms) {
  const v = await env.MILESTONES.get(indexKey(ms), 'json');
  return Array.isArray(v) ? v.filter((e) => e && typeof e.id === 'string' && ID_RE.test(e.id)) : [];
}

// Re-read, apply, write, verify; retry a few times so two close uploads don't lose each other.
export async function updateIndex(env, ms, mutate, verify) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const next = mutate(await readIndex(env, ms));
    await env.MILESTONES.put(indexKey(ms), JSON.stringify(next));
    if (verify((await readIndex(env, ms)))) return true;
    await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
  }
  return false;
}

export const sortNewest = (a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || '');

export async function countPhotos(env) {
  let n = 0, cursor;
  do {
    const r = await env.MILESTONES.list({ prefix: 'photo:', cursor });
    n += r.keys.length; cursor = r.list_complete ? undefined : r.cursor;
  } while (cursor);
  return n;
}
