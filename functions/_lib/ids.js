// Known milestone ids (shared by milestones + photos).
export const IDS = new Set(['1', '1.1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16', '17']);

// Real calendar date check: YYYY-MM-DD that survives a Date round trip (rejects 2026-13-99, 2026-02-30).
export function isRealDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
