/**
 * Readiness checklist generation and regeneration.
 *
 * Pure functions: the case and the resolved rule sets come in, a checklist comes out.
 */
import { addDays, dateOf, toDayNumber } from './dates.js';
import type { IsoDate, PracticeId, ReadinessCase, ResolvedReadinessSettings } from './ports.js';
import type { ReadinessItemOwner, ReadinessItemType, ReadinessRule, RuleSource } from './rules.js';
import { matchesRule, validateRule } from './rules.js';

export type ReadinessItemStatus = 'open' | 'complete';

export interface ReadinessItem {
  key: string;
  type: ReadinessItemType;
  label: string;
  owner: ReadinessItemOwner;
  dueDate: IsoDate;
  /** Expiry window in days before surgery, when the item has one. */
  validityDays?: number;
  /** Earliest date evidence may carry and still count, when the item has an expiry window. */
  validFrom?: IsoDate;
  ruleId: string;
  ruleVersion: number;
  source: RuleSource;
  status: ReadinessItemStatus;
  /** When the item was marked complete (ISO timestamp). */
  completedAt?: string;
  /** Date of the evidence (for example the lab draw date); defaults to the completion date. */
  evidenceDate?: IsoDate;
}

export interface ReadinessChecklist {
  caseId: string;
  practiceId: PracticeId;
  surgeryDate: IsoDate;
  generatedAt: string;
  items: ReadinessItem[];
}

export type ChecklistResult =
  | { kind: 'checklist'; checklist: ReadinessChecklist }
  /** Urgent add-ons are approved by the surgeon's signed order and get no checklist (ADR-0007). */
  | { kind: 'not_required'; caseId: string; reason: 'urgent_add_on' };

export interface ChecklistChanges {
  added: string[];
  removed: string[];
  /** Completed items carried over because they are still valid. */
  kept: string[];
  /** Completed items reopened because their evidence falls outside the new expiry window. */
  invalidated: string[];
}

export type RegenerationResult =
  | { kind: 'checklist'; checklist: ReadinessChecklist; changes: ChecklistChanges }
  | { kind: 'not_required'; caseId: string; reason: 'urgent_add_on'; changes: ChecklistChanges };

export class InvalidReadinessRuleError extends Error {
  constructor(
    readonly ruleId: string,
    readonly problems: string[],
  ) {
    super(`Readiness rule ${ruleId} is invalid: ${problems.join('; ')}`);
    this.name = 'InvalidReadinessRuleError';
  }
}

function assertSamePractice(c: ReadinessCase, settings: ResolvedReadinessSettings): void {
  if (settings.practiceId !== c.practiceId) {
    throw new Error(`Readiness settings for practice ${settings.practiceId} cannot be applied to case ${c.caseId}`);
  }
}

function matching(rules: readonly ReadinessRule[], c: ReadinessCase): ReadinessRule[] {
  return rules.filter((rule) => {
    const problems = validateRule(rule);
    if (problems.length > 0) throw new InvalidReadinessRuleError(rule.id, problems);
    return matchesRule(rule, c);
  });
}

function groupByKey(rules: readonly ReadinessRule[]): Map<string, ReadinessRule[]> {
  const groups = new Map<string, ReadinessRule[]>();
  for (const rule of rules) {
    const group = groups.get(rule.item.key) ?? [];
    group.push(rule);
    groups.set(rule.item.key, group);
  }
  return groups;
}

function minValidity(rules: readonly ReadinessRule[]): number | undefined {
  const windows = rules.map((r) => r.item.validityDays).filter((d): d is number => d !== undefined);
  return windows.length > 0 ? Math.min(...windows) : undefined;
}

/** The strictest rule wins: earliest due date, then shortest expiry window, then rule ID. */
function strictest(rules: readonly ReadinessRule[]): ReadinessRule {
  const sorted = [...rules].sort(
    (a, b) =>
      b.item.dueDaysBeforeSurgery - a.item.dueDaysBeforeSurgery ||
      (a.item.validityDays ?? Infinity) - (b.item.validityDays ?? Infinity) ||
      a.id.localeCompare(b.id),
  );
  return sorted[0] as ReadinessRule;
}

function buildItem(rules: readonly ReadinessRule[], surgeryDate: IsoDate): ReadinessItem {
  const rule = strictest(rules);
  const validityDays = minValidity(rules);
  const item: ReadinessItem = {
    key: rule.item.key,
    type: rule.item.type,
    label: rule.item.label,
    owner: rule.item.owner,
    dueDate: addDays(surgeryDate, -rule.item.dueDaysBeforeSurgery),
    ruleId: rule.id,
    ruleVersion: rule.version,
    source: rule.source,
    status: 'open',
  };
  if (validityDays !== undefined) {
    item.validityDays = validityDays;
    item.validFrom = addDays(surgeryDate, -validityDays);
  }
  return item;
}

function requiredItems(c: ReadinessCase, settings: ResolvedReadinessSettings): ReadinessItem[] {
  const practice = groupByKey(matching(settings.practiceRules, c));
  const facility = groupByKey(matching(settings.facilityRules, c));
  const keys = new Set([...practice.keys(), ...facility.keys()]);
  const items: ReadinessItem[] = [];
  for (const key of keys) {
    // Facility requirements win over the practice's for the same item (pre-op testing in particular).
    const rules = facility.get(key) ?? practice.get(key) ?? [];
    items.push(buildItem(rules, c.surgeryDate));
  }
  return items.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.key.localeCompare(b.key));
}

/** Generates the readiness checklist for a case. */
export function generateChecklist(c: ReadinessCase, settings: ResolvedReadinessSettings, now: string): ChecklistResult {
  assertSamePractice(c, settings);
  if (c.urgency === 'urgent_add_on') return { kind: 'not_required', caseId: c.caseId, reason: 'urgent_add_on' };
  return {
    kind: 'checklist',
    checklist: {
      caseId: c.caseId,
      practiceId: c.practiceId,
      surgeryDate: c.surgeryDate,
      generatedAt: now,
      items: requiredItems(c, settings),
    },
  };
}

/** Date the item's evidence carries: the explicit evidence date, else the completion date. */
export function evidenceDateOf(item: ReadinessItem): IsoDate | undefined {
  if (item.evidenceDate !== undefined) return item.evidenceDate;
  return item.completedAt !== undefined ? dateOf(item.completedAt) : undefined;
}

/** Whether completed evidence still satisfies an item with the given expiry window for this surgery date. */
export function isEvidenceValid(evidence: IsoDate | undefined, validityDays: number | undefined, surgeryDate: IsoDate): boolean {
  if (validityDays === undefined) return true;
  if (evidence === undefined) return false;
  const age = toDayNumber(surgeryDate) - toDayNumber(evidence);
  return age >= 0 && age <= validityDays;
}

/**
 * Regenerates a checklist after the case changed (procedure, site of service, facility, date,
 * case type or risk flags) or its rules changed. Completed items that are still required and
 * still inside their expiry window stay complete; everything else follows the new rules.
 */
export function regenerateChecklist(
  previous: ReadinessChecklist | undefined,
  c: ReadinessCase,
  settings: ResolvedReadinessSettings,
  now: string,
): RegenerationResult {
  if (previous !== undefined && (previous.caseId !== c.caseId || previous.practiceId !== c.practiceId)) {
    throw new Error(`Checklist for case ${previous.caseId} cannot be regenerated for case ${c.caseId}`);
  }
  const before = new Map((previous?.items ?? []).map((item) => [item.key, item]));
  const result = generateChecklist(c, settings, now);
  const changes: ChecklistChanges = { added: [], removed: [], kept: [], invalidated: [] };

  if (result.kind === 'not_required') {
    changes.removed = [...before.keys()].sort();
    return { ...result, changes };
  }

  const items = result.checklist.items.map((item) => {
    const old = before.get(item.key);
    if (old === undefined) {
      changes.added.push(item.key);
      return item;
    }
    if (old.status !== 'complete') return item;
    const evidence = evidenceDateOf(old);
    if (!isEvidenceValid(evidence, item.validityDays, c.surgeryDate)) {
      changes.invalidated.push(item.key);
      return item;
    }
    changes.kept.push(item.key);
    const kept: ReadinessItem = { ...item, status: 'complete' };
    if (old.completedAt !== undefined) kept.completedAt = old.completedAt;
    if (old.evidenceDate !== undefined) kept.evidenceDate = old.evidenceDate;
    return kept;
  });
  const required = new Set(items.map((i) => i.key));
  changes.removed = [...before.keys()].filter((k) => !required.has(k)).sort();

  return { kind: 'checklist', checklist: { ...result.checklist, items }, changes };
}

/** Marks an item complete, recording the completion time and optional evidence date. */
export function completeItem(
  checklist: ReadinessChecklist,
  key: string,
  completedAt: string,
  evidenceDate?: IsoDate,
): ReadinessChecklist {
  const target = checklist.items.find((i) => i.key === key);
  if (target === undefined) throw new Error(`Checklist for case ${checklist.caseId} has no item ${key}`);
  const evidence = evidenceDate ?? dateOf(completedAt);
  if (!isEvidenceValid(evidence, target.validityDays, checklist.surgeryDate)) {
    throw new Error(`Evidence dated ${evidence} is outside the ${String(target.validityDays)}-day window for ${key}`);
  }
  return {
    ...checklist,
    items: checklist.items.map((item) => {
      if (item.key !== key) return item;
      const done: ReadinessItem = { ...item, status: 'complete', completedAt };
      if (evidenceDate !== undefined) done.evidenceDate = evidenceDate;
      return done;
    }),
  };
}
