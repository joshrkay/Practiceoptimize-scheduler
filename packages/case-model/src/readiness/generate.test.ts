import { describe, expect, it } from 'vitest';
import { addDays, toDayNumber } from './dates.js';
import { fixtureCases } from './fixtures/cases.js';
import { DEMO_ASC_ID, PODIATRY_PRACTICE_ID, demoAscRules, podiatryPracticeRules } from './fixtures/podiatry-rules.js';
import type { ReadinessChecklist, ReadinessItem } from './generate.js';
import {
  InvalidReadinessRuleError,
  completeItem,
  generateChecklist,
  isEvidenceValid,
  regenerateChecklist,
} from './generate.js';
import type { ReadinessCase, ResolvedReadinessSettings } from './ports.js';
import type { ReadinessRule } from './rules.js';

const NOW = '2026-11-25T15:00:00Z';

function settings(facilityRules: readonly ReadinessRule[] = demoAscRules): ResolvedReadinessSettings {
  return { practiceId: PODIATRY_PRACTICE_ID, practiceRules: podiatryPracticeRules, facilityRules };
}

function checklistFor(c: ReadinessCase, s: ResolvedReadinessSettings = settings()): ReadinessChecklist {
  const result = generateChecklist(c, s, NOW);
  if (result.kind !== 'checklist') throw new Error('expected a checklist');
  return result.checklist;
}

function keys(checklist: ReadinessChecklist): string[] {
  return checklist.items.map((i) => i.key).sort();
}

function item(checklist: ReadinessChecklist, key: string): ReadinessItem {
  const found = checklist.items.find((i) => i.key === key);
  if (found === undefined) throw new Error(`missing ${key}`);
  return found;
}

const ascNeuroma = () =>
  fixtureCases.neuromaOfficeLocal({ siteOfService: 'asc', facilityId: DEMO_ASC_ID, anesthesia: 'mac' });

function rule(overrides: Partial<ReadinessRule> & Pick<ReadinessRule, 'id' | 'item'>): ReadinessRule {
  return {
    practiceId: PODIATRY_PRACTICE_ID,
    version: 1,
    source: 'practice',
    description: 'test rule',
    enabled: true,
    patientFacing: false,
    when: {},
    ...overrides,
  };
}

describe('generateChecklist', () => {
  describe('scenario 1: office versus ASC', () => {
    it('gives the office case under local no anesthesia packet or H&P', () => {
      const checklist = checklistFor(fixtureCases.neuromaOfficeLocal());
      expect(keys(checklist)).toEqual(['consent.surgical', 'dme.dispense', 'instructions.preop']);
      expect(checklist.items.some((i) => i.type === 'anesthesia_packet' || i.type === 'history_and_physical')).toBe(false);
    });

    it('gives the same procedure at the ASC both items', () => {
      const checklist = checklistFor(ascNeuroma());
      expect(keys(checklist)).toEqual(
        expect.arrayContaining(['anesthesia.packet', 'hp', 'consent.surgical', 'instructions.preop']),
      );
      expect(item(checklist, 'anesthesia.packet')).toMatchObject({ owner: 'patient', dueDate: '2027-01-13' });
    });

    it('gives an office case under sedation the anesthesia packet but no H&P', () => {
      const checklist = checklistFor(fixtureCases.neuromaOfficeLocal({ anesthesia: 'mac' }));
      expect(keys(checklist)).toContain('anesthesia.packet');
      expect(keys(checklist)).not.toContain('hp');
    });
  });

  describe('scenario 2: diabetic patient', () => {
    it('adds an A1c within the rule window and a PCP clearance', () => {
      const checklist = checklistFor(fixtureCases.bunionectomyAscDiabetic());
      expect(item(checklist, 'lab.a1c')).toEqual({
        key: 'lab.a1c',
        type: 'lab',
        label: 'Hemoglobin A1c',
        owner: 'agent',
        dueDate: '2027-02-03',
        validityDays: 90,
        validFrom: '2026-11-12',
        ruleId: 'rule-diabetes-a1c',
        ruleVersion: 1,
        source: 'practice',
        status: 'open',
      });
      expect(item(checklist, 'clearance.pcp')).toMatchObject({ type: 'clearance', validityDays: 30 });
      expect(item(checklist, 'lab.glucose')).toMatchObject({ source: 'facility', dueDate: '2027-02-10' });
      expect(item(checklist, 'authorization')).toMatchObject({ owner: 'agent' });
    });
  });

  it('adds a vascular study, a cessation plan for a smoker having a fusion, and DME on surgery day', () => {
    const checklist = checklistFor(fixtureCases.flatfootReconAscSmoker());
    expect(item(checklist, 'imaging.vascular')).toMatchObject({ type: 'imaging_study', validityDays: 180 });
    expect(item(checklist, 'smoking.cessation')).toMatchObject({ owner: 'surgeon', dueDate: '2027-02-03' });
    expect(item(checklist, 'dme.dispense')).toMatchObject({ dueDate: '2027-03-03', type: 'dme_dispensing' });
    expect(keys(checklist)).not.toContain('lab.a1c');
  });

  it('adds no cessation plan for a smoker whose procedure is not a fusion', () => {
    const checklist = checklistFor(fixtureCases.bunionectomyAscDiabetic({ riskFlags: ['smoker'] }));
    expect(keys(checklist)).not.toContain('smoking.cessation');
  });

  it('adds quote, deposit and financial consent for self-pay and no authorization', () => {
    const checklist = checklistFor(fixtureCases.selfPayCosmeticToe());
    expect(keys(checklist)).toEqual(
      expect.arrayContaining(['financial.quote', 'financial.consent', 'financial.deposit']),
    );
    expect(keys(checklist)).not.toContain('authorization');
    expect(item(checklist, 'financial.quote')).toMatchObject({ owner: 'scheduler', dueDate: '2027-01-06' });
  });

  it('adds both financial items and authorization for a mixed case that needs one', () => {
    const checklist = checklistFor(fixtureCases.bunionectomyAscDiabetic({ caseType: 'mixed' }));
    expect(keys(checklist)).toEqual(expect.arrayContaining(['financial.quote', 'authorization']));
  });

  it('adds no authorization when the payer does not require one', () => {
    expect(keys(checklistFor(fixtureCases.neuromaOfficeLocal()))).not.toContain('authorization');
  });

  it('orders items by due date then key', () => {
    const dates = checklistFor(fixtureCases.flatfootReconAscSmoker()).items.map((i) => toDayNumber(i.dueDate));
    expect(dates).toEqual([...dates].sort((a, b) => a - b));
  });

  it('gives urgent add-ons no checklist', () => {
    const result = generateChecklist(fixtureCases.bunionectomyAscDiabetic({ urgency: 'urgent_add_on' }), settings(), NOW);
    expect(result).toEqual({ kind: 'not_required', caseId: 'case-demo-bunion-002', reason: 'urgent_add_on' });
  });

  it('lets facility rules win over practice rules for the same item', () => {
    const hp = item(checklistFor(ascNeuroma()), 'hp');
    expect(hp).toMatchObject({ source: 'facility', ruleId: 'rule-asc-hp-14', validityDays: 14, dueDate: '2027-01-18' });
    const practiceOnly = item(checklistFor(ascNeuroma(), settings([])), 'hp');
    expect(practiceOnly).toMatchObject({ source: 'practice', validityDays: 30 });
  });

  it('takes the strictest due date and expiry window when several rules add the same item', () => {
    const rules = [
      rule({ id: 'b', item: { key: 'x', type: 'lab', label: 'X', owner: 'agent', dueDaysBeforeSurgery: 10 } }),
      rule({ id: 'a', item: { key: 'x', type: 'lab', label: 'X', owner: 'agent', dueDaysBeforeSurgery: 5, validityDays: 30 } }),
      rule({ id: 'c', item: { key: 'x', type: 'lab', label: 'X', owner: 'agent', dueDaysBeforeSurgery: 10, validityDays: 60 } }),
    ];
    const checklist = checklistFor(fixtureCases.neuromaOfficeLocal(), {
      practiceId: PODIATRY_PRACTICE_ID,
      practiceRules: rules,
      facilityRules: [],
    });
    expect(checklist.items).toHaveLength(1);
    expect(checklist.items[0]).toMatchObject({ ruleId: 'c', dueDate: '2027-01-10', validityDays: 30 });
  });

  it('matches on procedure code and payer', () => {
    const rules = [
      rule({ id: 'code', when: { procedureCodes: ['28080'] }, item: { key: 'code', type: 'other', label: 'c', owner: 'scheduler', dueDaysBeforeSurgery: 1 } }),
      rule({ id: 'payer', when: { payerIds: ['payer-demo-commercial'] }, item: { key: 'payer', type: 'other', label: 'p', owner: 'scheduler', dueDaysBeforeSurgery: 1 } }),
    ];
    const s = { practiceId: PODIATRY_PRACTICE_ID, practiceRules: rules, facilityRules: [] };
    expect(keys(checklistFor(fixtureCases.neuromaOfficeLocal(), s))).toEqual(['code', 'payer']);
    expect(keys(checklistFor(fixtureCases.selfPayCosmeticToe(), s))).toEqual([]);
  });

  it('ignores disabled rules, other practices and other facilities', () => {
    const template = { key: 'x', type: 'other' as const, label: 'X', owner: 'scheduler' as const, dueDaysBeforeSurgery: 1 };
    const s: ResolvedReadinessSettings = {
      practiceId: PODIATRY_PRACTICE_ID,
      practiceRules: [
        rule({ id: 'off', enabled: false, item: template }),
        rule({ id: 'other', practiceId: 'practice-other', item: template }),
      ],
      facilityRules: [rule({ id: 'fac', source: 'facility', facilityId: 'facility-elsewhere', item: template })],
    };
    expect(checklistFor(ascNeuroma(), s).items).toEqual([]);
  });

  it('refuses settings from another practice', () => {
    expect(() =>
      generateChecklist(fixtureCases.neuromaOfficeLocal(), { ...settings(), practiceId: 'practice-other' }, NOW),
    ).toThrow(/cannot be applied/);
  });

  it('refuses an invalid rule', () => {
    const bad = rule({ id: 'bad', item: { key: 'x', type: 'lab', label: 'X', owner: 'agent', dueDaysBeforeSurgery: -1 } });
    const s = { practiceId: PODIATRY_PRACTICE_ID, practiceRules: [bad], facilityRules: [] };
    expect(() => generateChecklist(fixtureCases.neuromaOfficeLocal(), s, NOW)).toThrow(InvalidReadinessRuleError);
  });
});

describe('regenerateChecklist', () => {
  it('adds every item when there is no previous checklist', () => {
    const result = regenerateChecklist(undefined, fixtureCases.neuromaOfficeLocal(), settings(), NOW);
    expect(result.changes.added.sort()).toEqual(['consent.surgical', 'dme.dispense', 'instructions.preop']);
  });

  it('keeps a completed item that is still inside its window when the date moves', () => {
    const c = fixtureCases.bunionectomyAscDiabetic();
    const done = completeItem(checklistFor(c), 'lab.a1c', '2027-01-02T10:00:00Z', '2027-01-01');
    const moved = regenerateChecklist(done, { ...c, surgeryDate: '2027-02-24' }, settings(), NOW);
    if (moved.kind !== 'checklist') throw new Error('expected a checklist');
    expect(moved.changes.kept).toEqual(['lab.a1c']);
    expect(item(moved.checklist, 'lab.a1c')).toMatchObject({
      status: 'complete',
      evidenceDate: '2027-01-01',
      completedAt: '2027-01-02T10:00:00Z',
      dueDate: '2027-02-17',
    });
  });

  it('reopens a completed item whose evidence falls outside the window after the date moves', () => {
    const c = fixtureCases.bunionectomyAscDiabetic();
    const done = completeItem(checklistFor(c), 'lab.a1c', '2027-01-02T10:00:00Z', '2027-01-01');
    const moved = regenerateChecklist(done, { ...c, surgeryDate: '2027-05-01' }, settings(), NOW);
    if (moved.kind !== 'checklist') throw new Error('expected a checklist');
    expect(moved.changes.invalidated).toEqual(['lab.a1c']);
    expect(item(moved.checklist, 'lab.a1c').status).toBe('open');
  });

  it('drops items no longer required when the site moves from ASC to office', () => {
    const asc = ascNeuroma();
    const done = completeItem(checklistFor(asc), 'consent.surgical', '2026-12-01T09:00:00Z');
    const office = fixtureCases.neuromaOfficeLocal();
    const result = regenerateChecklist(done, office, settings(), NOW);
    if (result.kind !== 'checklist') throw new Error('expected a checklist');
    expect(result.changes.removed).toEqual(['anesthesia.packet', 'hp']);
    expect(result.changes.kept).toEqual(['consent.surgical']);
    expect(item(result.checklist, 'consent.surgical')).toMatchObject({ status: 'complete', completedAt: '2026-12-01T09:00:00Z' });
    expect(item(result.checklist, 'consent.surgical').evidenceDate).toBeUndefined();
  });

  it('adds risk items when a risk flag is added and keeps open items open', () => {
    const c = fixtureCases.neuromaOfficeLocal();
    const result = regenerateChecklist(checklistFor(c), { ...c, riskFlags: ['vascular_disease'] }, settings(), NOW);
    expect(result.changes).toEqual({ added: ['imaging.vascular'], removed: [], kept: [], invalidated: [] });
  });

  it('clears the checklist when a case becomes an urgent add-on', () => {
    const c = fixtureCases.neuromaOfficeLocal();
    const result = regenerateChecklist(checklistFor(c), { ...c, urgency: 'urgent_add_on' }, settings(), NOW);
    expect(result.kind).toBe('not_required');
    expect(result.changes.removed).toEqual(['consent.surgical', 'dme.dispense', 'instructions.preop']);
  });

  it('refuses a checklist from another case', () => {
    const other = checklistFor(fixtureCases.selfPayCosmeticToe());
    expect(() => regenerateChecklist(other, fixtureCases.neuromaOfficeLocal(), settings(), NOW)).toThrow(/cannot be regenerated/);
  });
});

describe('completeItem and evidence windows', () => {
  it('refuses an unknown item', () => {
    expect(() => completeItem(checklistFor(fixtureCases.neuromaOfficeLocal()), 'nope', NOW)).toThrow(/no item/);
  });

  it('refuses evidence outside the expiry window', () => {
    const checklist = checklistFor(fixtureCases.bunionectomyAscDiabetic());
    expect(() => completeItem(checklist, 'lab.a1c', NOW, '2026-10-01')).toThrow(/outside the 90-day window/);
  });

  it('uses the completion date as evidence when none is given', () => {
    const checklist = completeItem(checklistFor(fixtureCases.bunionectomyAscDiabetic()), 'lab.a1c', NOW);
    expect(item(checklist, 'lab.a1c')).toMatchObject({ status: 'complete', completedAt: NOW });
  });

  it('treats evidence after surgery or missing evidence as invalid when there is a window', () => {
    expect(isEvidenceValid('2027-02-11', 90, '2027-02-10')).toBe(false);
    expect(isEvidenceValid(undefined, 90, '2027-02-10')).toBe(false);
    expect(isEvidenceValid(undefined, undefined, '2027-02-10')).toBe(true);
    expect(isEvidenceValid(addDays('2027-02-10', -90), 90, '2027-02-10')).toBe(true);
  });

  it('rejects malformed dates', () => {
    expect(() => toDayNumber('2027-02-30')).toThrow(/Invalid ISO date/);
    expect(() => toDayNumber('soon')).toThrow(/Invalid ISO date/);
  });
});
