import { today } from './dates.js';
import type { CaseContext, Deps, OutboundRequest, ReadinessItem, RecipientKind } from './ports.js';

export type RequestOutcome =
  | { status: 'sent'; requestId: string }
  | { status: 'skipped'; reason: 'already_satisfied' | 'already_requested' }
  | { status: 'no_recipient' };

/** Builds the minimum necessary payload: no diagnoses, notes or history. */
function build(
  ctx: CaseContext,
  item: ReadinessItem,
  recipientId: string,
  purpose: OutboundRequest['purpose'],
): OutboundRequest {
  return {
    practiceId: ctx.practiceId,
    caseId: ctx.caseId,
    itemId: item.id,
    patientId: ctx.patientId,
    recipientId,
    purpose,
    autonomy: 'autonomous',
    surgeryDate: ctx.surgeryDate,
    procedure: ctx.procedure,
    surgeonName: ctx.surgeonName,
    neededBy: item.neededBy,
    requested: item.subtype,
    ...(item.testDate ? { testDate: item.testDate } : {}),
  };
}

async function dispatch(
  deps: Deps,
  ctx: CaseContext,
  item: ReadinessItem,
  recipientKind: RecipientKind,
  purpose: OutboundRequest['purpose'],
): Promise<RequestOutcome> {
  const entry = await deps.directory.find(ctx.practiceId, ctx.patientId, recipientKind, item.subtype);
  if (!entry) return { status: 'no_recipient' };
  const { requestId } = await deps.send.send(build(ctx, item, entry.id, purpose));
  await deps.requests.record({
    requestId,
    practiceId: ctx.practiceId,
    itemId: item.id,
    purpose,
    sentAt: deps.clock.now().toISOString(),
  });
  return { status: 'sent', requestId };
}

/** Sends a clearance request to the patient's provider from the directory. */
export async function requestClearance(deps: Deps, ctx: CaseContext, item: ReadinessItem): Promise<RequestOutcome> {
  if (item.kind !== 'clearance') throw new Error('not a clearance item');
  if (item.status === 'satisfied') return { status: 'skipped', reason: 'already_satisfied' };
  const prior = await deps.requests.listForItem(ctx.practiceId, item.id);
  if (prior.some((p) => p.purpose === 'clearance_request')) return { status: 'skipped', reason: 'already_requested' };
  return dispatch(deps, ctx, item, 'provider', 'clearance_request');
}

/** Sends a pre-op test request to the lab or imaging site. Does not create an order. */
export async function requestTest(
  deps: Deps,
  ctx: CaseContext,
  item: ReadinessItem,
  site: 'lab' | 'imaging',
): Promise<RequestOutcome> {
  if (item.kind !== 'test') throw new Error('not a test item');
  if (item.status === 'satisfied') return { status: 'skipped', reason: 'already_satisfied' };
  const prior = await deps.requests.listForItem(ctx.practiceId, item.id);
  if (prior.some((p) => p.purpose === 'test_request')) return { status: 'skipped', reason: 'already_requested' };
  return dispatch(deps, ctx, item, site, 'test_request');
}

export interface ChasePolicy {
  /** Days between chases. */
  intervalDays: number;
  maxChases: number;
}

export const DEFAULT_CHASE_POLICY: ChasePolicy = { intervalDays: 2, maxChases: 3 };

export interface ChaseReport {
  chased: string[];
  /** Out of chases: hand to the scheduler. */
  exhausted: string[];
}

/**
 * Chases results for open test items whose test date has passed. Runs against the injected clock.
 * Items flagged for surgeon review are not chased: a result already arrived.
 */
export async function chaseResults(
  deps: Deps,
  contexts: Map<string, CaseContext>,
  site: (item: ReadinessItem) => 'lab' | 'imaging',
  practiceId: string,
  policy: ChasePolicy = DEFAULT_CHASE_POLICY,
): Promise<ChaseReport> {
  const now = deps.clock.now();
  const todayStr = today(now);
  const report: ChaseReport = { chased: [], exhausted: [] };
  for (const item of await deps.readiness.listOpenItems(practiceId)) {
    if (item.kind !== 'test' || !item.testDate || item.testDate >= todayStr || item.reviewFlag) continue;
    const ctx = contexts.get(item.caseId);
    if (!ctx) continue;
    const history = await deps.requests.listForItem(practiceId, item.id);
    const chases = history.filter((h) => h.purpose === 'result_chase');
    if (chases.length >= policy.maxChases) {
      report.exhausted.push(item.id);
      continue;
    }
    const lastSent = chases.length ? Math.max(...chases.map((c) => Date.parse(c.sentAt))) : undefined;
    if (lastSent !== undefined && now.getTime() - lastSent < policy.intervalDays * 86_400_000) continue;
    const outcome = await dispatch(deps, ctx, item, site(item), 'result_chase');
    if (outcome.status === 'sent') report.chased.push(item.id);
  }
  return report;
}
