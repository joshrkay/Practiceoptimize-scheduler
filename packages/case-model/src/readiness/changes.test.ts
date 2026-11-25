import { describe, expect, it } from 'vitest';
import type { ReadinessRuleSet, RuleActor, RuleEdit } from './changes.js';
import {
  RuleChangeRejectedError,
  pendingSignOffs,
  proposeRuleChange,
  regenerateOpenCases,
  settingsForFacility,
  signOffRuleChange,
} from './changes.js';
import { fixtureCases } from './fixtures/cases.js';
import { DEMO_ASC_ID, PODIATRY_PRACTICE_ID, demoAscRules, podiatryPracticeRules } from './fixtures/podiatry-rules.js';
import { completeItem, generateChecklist } from './generate.js';
import type { ReadinessChecklist } from './generate.js';
import type { ReadinessCase } from './ports.js';
import type { ReadinessRule } from './rules.js';

const NOW = '2026-11-25T15:00:00Z';
const admin: RuleActor = { userId: 'user-admin-1', practiceId: PODIATRY_PRACTICE_ID, role: 'practice_admin' };
const clinician: RuleActor = { userId: 'user-clinician-1', practiceId: PODIATRY_PRACTICE_ID, role: 'clinician' };

function ruleSet(): ReadinessRuleSet {
  return { practiceId: PODIATRY_PRACTICE_ID, rules: [...podiatryPracticeRules, ...demoAscRules], changeLog: [] };
}

function findRule(set: ReadinessRuleSet, id: string): ReadinessRule {
  const found = set.rules.find((r) => r.id === id);
  if (found === undefined) throw new Error(`missing ${id}`);
  return found;
}

function edit(set: ReadinessRuleSet, id: string, change: (r: ReadinessRule) => ReadinessRule, extra: Partial<RuleEdit> = {}): RuleEdit {
  const { version: _version, ...rule } = change(findRule(set, id));
  return { changeId: `chg-${id}`, actor: admin, reason: 'Facility policy update', at: NOW, rule, ...extra };
}

function a1cWindow(days: number) {
  return (r: ReadinessRule): ReadinessRule => ({ ...r, item: { ...r.item, validityDays: days } });
}

function checklistFor(c: ReadinessCase, set: ReadinessRuleSet): ReadinessChecklist {
  const result = generateChecklist(c, settingsForFacility(set, c.facilityId), NOW);
  if (result.kind !== 'checklist') throw new Error('expected a checklist');
  return result.checklist;
}

describe('scenario 3: a practice admin edits a rule', () => {
  it('logs who and why and regenerates open cases with the new window', () => {
    const before = ruleSet();
    const diabetic = fixtureCases.bunionectomyAscDiabetic();
    // A1c drawn 75 days before surgery: valid under 90 days, not under 60.
    const done = completeItem(checklistFor(diabetic, before), 'lab.a1c', '2026-11-27T12:00:00Z', '2026-11-27');
    const otherDiabetic = fixtureCases.flatfootReconAscSmoker({ riskFlags: ['diabetes'] });
    const otherChecklist = checklistFor(otherDiabetic, before);

    const { ruleSet: after, entry } = proposeRuleChange(
      before,
      edit(before, 'rule-diabetes-a1c', a1cWindow(60), { reason: 'Our ASC now requires an A1c within 60 days' }),
    );

    expect(entry).toMatchObject({
      changeId: 'chg-rule-diabetes-a1c',
      practiceId: PODIATRY_PRACTICE_ID,
      ruleId: 'rule-diabetes-a1c',
      action: 'update',
      fromVersion: 1,
      toVersion: 2,
      changedBy: 'user-admin-1',
      reason: 'Our ASC now requires an A1c within 60 days',
      at: NOW,
      status: 'applied',
    });
    expect(entry.before?.item.validityDays).toBe(90);
    expect(entry.after.item.validityDays).toBe(60);
    expect(after.changeLog).toEqual([entry]);
    expect(findRule(after, 'rule-diabetes-a1c').version).toBe(2);

    const [first, second] = regenerateOpenCases(
      after,
      [
        { case: diabetic, checklist: done },
        { case: otherDiabetic, checklist: otherChecklist },
      ],
      NOW,
    );
    if (first?.kind !== 'checklist' || second?.kind !== 'checklist') throw new Error('expected checklists');
    expect(first.changes.invalidated).toEqual(['lab.a1c']);
    const a1c = first.checklist.items.find((i) => i.key === 'lab.a1c');
    expect(a1c).toMatchObject({ status: 'open', validityDays: 60, validFrom: '2026-12-12', ruleVersion: 2 });
    expect(second.checklist.items.find((i) => i.key === 'lab.a1c')).toMatchObject({ validityDays: 60 });
  });

  it('records a new rule as a create', () => {
    const set = ruleSet();
    const { entry, ruleSet: after } = proposeRuleChange(set, {
      changeId: 'chg-new',
      actor: admin,
      reason: 'Add post-op shoe fitting',
      at: NOW,
      rule: {
        id: 'rule-new',
        practiceId: PODIATRY_PRACTICE_ID,
        source: 'practice',
        description: 'Post-op shoe fitting',
        enabled: true,
        patientFacing: false,
        when: { procedureTags: ['bunionectomy'] },
        item: { key: 'dme.shoe', type: 'other', label: 'Post-op shoe', owner: 'scheduler', dueDaysBeforeSurgery: 2 },
      },
    });
    expect(entry).toMatchObject({ action: 'create', fromVersion: null, toVersion: 1, before: null });
    expect(findRule(after, 'rule-new').version).toBe(1);
  });
});

describe('rule change guardrails', () => {
  const set = ruleSet();
  const base = () => edit(set, 'rule-diabetes-a1c', a1cWindow(60));

  it.each([
    ['another practice', { actor: { ...admin, practiceId: 'practice-other' } }, /its own/],
    ['a non-admin', { actor: { ...admin, role: 'scheduler' as const } }, /practice admin/],
    ['an empty reason', { reason: '   ' }, /reason is required/],
  ])('rejects an edit from %s', (_label, extra, message) => {
    expect(() => proposeRuleChange(set, { ...base(), ...extra })).toThrow(message);
  });

  it('rejects an invalid rule and a reused change ID', () => {
    expect(() => proposeRuleChange(set, edit(set, 'rule-diabetes-a1c', a1cWindow(0)))).toThrow(RuleChangeRejectedError);
    const { ruleSet: after } = proposeRuleChange(set, base());
    expect(() => proposeRuleChange(after, base())).toThrow(/already exists/);
  });

  it('refuses to regenerate a case from another practice', () => {
    const foreign = fixtureCases.neuromaOfficeLocal({ practiceId: 'practice-other' });
    expect(() => regenerateOpenCases(set, [{ case: foreign, checklist: undefined }], NOW)).toThrow(/cannot be applied/);
  });
});

describe('patient-facing rules need clinician sign-off', () => {
  const set = ruleSet();
  const relabel = (r: ReadinessRule): ReadinessRule => ({ ...r, item: { ...r.item, label: 'Pre-op instructions (new)' } });
  const proposed = proposeRuleChange(set, edit(set, 'rule-preop-instructions', relabel));

  it('holds the change until a clinician signs off', () => {
    expect(proposed.entry.status).toBe('pending_clinician_sign_off');
    expect(findRule(proposed.ruleSet, 'rule-preop-instructions').version).toBe(1);
    expect(pendingSignOffs(proposed.ruleSet)).toEqual([proposed.entry]);
    const c = fixtureCases.neuromaOfficeLocal();
    const pendingItem = checklistFor(c, proposed.ruleSet).items.find((i) => i.key === 'instructions.preop');
    expect(pendingItem?.label).toBe('Pre-op instructions sent');

    const signed = signOffRuleChange(proposed.ruleSet, proposed.entry.changeId, clinician, '2026-11-26T09:00:00Z');
    expect(signed.entry).toMatchObject({ status: 'applied', signedOffBy: 'user-clinician-1', signedOffAt: '2026-11-26T09:00:00Z' });
    expect(findRule(signed.ruleSet, 'rule-preop-instructions')).toMatchObject({ version: 2, item: { label: 'Pre-op instructions (new)' } });
    expect(pendingSignOffs(signed.ruleSet)).toEqual([]);
    expect(signed.ruleSet.changeLog).toHaveLength(1);
    expect(() => signOffRuleChange(signed.ruleSet, proposed.entry.changeId, clinician, NOW)).toThrow(/not waiting/);
  });

  it('rejects a second edit while one is pending', () => {
    expect(() =>
      proposeRuleChange(proposed.ruleSet, { ...edit(set, 'rule-preop-instructions', relabel), changeId: 'chg-2' }),
    ).toThrow(/waiting for clinician sign-off/);
  });

  it.each([
    ['a non-clinician', { ...clinician, role: 'practice_admin' as const }, 'chg-rule-preop-instructions', /clinician can sign off/],
    ['another practice', { ...clinician, practiceId: 'practice-other' }, 'chg-rule-preop-instructions', /its own/],
    ['an unknown change', clinician, 'chg-missing', /Unknown change/],
  ])('rejects sign-off by %s', (_label, actor, changeId, message) => {
    expect(() => signOffRuleChange(proposed.ruleSet, changeId, actor, NOW)).toThrow(message);
  });
});

describe('settingsForFacility', () => {
  it('splits practice rules from the facility rules for one facility', () => {
    const s = settingsForFacility(ruleSet(), DEMO_ASC_ID);
    expect(s.practiceRules).toHaveLength(podiatryPracticeRules.length);
    expect(s.facilityRules.map((r) => r.id)).toEqual(demoAscRules.map((r) => r.id));
    expect(settingsForFacility(ruleSet(), 'facility-demo-office').facilityRules).toEqual([]);
  });
});
