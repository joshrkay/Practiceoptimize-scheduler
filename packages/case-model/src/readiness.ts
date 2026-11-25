/**
 * Case-level rules: which financial readiness items a case type needs, the Ready gate,
 * and whether an authorization covers a case. Clinical items come from the readiness
 * rules engine (RAH-60) and are carried through unchanged.
 */
import type {
  Authorization,
  Case,
  CaseId,
  CaseType,
  IsoDate,
  ReadinessCategory,
  ReadinessItem,
  ReadinessItemKind,
} from './case.js';

interface FinancialItemSpec {
  kind: ReadinessItemKind;
  category: Exclude<ReadinessCategory, 'clinical'>;
  phase: ReadinessItem['phase'];
}

const INSURANCE_PRE_OP: FinancialItemSpec[] = [
  { kind: 'eligibility_check', category: 'insurance', phase: 'pre_op' },
  { kind: 'prior_authorization', category: 'insurance', phase: 'pre_op' },
];

/** Urgent add-ons are booked without prior auth; payer notification and retro-auth are tracked after surgery. */
const INSURANCE_URGENT: FinancialItemSpec[] = [
  { kind: 'eligibility_check', category: 'insurance', phase: 'pre_op' },
  { kind: 'payer_notification_post_surgery', category: 'insurance', phase: 'post_op' },
  { kind: 'retro_authorization', category: 'insurance', phase: 'post_op' },
];

const SELF_PAY: FinancialItemSpec[] = [
  { kind: 'self_pay_quote', category: 'self_pay', phase: 'pre_op' },
  { kind: 'financial_consent', category: 'self_pay', phase: 'pre_op' },
  { kind: 'deposit', category: 'self_pay', phase: 'pre_op' },
];

export function financialItemSpecs(caseType: CaseType, urgentAddOn: boolean): FinancialItemSpec[] {
  const insurance = urgentAddOn ? INSURANCE_URGENT : INSURANCE_PRE_OP;
  switch (caseType) {
    case 'insured':
      return insurance;
    case 'self_pay':
      return SELF_PAY;
    case 'mixed':
      return [...insurance, ...SELF_PAY];
  }
}

export function readinessItemId(caseId: CaseId, kind: ReadinessItemKind): string {
  return `${caseId}:${kind}`;
}

/**
 * Rebuild the financial readiness items for a case type. Clinical items are kept as they are;
 * financial items still wanted keep their status; unwanted ones drop; missing ones are added open.
 */
export function rebuildFinancialReadiness(
  caseId: CaseId,
  items: readonly ReadinessItem[],
  caseType: CaseType,
  urgentAddOn: boolean,
): ReadinessItem[] {
  const specs = financialItemSpecs(caseType, urgentAddOn);
  const wanted = new Set(specs.map((s) => s.kind));
  const kept = items.filter((item) => item.category === 'clinical' || wanted.has(item.kind));
  const present = new Set(kept.map((item) => item.kind));
  const added: ReadinessItem[] = specs
    .filter((spec) => !present.has(spec.kind))
    .map((spec) => ({
      id: readinessItemId(caseId, spec.kind),
      kind: spec.kind,
      category: spec.category,
      phase: spec.phase,
      required: true,
      status: 'open',
    }));
  return [...kept, ...added];
}

export function isItemSatisfied(item: ReadinessItem, surgeryDate: IsoDate): boolean {
  if (item.status !== 'complete') return false;
  return item.validUntil === undefined || item.validUntil >= surgeryDate;
}

/** Required pre-op items that are not complete, or whose validity ends before the surgery date. */
export function unmetReadinessItems(c: Pick<Case, 'readinessItems' | 'surgeryDate'>): ReadinessItem[] {
  return c.readinessItems.filter(
    (item) => item.required && item.phase === 'pre_op' && !isItemSatisfied(item, c.surgeryDate),
  );
}

export function isReadyForSurgery(c: Pick<Case, 'readinessItems' | 'surgeryDate'>): boolean {
  return unmetReadinessItems(c).length === 0;
}

/** CPT codes on the case that the payer is billed for. */
export function insuredCptCodes(c: Pick<Case, 'procedures'>): string[] {
  return c.procedures.filter((p) => p.billing === 'insured').map((p) => p.cptCode);
}

export type CoverageGap =
  | 'practice_mismatch'
  | 'not_approved'
  | 'not_linked_to_case'
  | 'date_outside_window'
  | 'codes_not_covered';

/** Why an authorization does not cover a case; empty when it does. */
export function authorizationCoverageGaps(
  auth: Authorization,
  c: Pick<Case, 'id' | 'practiceId' | 'seriesId' | 'surgeryDate' | 'procedures'>,
): CoverageGap[] {
  const gaps: CoverageGap[] = [];
  if (auth.practiceId !== c.practiceId) gaps.push('practice_mismatch');
  if (auth.status !== 'approved') gaps.push('not_approved');
  const linked =
    auth.coverage.caseIds.includes(c.id) ||
    (auth.coverage.caseSeriesId !== undefined && auth.coverage.caseSeriesId === c.seriesId);
  if (!linked) gaps.push('not_linked_to_case');
  if (c.surgeryDate < auth.validFrom || c.surgeryDate > auth.validTo) gaps.push('date_outside_window');
  if (!insuredCptCodes(c).every((code) => auth.cptCodes.includes(code))) gaps.push('codes_not_covered');
  return gaps;
}

export function authorizationCovers(
  auth: Authorization,
  c: Pick<Case, 'id' | 'practiceId' | 'seriesId' | 'surgeryDate' | 'procedures'>,
): boolean {
  return authorizationCoverageGaps(auth, c).length === 0;
}

export function findCoveringAuthorization(
  c: Pick<Case, 'id' | 'practiceId' | 'seriesId' | 'surgeryDate' | 'procedures'>,
  authorizations: readonly Authorization[],
): Authorization | undefined {
  return authorizations.find((auth) => authorizationCovers(auth, c));
}
