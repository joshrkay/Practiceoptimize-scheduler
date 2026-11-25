import type { TrackedCase, TrackedItem } from './ports';

export const READINESS_CUTOFF_DAYS = 7;
export const DEFAULT_WARNING_WINDOW_DAYS = 3;
const DAY_MS = 86_400_000;

/**
 * ready: every required item done and valid.
 * on_track: not ready yet, but nothing is at risk or blocked.
 * at_risk: an item is inside its warning window, or a result is flagged awaiting the surgeon.
 * blocked: an item is past the cutoff or expired.
 * not_tracked: urgent add-on.
 */
export type ReadinessStatus = 'ready' | 'on_track' | 'at_risk' | 'blocked' | 'not_tracked';

export type ItemReason =
  | 'past_cutoff'
  | 'expired'
  | 'awaiting_surgeon_decision'
  | 'due_soon'
  | 'overdue';

export interface ItemFinding {
  readonly itemId: string;
  readonly label: string;
  readonly reason: ItemReason;
  /** Severity this finding contributes to the case. */
  readonly severity: 'at_risk' | 'blocked';
}

export interface CaseReadiness {
  readonly status: ReadinessStatus;
  readonly daysUntilSurgery: number;
  readonly findings: readonly ItemFinding[];
}

export interface ReadinessOptions {
  readonly cutoffDays?: number;
}

export function daysUntil(surgeryDate: Date, now: Date): number {
  return Math.floor((surgeryDate.getTime() - now.getTime()) / DAY_MS);
}

export function isExpired(item: TrackedItem, now: Date): boolean {
  return (
    item.state === 'done' && item.expiresAt !== undefined && item.expiresAt.getTime() <= now.getTime()
  );
}

function dueAt(item: TrackedItem, surgeryDate: Date, cutoffDays: number): Date {
  return item.dueAt ?? new Date(surgeryDate.getTime() - cutoffDays * DAY_MS);
}

function findItem(
  item: TrackedItem,
  surgeryDate: Date,
  now: Date,
  cutoffDays: number,
): ItemFinding | undefined {
  const base = { itemId: item.id, label: item.label };
  if (isExpired(item, now)) return { ...base, reason: 'expired', severity: 'blocked' };
  if (item.state === 'done') return undefined;
  // A flagged result never blocks automatically: it waits for the surgeon's decision.
  if (item.state === 'flagged') {
    return { ...base, reason: 'awaiting_surgeon_decision', severity: 'at_risk' };
  }
  if (daysUntil(surgeryDate, now) <= cutoffDays) {
    return { ...base, reason: 'past_cutoff', severity: 'blocked' };
  }
  const due = dueAt(item, surgeryDate, cutoffDays).getTime();
  if (now.getTime() > due) return { ...base, reason: 'overdue', severity: 'at_risk' };
  const warn = (item.warningWindowDays ?? DEFAULT_WARNING_WINDOW_DAYS) * DAY_MS;
  if (now.getTime() >= due - warn) return { ...base, reason: 'due_soon', severity: 'at_risk' };
  return undefined;
}

/** Pure per-case readiness status. */
export function computeCaseReadiness(
  c: TrackedCase,
  now: Date,
  options: ReadinessOptions = {},
): CaseReadiness {
  const cutoffDays = options.cutoffDays ?? READINESS_CUTOFF_DAYS;
  const days = daysUntil(c.surgeryDate, now);
  if (c.urgentAddOn) return { status: 'not_tracked', daysUntilSurgery: days, findings: [] };

  const required = c.items.filter((i) => i.required);
  const findings: ItemFinding[] = [];
  for (const item of required) {
    const f = findItem(item, c.surgeryDate, now, cutoffDays);
    if (f) findings.push(f);
  }
  let status: ReadinessStatus;
  if (findings.some((f) => f.severity === 'blocked')) status = 'blocked';
  else if (findings.length > 0) status = 'at_risk';
  else if (required.every((i) => i.state === 'done')) status = 'ready';
  else status = 'on_track';
  return { status, daysUntilSurgery: days, findings };
}
