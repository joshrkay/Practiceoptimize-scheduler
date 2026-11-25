import { describe, expect, it } from 'vitest';
import { InvalidCronError, nextCronRun, parseCron } from './cron.js';

const next = (expr: string, after: string, tz?: string) => nextCronRun(parseCron(expr), new Date(after), tz).toISOString();

describe('cron', () => {
  it('finds the next matching minute in UTC', () => {
    expect(next('*/15 * * * *', '2026-03-02T10:07:30Z')).toBe('2026-03-02T10:15:00.000Z');
    expect(next('*/15 * * * *', '2026-03-02T10:15:00Z')).toBe('2026-03-02T10:30:00.000Z');
    expect(next('0 2 * * *', '2026-03-02T02:00:00Z')).toBe('2026-03-03T02:00:00.000Z');
    expect(next('30 9 1 * *', '2026-03-02T00:00:00Z')).toBe('2026-04-01T09:30:00.000Z');
    expect(next('0 8 * * 1-5', '2026-03-06T09:00:00Z')).toBe('2026-03-09T08:00:00.000Z'); // Fri -> Mon
    expect(next('0 0 * 12 7', '2026-03-02T00:00:00Z')).toBe('2026-12-06T00:00:00.000Z'); // 7 = Sunday
    expect(next('5,10 4 * * *', '2026-03-02T04:06:00Z')).toBe('2026-03-02T04:10:00.000Z');
    expect(next('0 0 10-20/5 * *', '2026-03-11T00:00:00Z')).toBe('2026-03-15T00:00:00.000Z');
  });

  it('matches either day field when both are restricted', () => {
    // The 15th or any Monday.
    expect(next('0 12 15 * 1', '2026-03-03T00:00:00Z')).toBe('2026-03-09T12:00:00.000Z');
    expect(next('0 12 15 * 1', '2026-03-10T00:00:00Z')).toBe('2026-03-15T12:00:00.000Z');
  });

  it("runs at the practice's local time across daylight saving", () => {
    // 2 a.m. Chicago is 08:00Z in winter (CST) and 07:00Z in summer (CDT).
    expect(next('0 2 * * *', '2026-03-01T12:00:00Z', 'America/Chicago')).toBe('2026-03-02T08:00:00.000Z');
    expect(next('0 2 * * *', '2026-03-09T12:00:00Z', 'America/Chicago')).toBe('2026-03-10T07:00:00.000Z');
    // 2026-03-08 has no 02:00 in Chicago; that day is skipped.
    expect(next('0 2 * * *', '2026-03-07T12:00:00Z', 'America/Chicago')).toBe('2026-03-09T07:00:00.000Z');
    // Half-hour zones work too.
    expect(next('0 6 * * *', '2026-03-02T00:00:00Z', 'Asia/Kolkata')).toBe('2026-03-02T00:30:00.000Z');
  });

  it('rejects malformed expressions', () => {
    for (const bad of ['* * * *', '60 * * * *', '* 24 * * *', '*/0 * * * *', 'a * * * *', '5-1 * * * *', '* * 0 * *']) {
      expect(() => parseCron(bad), bad).toThrow(InvalidCronError);
    }
  });

  it('gives up on expressions that never match', () => {
    expect(() => next('0 0 31 2 *', '2026-01-01T00:00:00Z')).toThrow(/never matches/);
  });

  it('treats a single value with a step as a range to the maximum', () => {
    expect(next('50/5 * * * *', '2026-03-02T10:51:00Z')).toBe('2026-03-02T10:55:00.000Z');
  });
});
