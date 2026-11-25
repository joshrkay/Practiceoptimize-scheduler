/**
 * Practice rule edits as pure state transitions.
 *
 * Every edit produces a change-log entry recording who changed the rule and why. Edits to
 * patient-facing rules wait for the practice's clinician sign-off before they take effect.
 * Persisting the rule set and change log, and the admin editor, are wired up elsewhere.
 */
import type { ReadinessChecklist, RegenerationResult } from './generate.js';
import { regenerateChecklist } from './generate.js';
import type { PracticeId, ReadinessCase, ResolvedReadinessSettings } from './ports.js';
import type { ReadinessRule } from './rules.js';
import { validateRule } from './rules.js';

export interface RuleActor {
  userId: string;
  practiceId: PracticeId;
  role: 'practice_admin' | 'clinician' | 'scheduler';
}

export type RuleChangeStatus = 'applied' | 'pending_clinician_sign_off';

export interface RuleChangeLogEntry {
  changeId: string;
  practiceId: PracticeId;
  ruleId: string;
  action: 'create' | 'update';
  fromVersion: number | null;
  toVersion: number;
  changedBy: string;
  reason: string;
  at: string;
  before: ReadinessRule | null;
  after: ReadinessRule;
  status: RuleChangeStatus;
  signedOffBy?: string;
  signedOffAt?: string;
}

/** All readiness rules a practice owns (practice-wide and per facility) plus their change log. */
export interface ReadinessRuleSet {
  practiceId: PracticeId;
  rules: readonly ReadinessRule[];
  changeLog: readonly RuleChangeLogEntry[];
}

export interface RuleEdit {
  changeId: string;
  actor: RuleActor;
  reason: string;
  at: string;
  /** The rule as it should read after the edit. Its version is assigned here. */
  rule: Omit<ReadinessRule, 'version'>;
}

export interface RuleChangeResult {
  ruleSet: ReadinessRuleSet;
  entry: RuleChangeLogEntry;
}

export class RuleChangeRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuleChangeRejectedError';
  }
}

function reject(message: string): never {
  throw new RuleChangeRejectedError(message);
}

function replaceRule(rules: readonly ReadinessRule[], rule: ReadinessRule): ReadinessRule[] {
  const others = rules.filter((r) => r.id !== rule.id);
  return [...others, rule];
}

/** Records a practice admin's edit; it applies at once unless the rule is patient-facing. */
export function proposeRuleChange(ruleSet: ReadinessRuleSet, edit: RuleEdit): RuleChangeResult {
  const { actor } = edit;
  if (actor.practiceId !== ruleSet.practiceId || edit.rule.practiceId !== ruleSet.practiceId) {
    reject('A practice can only edit its own readiness rules');
  }
  if (actor.role !== 'practice_admin') reject('Only a practice admin can edit readiness rules');
  if (!edit.reason.trim()) reject('A reason is required for every readiness rule change');
  if (ruleSet.changeLog.some((e) => e.changeId === edit.changeId)) reject(`Change ${edit.changeId} already exists`);
  if (ruleSet.changeLog.some((e) => e.ruleId === edit.rule.id && e.status === 'pending_clinician_sign_off')) {
    reject(`Rule ${edit.rule.id} already has a change waiting for clinician sign-off`);
  }

  const before = ruleSet.rules.find((r) => r.id === edit.rule.id) ?? null;
  const after: ReadinessRule = { ...edit.rule, version: (before?.version ?? 0) + 1 };
  const problems = validateRule(after);
  if (problems.length > 0) reject(`Invalid readiness rule: ${problems.join('; ')}`);

  const needsSignOff = after.patientFacing || before?.patientFacing === true;
  const entry: RuleChangeLogEntry = {
    changeId: edit.changeId,
    practiceId: ruleSet.practiceId,
    ruleId: after.id,
    action: before === null ? 'create' : 'update',
    fromVersion: before?.version ?? null,
    toVersion: after.version,
    changedBy: actor.userId,
    reason: edit.reason.trim(),
    at: edit.at,
    before,
    after,
    status: needsSignOff ? 'pending_clinician_sign_off' : 'applied',
  };
  return {
    entry,
    ruleSet: {
      practiceId: ruleSet.practiceId,
      rules: needsSignOff ? ruleSet.rules : replaceRule(ruleSet.rules, after),
      changeLog: [...ruleSet.changeLog, entry],
    },
  };
}

/** A clinician of the practice signs off a pending patient-facing change, which then takes effect. */
export function signOffRuleChange(
  ruleSet: ReadinessRuleSet,
  changeId: string,
  clinician: RuleActor,
  at: string,
): RuleChangeResult {
  if (clinician.practiceId !== ruleSet.practiceId) reject('A practice can only sign off its own readiness rules');
  if (clinician.role !== 'clinician') reject('Only a practice clinician can sign off patient-facing rules');
  const pending = ruleSet.changeLog.find((e) => e.changeId === changeId);
  if (pending === undefined) reject(`Unknown change ${changeId}`);
  if (pending.status !== 'pending_clinician_sign_off') reject(`Change ${changeId} is not waiting for sign-off`);

  const entry: RuleChangeLogEntry = { ...pending, status: 'applied', signedOffBy: clinician.userId, signedOffAt: at };
  return {
    entry,
    ruleSet: {
      practiceId: ruleSet.practiceId,
      rules: replaceRule(ruleSet.rules, pending.after),
      changeLog: ruleSet.changeLog.map((e) => (e.changeId === changeId ? entry : e)),
    },
  };
}

/** Changes waiting for clinician sign-off. */
export function pendingSignOffs(ruleSet: ReadinessRuleSet): RuleChangeLogEntry[] {
  return ruleSet.changeLog.filter((e) => e.status === 'pending_clinician_sign_off');
}

/** The rules from a practice's rule set that apply at one facility. */
export function settingsForFacility(ruleSet: ReadinessRuleSet, facilityId: string): ResolvedReadinessSettings {
  return {
    practiceId: ruleSet.practiceId,
    practiceRules: ruleSet.rules.filter((r) => r.source === 'practice'),
    facilityRules: ruleSet.rules.filter((r) => r.source === 'facility' && r.facilityId === facilityId),
  };
}

export interface OpenCase {
  case: ReadinessCase;
  checklist: ReadinessChecklist | undefined;
}

/** Regenerates every open case's checklist against the practice's current rules. */
export function regenerateOpenCases(
  ruleSet: ReadinessRuleSet,
  openCases: readonly OpenCase[],
  now: string,
): RegenerationResult[] {
  return openCases.map(({ case: c, checklist }) =>
    regenerateChecklist(checklist, c, settingsForFacility(ruleSet, c.facilityId), now),
  );
}
