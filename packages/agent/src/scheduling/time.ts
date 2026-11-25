/** Interval helpers on epoch milliseconds. */

export const MINUTE_MS = 60_000;
export const DAY_MS = 24 * 60 * MINUTE_MS;

export interface Interval {
  start: number;
  end: number;
}

export function toMs(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`Invalid timestamp: ${iso}`);
  return ms;
}

export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Date part (`YYYY-MM-DD`) of an epoch time, in UTC. */
export function toDate(ms: number): string {
  return toIso(ms).slice(0, 10);
}

/** Short `YYYY-MM-DD HH:MM` UTC label for reasons. */
export function toLabel(ms: number): string {
  return toIso(ms).slice(0, 16).replace('T', ' ');
}

/** Free sub-intervals of `window` once `busy` intervals are removed, in time order. */
export function freeGaps(window: Interval, busy: Interval[]): Interval[] {
  const sorted = busy
    .filter((b) => b.end > window.start && b.start < window.end)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const gaps: Interval[] = [];
  let cursor = window.start;
  for (const b of sorted) {
    if (b.start > cursor) gaps.push({ start: cursor, end: b.start });
    cursor = Math.max(cursor, b.end);
  }
  if (cursor < window.end) gaps.push({ start: cursor, end: window.end });
  return gaps;
}
