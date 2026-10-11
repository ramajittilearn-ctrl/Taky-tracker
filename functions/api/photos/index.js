import { json, safe, checkPin, readLimited, methodNotAllowed } from '../../_lib/guard.js';
import {
  MAX_PHOTO_BYTES, MAX_PER_MILESTONE, GENERAL, normMilestone, publicMs, sniffType, today, cleanCaption, isRealDate,
  readIndex, updateIndex, sortNewest, countPhotos, maxTotal, allIndexIds,
} from '../../_lib/photos.js';

// GET /api/photos[?milestone=<id|_general>]  (open) -> {photos:[{id,milestoneId,date,caption,size,createdAt}]} newest first
export const onRequestGet = safe(async ({ request, env }) => {
  const q = new URL(request.url).searchParams.get('milestone');
  if (q !== null && q !== '') {
    const ms = normMilestone(q);
    if (!ms) return json({ error: 'unknown_milestone' }, 400);
    return json({ photos: (await readIndex(env, ms)).map((e) => ({ ...e, milestoneId: publicMs(ms) })).sort(sortNewest) });
  }
  const lists = await Promise.all(allIndexIds().map(async (ms) => (await readIndex(env, ms)).map((e) => ({ ...e, milestoneId: publicMs(ms) }))));
  return json({ photos: lists.flat().sort(sortNewest) });
});

// POST /api/photos?milestone=<id, optional>&date=YYYY-MM-DD&caption=...   body = raw image bytes (PIN-gated)
export const onRequestPost = safe(async ({ request, env }) => {
  const rejected = await checkPin(request, env);
  if (rejected) return rejected;
  const url = new URL(request.url);
  const ms = normMilestone(url.searchParams.get('milestone'));
  if (!ms) return json({ error: 'unknown_milestone' }, 400);
  const date = url.searchParams.get('date') || today();
  if (!isRealDate(date)) return json({ error: 'invalid_date' }, 400);
  const caption = cleanCaption(url.searchParams.get('caption'));
  if (caption === null) return json({ error: 'caption_too_long' }, 400);

  const bytes = await readLimited(request, MAX_PHOTO_BYTES);
  if (!bytes) return json({ error: 'photo_too_large', maxBytes: MAX_PHOTO_BYTES }, 413);
  const type = sniffType(bytes);
  if (!type) return json({ error: 'not_a_supported_image', accepted: 'jpeg, png, webp' }, 415);

  const total = maxTotal(env);
  const perCap = ms === GENERAL ? total : MAX_PER_MILESTONE;
  if ((await readIndex(env, ms)).length >= perCap) return json({ error: 'milestone_photo_limit', max: perCap }, 409);
  if ((await countPhotos(env)) >= total) return json({ error: 'total_photo_limit', max: total }, 409);

  const id = crypto.randomUUID();
  await env.MILESTONES.put('photo:' + id, bytes, { metadata: { type, ms } }); // image first
  const entry = { id, milestoneId: ms, date, caption, size: bytes.length, createdAt: new Date().toISOString() };
  let ok = false;
  try { ok = await updateIndex(env, ms, (list) => [...list.filter((e) => e.id !== id), entry], (list) => list.some((e) => e.id === id)); }
  catch (_) { ok = false; }
  if (!ok) { await env.MILESTONES.delete('photo:' + id); return json({ error: 'index_write_failed' }, 500); } // clean up orphan image
  return json({ id, photo: { ...entry, milestoneId: publicMs(ms) } }, 201);
});

export const onRequest = methodNotAllowed('GET, POST');
