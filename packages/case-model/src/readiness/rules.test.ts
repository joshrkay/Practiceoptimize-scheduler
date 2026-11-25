import { describe, expect, it } from 'vitest';
import { fixtureCases } from './fixtures/cases.js';
import { DEMO_ASC_ID, PODIATRY_PRACTICE_ID, demoAscRules, podiatryPracticeRules } from './fixtures/podiatry-rules.js';
import { InMemoryReadinessSettings } from './ports.js';
import type { ReadinessRule } from './rules.js';
import { matchesRule, validateRule } from './rules.js';

const valid: ReadinessRule = {
  id: 'rule-x',
  practiceId: PODIATRY_PRACTICE_ID,
  version: 1,
  source: 'practice',
  description: 'x',
  enabled: true,
  patientFacing: false,
  when: {},
  item: { key: 'x', type: 'lab', label: 'X', owner: 'agent', dueDaysBeforeSurgery: 0, validityDays: 30 },
};

describe('validateRule', () => {
  it('accepts every fixture rule', () => {
    for (const rule of [...podiatryPracticeRules, ...demoAscRules]) expect(validateRule(rule)).toEqual([]);
  });

  it('reports every problem', () => {
    const bad = {
      ...valid,
      id: '',
      practiceId: '',
      version: 0,
      source: 'facility',
      when: { riskFlags: [] },
      item: { key: '', label: '', type: 'magic', owner: 'robot', dueDaysBeforeSurgery: 1.5, validityDays: 0 },
    } as unknown as ReadinessRule;
    expect(validateRule(bad)).toEqual([
      'id is required',
      'practiceId is required',
      'version must be a positive integer',
      'facility rules need a facilityId',
      'item.key is required',
      'item.label is required',
      'unknown item.type: magic',
      'unknown item.owner: robot',
      'item.dueDaysBeforeSurgery must be a non-negative integer',
      'item.validityDays must be a positive integer',
      'when.riskFlags must not be empty',
    ]);
  });

  it('rejects a facility ID on a practice rule', () => {
    expect(validateRule({ ...valid, facilityId: DEMO_ASC_ID })).toEqual(['practice rules take no facilityId']);
  });
});

describe('matchesRule', () => {
  const c = fixtureCases.bunionectomyAscDiabetic();

  it('matches when every condition matches and any value within a condition matches', () => {
    expect(matchesRule({ ...valid, when: { riskFlags: ['vascular_disease', 'diabetes'], sitesOfService: ['asc'] } }, c)).toBe(true);
  });

  it.each([
    ['site of service', { sitesOfService: ['office_procedure_room' as const] }],
    ['anesthesia', { anesthesia: ['general' as const] }],
    ['case type', { caseTypes: ['self_pay' as const] }],
    ['authorization', { authorizationRequired: false }],
    ['in-house DME', { inHouseDme: true }],
    ['procedure tag', { procedureTags: ['fusion'] }],
  ])('does not match on a different %s', (_label, when) => {
    expect(matchesRule({ ...valid, when }, c)).toBe(false);
  });
});

describe('InMemoryReadinessSettings', () => {
  it('resolves practice rules and the facility rules of one facility', async () => {
    const port = new InMemoryReadinessSettings();
    port.setPracticeRules(PODIATRY_PRACTICE_ID, podiatryPracticeRules);
    port.setFacilityRules(PODIATRY_PRACTICE_ID, DEMO_ASC_ID, demoAscRules);
    const asc = await port.resolve(PODIATRY_PRACTICE_ID, DEMO_ASC_ID);
    expect(asc.practiceRules).toHaveLength(podiatryPracticeRules.length);
    expect(asc.facilityRules).toHaveLength(demoAscRules.length);
    const other = await port.resolve('practice-other', DEMO_ASC_ID);
    expect(other).toEqual({ practiceId: 'practice-other', practiceRules: [], facilityRules: [] });
  });
});
