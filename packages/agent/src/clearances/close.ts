import { addDays, today } from './dates.js';
import type {
  Deps,
  EhrPort,
  MatchedDocument,
  RangeRule,
  ReadinessItem,
  ResultValue,
  ReviewFlag,
  SignedOrder,
} from './ports.js';

export const DEFAULT_VALIDITY_DAYS = 30;

export type CloseOutcome =
  | { status: 'satisfied'; item: ReadinessItem }
  | { status: 'needs_review'; item: ReadinessItem; flag: ReviewFlag }
  | { status: 'rejected'; reason: 'item_not_found' | 'item_mismatch' | 'kind_mismatch' };

/**
 * Classifies result values against practice-configured ranges. Never interprets: anything that
 * is not plainly inside a configured range with a matching unit is routed to the surgeon.
 */
export function checkRanges(values: ResultValue[], ranges: Record<string, RangeRule>): string[] {
  const problems: string[] = [];
  for (const v of values) {
    const rule = ranges[v.code];
    if (!rule) problems.push(`no_configured_range:${v.code}`);
    else if (rule.unit !== v.unit) problems.push(`unit_mismatch:${v.code}`);
    else if ((rule.min !== undefined && v.value < rule.min) || (rule.max !== undefined && v.value > rule.max)) {
      problems.push(`out_of_range:${v.code}`);
    }
  }
  return problems;
}

async function validityDays(deps: Deps, facilityId: string, subtype: string): Promise<number> {
  return (await deps.facilityRules.validityDays(facilityId, subtype)) ?? DEFAULT_VALIDITY_DAYS;
}

/**
 * Applies a matched inbound document to its readiness item. This is one of only two functions that
 * can mark an item satisfied (the other is `confirmByHuman`). The decision text is stored verbatim.
 */
export async function applyMatchedDocument(
  deps: Deps,
  doc: MatchedDocument,
  surgery: { facilityId: string; surgeryDate: string },
): Promise<CloseOutcome> {
  const item = await deps.readiness.getItem(doc.practiceId, doc.itemId);
  if (!item) return { status: 'rejected', reason: 'item_not_found' };
  if (item.caseId !== doc.caseId) return { status: 'rejected', reason: 'item_mismatch' };
  if ((item.kind === 'clearance') !== (doc.kind === 'clearance_letter')) {
    return { status: 'rejected', reason: 'kind_mismatch' };
  }

  const issuedAt = doc.issuedAt ?? doc.receivedAt;
  const validUntil = addDays(issuedAt, await validityDays(deps, surgery.facilityId, item.subtype));

  if (item.kind === 'test') {
    const values = doc.values ?? [];
    const problems = checkRanges(values, await deps.practiceRules.ranges(doc.practiceId));
    if (problems.length > 0 || values.length === 0) {
      const first = problems[0] ?? '';
      const reason: ReviewFlag['reason'] = first.startsWith('unit_mismatch')
        ? 'unit_mismatch'
        : first.startsWith('out_of_range')
          ? 'out_of_range'
          : 'no_configured_range';
      const flag: ReviewFlag = { reason, details: values.length === 0 ? ['no_values_extracted'] : problems };
      const flagged: ReadinessItem = { ...item, status: 'open', reviewFlag: flag };
      await deps.readiness.update(flagged);
      return { status: 'needs_review', item: flagged, flag };
    }
  }

  if (surgery.surgeryDate > validUntil) {
    const flag: ReviewFlag = { reason: 'expired_before_surgery', details: [`valid_until:${validUntil}`] };
    const stale: ReadinessItem = { ...item, status: 'open', reviewFlag: flag };
    await deps.readiness.update(stale);
    return { status: 'needs_review', item: stale, flag };
  }

  const { reviewFlag: _f, reopenedReason: _r, ...rest } = item;
  const done: ReadinessItem = {
    ...rest,
    status: 'satisfied',
    satisfiedBy: { source: 'document', documentId: doc.documentId, decisionText: doc.decisionText, issuedAt, validUntil },
  };
  await deps.readiness.update(done);
  return { status: 'satisfied', item: done };
}

/** Human action (surgeon or scheduler) closing an item, e.g. after reviewing a flagged result. */
export async function confirmByHuman(
  deps: Deps,
  args: { practiceId: string; itemId: string; userId: string; note: string; facilityId: string },
): Promise<CloseOutcome> {
  if (!args.userId) throw new Error('a human user id is required');
  const item = await deps.readiness.getItem(args.practiceId, args.itemId);
  if (!item) return { status: 'rejected', reason: 'item_not_found' };
  const issuedAt = today(deps.clock.now());
  const validUntil = addDays(issuedAt, await validityDays(deps, args.facilityId, item.subtype));
  const { reviewFlag: _f, reopenedReason: _r, ...rest } = item;
  const done: ReadinessItem = {
    ...rest,
    status: 'satisfied',
    satisfiedBy: { source: 'human', userId: args.userId, note: args.note, issuedAt, validUntil },
  };
  await deps.readiness.update(done);
  return { status: 'satisfied', item: done };
}

/**
 * Reopens satisfied items for a case whose validity ends before the (new) surgery date.
 * Returns the reopened item ids so the caller can re-request.
 */
export async function revalidateForSurgeryDate(
  deps: Deps,
  practiceId: string,
  caseId: string,
  newSurgeryDate: string,
): Promise<string[]> {
  const reopened: string[] = [];
  for (const item of await deps.readiness.listItemsForCase(practiceId, caseId)) {
    if (item.status !== 'satisfied' || !item.satisfiedBy) continue;
    if (newSurgeryDate > item.satisfiedBy.validUntil) {
      const { satisfiedBy, ...rest } = item;
      await deps.readiness.update({
        ...rest,
        status: 'open',
        reopenedReason: `surgery date ${newSurgeryDate} is after validity end ${satisfiedBy.validUntil}`,
      });
      reopened.push(item.id);
    }
  }
  return reopened;
}

/**
 * Routes an order the surgeon has already signed. This module never creates or edits orders;
 * it only forwards a signed one when the practice allows it.
 */
export async function routeSignedOrder(
  deps: Deps,
  ehr: EhrPort,
  practiceId: string,
  order: SignedOrder,
): Promise<{ routed: boolean }> {
  if (!order.signedBy || !order.signedAt) return { routed: false };
  if (!(await deps.practiceRules.allowsSignedOrderRouting(practiceId))) return { routed: false };
  return ehr.routeSignedOrder(practiceId, order);
}
