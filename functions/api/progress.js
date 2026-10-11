import { json, safe, methodNotAllowed } from '../_lib/guard.js';
import { TITLES } from '../_lib/titles.js';
import { readIndex, sortNewest, allIndexIds, GENERAL } from '../_lib/photos.js';

// PUBLIC timeline feed. Privacy: returns ONLY {photos:[{id,date,caption,milestoneTitle}]}.
// Never reads `milestones` records (no notes, done flags, payment data). Titles come from a fixed map.
// ?offset=0&limit=24 (limit max 50, default 24).
export const onRequestGet = safe(async ({ request, env }) => {
  const u = new URL(request.url);
  const offset = Math.max(0, parseInt(u.searchParams.get('offset'), 10) || 0);
  const limit = Math.min(50, Math.max(1, parseInt(u.searchParams.get('limit'), 10) || 24));
  const lists = await Promise.all(allIndexIds().map(async (ms) => (await readIndex(env, ms)).map((e) => ({ ...e, ms }))));
  const all = lists.flat().sort(sortNewest).slice(offset, offset + limit);
  return json({
    photos: all.map((e) => ({
      id: e.id,
      date: e.date,
      caption: typeof e.caption === 'string' ? e.caption : '',
      milestoneTitle: e.ms === GENERAL ? null : (TITLES[e.ms] || null),
    })),
  });
});
export const onRequest = methodNotAllowed('GET');
