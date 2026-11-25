import { describe, expect, it } from 'vitest';
import { resolveConfig } from './resolve';
import type { CaseContext } from './schema';

const base: CaseContext = {
  practice: {
    id: 'practice-1',
    settings: { businessHours: '8-5', npoHours: 6, displayName: 'Synthetic Foot Clinic' },
  },
};

describe('resolveConfig', () => {
  it('facility prep rule beats location default', () => {
    const r = resolveConfig({
      ...base,
      location: { id: 'loc-1', settings: { npoHours: 8 } },
      facility: { id: 'fac-1', settings: { npoHours: 12 } },
    });
    expect(r.npoHours).toEqual({ value: 12, source: 'facility', sourceId: 'fac-1' });
  });

  it('falls back to practice when no location override', () => {
    const r = resolveConfig({ ...base, location: { id: 'loc-1', settings: {} } });
    expect(r.businessHours).toEqual({ value: '8-5', source: 'practice', sourceId: 'practice-1' });
  });

  it('location wins identity over practice, and facility does not', () => {
    const r = resolveConfig({
      ...base,
      location: { id: 'loc-1', settings: { phoneNumber: '555-0100', displayName: 'Downtown' } },
      facility: { id: 'fac-1', settings: { phoneNumber: '555-0199' } },
    });
    expect(r.phoneNumber?.source).toBe('location');
    expect(r.displayName).toEqual({ value: 'Downtown', source: 'location', sourceId: 'loc-1' });
  });

  it('surgeon wins case preferences; unknown keys are preferences', () => {
    const r = resolveConfig({
      practice: { id: 'p', settings: { preferredAnesthesia: 'general', custom: 1 } },
      facility: { id: 'f', settings: { preferredAnesthesia: 'mac' } },
      surgeon: { id: 's', settings: { preferredAnesthesia: 'local', custom: 2 } },
    });
    expect(r.preferredAnesthesia).toEqual({ value: 'local', source: 'surgeon', sourceId: 's' });
    expect(r.custom?.source).toBe('surgeon');
  });

  it('surgeon cannot override prep or identity', () => {
    const r = resolveConfig({
      ...base,
      surgeon: { id: 's', settings: { npoHours: 2, phoneNumber: 'x' } },
    });
    expect(r.npoHours?.source).toBe('practice');
    expect(r.phoneNumber).toBeUndefined();
  });

  it('undefined falls through, null is an explicit value', () => {
    const r = resolveConfig({
      practice: { id: 'p', settings: { npoHours: 6, arrivalInstructions: 'Front desk' } },
      facility: { id: 'f', settings: { npoHours: undefined, arrivalInstructions: null } },
    });
    expect(r.npoHours?.source).toBe('practice');
    expect(r.arrivalInstructions).toEqual({ value: null, source: 'facility', sourceId: 'f' });
  });

  it('does not mutate input and is deterministic', () => {
    const ctx = structuredClone(base);
    expect(resolveConfig(ctx)).toEqual(resolveConfig(ctx));
    expect(ctx).toEqual(base);
  });
});
