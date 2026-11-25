import { describe, expect, it } from 'vitest';
import { freeGaps, toDate, toLabel, toMs } from './time.js';

describe('time helpers', () => {
  it('removes busy intervals from a window, merging overlaps and ignoring outside ones', () => {
    const gaps = freeGaps({ start: 0, end: 100 }, [
      { start: 30, end: 40 },
      { start: 35, end: 50 },
      { start: 150, end: 200 },
      { start: -10, end: 5 },
    ]);
    expect(gaps).toEqual([
      { start: 5, end: 30 },
      { start: 50, end: 100 },
    ]);
    expect(freeGaps({ start: 0, end: 10 }, [{ start: 0, end: 10 }])).toEqual([]);
  });

  it('parses and formats timestamps', () => {
    const ms = toMs('2026-12-08T13:00:00.000Z');
    expect(toDate(ms)).toBe('2026-12-08');
    expect(toLabel(ms)).toBe('2026-12-08 13:00');
    expect(() => toMs('not a date')).toThrow('Invalid timestamp');
  });
});
