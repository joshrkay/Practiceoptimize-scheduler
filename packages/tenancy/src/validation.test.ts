import { describe, expect, it } from 'vitest';
import {
  Checker,
  isIsoDate,
  isLocalTime,
  isUsStateCode,
  isValidNpi,
  isValidTimeZone,
  isValidTin,
  PracticeDataError,
} from './validation.js';

describe('practice field validation', () => {
  it('checks the NPI check digit', () => {
    expect(isValidNpi('1234567893')).toBe(true); // CMS worked example
    expect(isValidNpi('1999000015')).toBe(true);
    expect(isValidNpi('1234567890')).toBe(false);
    expect(isValidNpi('123456789')).toBe(false);
    expect(isValidNpi('12345678a3')).toBe(false);
  });

  it('checks TINs, time zones, states, dates and local times', () => {
    expect(isValidTin('741234501')).toBe(true);
    expect(isValidTin('001234567')).toBe(false);
    expect(isValidTin('74-1234501')).toBe(false);
    expect(isValidTimeZone('America/Denver')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('UTC')).toBe(false);
    expect(isUsStateCode('NM')).toBe(true);
    expect(isUsStateCode('ZZ')).toBe(false);
    expect(isIsoDate('2026-10-01')).toBe(true);
    expect(isIsoDate('2026-13-45')).toBe(false);
    expect(isIsoDate('10/01/2026')).toBe(false);
    expect(isLocalTime('07:30')).toBe(true);
    expect(isLocalTime('24:00')).toBe(false);
  });

  it('reports every issue at once', () => {
    const checker = new Checker().check(false, 'first').check(true, 'fine').check(false, 'second');
    expect(() => checker.throwIfInvalid()).toThrow(PracticeDataError);
    try {
      checker.throwIfInvalid();
    } catch (error) {
      expect((error as PracticeDataError).issues).toEqual(['first', 'second']);
    }
    expect(() => new Checker().check(true, 'ok').throwIfInvalid()).not.toThrow();
  });
});
