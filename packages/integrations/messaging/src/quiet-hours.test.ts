import { describe, expect, it } from 'vitest';
import {
  InvalidTimeZoneError,
  isQuietHours,
  nextWindowOpen,
  parseClockTime,
  quietHoursFromEnv,
} from './quiet-hours.js';

const iso = (s: string) => new Date(s);
const CHI = 'America/Chicago';

describe('isQuietHours', () => {
  it('treats 20:00 as quiet and 19:59 as open (Central, standard time)', () => {
    expect(isQuietHours(iso('2026-01-16T01:59:00Z'), CHI)).toBe(false); // 19:59 CST
    expect(isQuietHours(iso('2026-01-16T02:00:00Z'), CHI)).toBe(true); // 20:00 CST
  });

  it('treats 08:00 as open and 07:59 as quiet', () => {
    expect(isQuietHours(iso('2026-01-15T13:59:00Z'), CHI)).toBe(true); // 07:59 CST
    expect(isQuietHours(iso('2026-01-15T14:00:00Z'), CHI)).toBe(false); // 08:00 CST
  });

  it('uses the patient zone, not UTC', () => {
    // 01:00Z is 19:00 Central but 20:00 Eastern.
    expect(isQuietHours(iso('2026-01-16T01:00:00Z'), CHI)).toBe(false);
    expect(isQuietHours(iso('2026-01-16T01:00:00Z'), 'America/New_York')).toBe(true);
  });

  it('supports a same-day window and half-hour zones', () => {
    const lunch = { startMinutes: 12 * 60, endMinutes: 13 * 60 };
    expect(isQuietHours(iso('2026-01-15T18:30:00Z'), CHI, lunch)).toBe(true);
    expect(isQuietHours(iso('2026-01-15T19:00:00Z'), CHI, lunch)).toBe(false);
    // 02:30Z is 08:00 in Kolkata (+5:30): open.
    expect(isQuietHours(iso('2026-01-15T02:30:00Z'), 'Asia/Kolkata')).toBe(false);
    expect(isQuietHours(iso('2026-01-15T02:29:00Z'), 'Asia/Kolkata')).toBe(true);
  });

  it('rejects an invalid zone', () => {
    expect(() => isQuietHours(new Date(), 'Mars/Olympus')).toThrow(InvalidTimeZoneError);
  });
});

describe('nextWindowOpen', () => {
  it('returns the same instant when already open', () => {
    const t = iso('2026-01-15T16:00:00Z');
    expect(nextWindowOpen(t, CHI)).toBe(t);
  });

  it('holds 22:00 local until 08:00 next morning', () => {
    // 22:00 CST Jan 15 = 04:00Z Jan 16 -> 08:00 CST Jan 16 = 14:00Z
    expect(nextWindowOpen(iso('2026-01-16T04:00:00Z'), CHI).toISOString()).toBe(
      '2026-01-16T14:00:00.000Z',
    );
  });

  it('holds 03:00 local until 08:00 the same morning', () => {
    // 03:00 CST Jan 16 = 09:00Z
    expect(nextWindowOpen(iso('2026-01-16T09:00:00Z'), CHI).toISOString()).toBe(
      '2026-01-16T14:00:00.000Z',
    );
  });

  it('handles spring forward: 21:00 CST Mar 7 releases at 08:00 CDT Mar 8', () => {
    expect(nextWindowOpen(iso('2026-03-08T03:00:00Z'), CHI).toISOString()).toBe(
      '2026-03-08T13:00:00.000Z',
    );
  });

  it('handles the spring-forward morning itself (03:30 CDT after the gap)', () => {
    expect(nextWindowOpen(iso('2026-03-08T08:30:00Z'), CHI).toISOString()).toBe(
      '2026-03-08T13:00:00.000Z',
    );
  });

  it('handles fall back: 22:00 CDT Oct 31 releases at 08:00 CST Nov 1', () => {
    expect(nextWindowOpen(iso('2026-11-01T03:00:00Z'), CHI).toISOString()).toBe(
      '2026-11-01T14:00:00.000Z',
    );
  });

  it('handles the repeated 01:30 hour on fall-back night', () => {
    expect(nextWindowOpen(iso('2026-11-01T06:30:00Z'), CHI).toISOString()).toBe(
      '2026-11-01T14:00:00.000Z',
    ); // second 01:30 (CST)
    expect(nextWindowOpen(iso('2026-11-01T05:30:00Z'), CHI).toISOString()).toBe(
      '2026-11-01T14:00:00.000Z',
    ); // first 01:30 (CDT)
  });

  it('handles zones without DST, far-east and half-hour zones', () => {
    expect(nextWindowOpen(iso('2026-07-01T05:00:00Z'), 'America/Phoenix').toISOString()).toBe(
      '2026-07-01T15:00:00.000Z',
    ); // 22:00 MST Jun 30
    expect(nextWindowOpen(iso('2026-07-01T08:00:00Z'), 'Pacific/Honolulu').toISOString()).toBe(
      '2026-07-01T18:00:00.000Z',
    ); // 22:00 HST Jun 30
    expect(nextWindowOpen(iso('2026-07-01T10:00:00Z'), 'Pacific/Kiritimati').toISOString()).toBe(
      '2026-07-01T18:00:00.000Z',
    ); // 00:00 +14 on Jul 2 -> 08:00 Jul 2 local is 18:00Z Jul 1
    expect(nextWindowOpen(iso('2026-07-01T17:00:00Z'), 'Asia/Kolkata').toISOString()).toBe(
      '2026-07-02T02:30:00.000Z',
    ); // 22:30 IST
  });

  it('rolls across a month boundary', () => {
    // 23:00 CST Jan 31 = 05:00Z Feb 1 -> 08:00 CST Feb 1
    expect(nextWindowOpen(iso('2026-02-01T05:00:00Z'), CHI).toISOString()).toBe(
      '2026-02-01T14:00:00.000Z',
    );
  });

  it('supports a same-day window', () => {
    const lunch = { startMinutes: 12 * 60, endMinutes: 13 * 60 };
    expect(nextWindowOpen(iso('2026-01-15T18:30:00Z'), CHI, lunch).toISOString()).toBe(
      '2026-01-15T19:00:00.000Z',
    );
  });
});

describe('quiet hours config', () => {
  it('parses HH:MM and env values', () => {
    expect(parseClockTime('20:00')).toBe(1200);
    expect(() => parseClockTime('25:00')).toThrow();
    expect(quietHoursFromEnv({})).toEqual({ startMinutes: 1200, endMinutes: 480 });
    expect(quietHoursFromEnv({ QUIET_HOURS_START: '21:30', QUIET_HOURS_END: '07:15' })).toEqual({
      startMinutes: 1290,
      endMinutes: 435,
    });
  });
});
