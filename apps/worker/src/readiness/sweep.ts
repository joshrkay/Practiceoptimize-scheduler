import {
  READINESS_CUTOFF_DAYS,
  computeCaseReadiness,
  isExpired,
  type ItemFinding,
  type TrackedCase,
  type TrackedItem,
} from '@scheduler/case-model';
import type { Clock, EscalationPort, ReadinessStore, ReminderPort, TodayEscalation } from './ports';

export const READINESS_SWEEP_INTERVAL_MS = 3_600_000;
const HOUR_MS = 3_600_000;

export interface SweepConfig {
  readonly enabled: boolean;
  readonly cutoffDays: number;
  /** Minimum hours between reminder requests for the same item. */
  readonly reminderIntervalHours: number;
}

/** Reads FEATURE_READINESS_TRACKING (default false) and READINESS_CUTOFF_DAYS (default 7). */
export function readSweepConfig(env: Record<string, string | undefined>): SweepConfig {
  const parsed = Number.parseInt(env['READINESS_CUTOFF_DAYS'] ?? '', 10);
  return {
    enabled: env['FEATURE_READINESS_TRACKING'] === 'true',
    cutoffDays: Number.isInteger(parsed) && parsed > 0 ? parsed : READINESS_CUTOFF_DAYS,
    reminderIntervalHours: 24,
  };
}

export interface SweepDeps {
  readonly store: ReadinessStore;
  readonly reminders: ReminderPort;
  readonly escalations: EscalationPort;
  readonly clock: Clock;
}

export interface SweepSummary {
  readonly skipped: boolean;
  readonly casesChecked: number;
  readonly reopened: number;
  readonly remindersRequested: number;
  readonly escalated: number;
  readonly errors: readonly { caseId: string; message: string }[];
}

interface Tally {
  reopened: number;
  reminders: number;
  escalated: number;
}

function escalationFor(
  c: TrackedCase,
  f: ItemFinding,
  daysOut: number,
): TodayEscalation {
  const kind = f.reason === 'awaiting_surgeon_decision' ? 'surgeon_decision' : f.reason === 'expired' ? 'expired' : 'cutoff';
  const title =
    kind === 'surgeon_decision'
      ? `Surgeon decision needed: ${f.label} result is outside threshold`
      : kind === 'expired'
        ? `${f.label} expired, ${daysOut} days before surgery`
        : `${f.label} still open, ${daysOut} days before surgery`;
  return {
    practiceId: c.practiceId,
    caseId: c.caseId,
    itemId: f.itemId,
    kind,
    title,
    dedupeKey: `${c.caseId}:${f.itemId}:${kind}`,
  };
}

async function sweepCase(
  c: TrackedCase,
  deps: SweepDeps,
  config: SweepConfig,
  now: Date,
  tally: Tally,
): Promise<void> {
  // 1. Expired items reopen, then are evaluated as open.
  const items = await Promise.all(
    c.items.map(async (i): Promise<TrackedItem> => {
      if (!isExpired(i, now)) return i;
      await deps.store.reopenItem(c.caseId, i.id);
      tally.reopened += 1;
      const { expiresAt: _expiresAt, ...rest } = i;
      return { ...rest, state: 'open' };
    }),
  );
  const current: TrackedCase = { ...c, items };

  // 2. Status.
  const readiness = computeCaseReadiness(current, now, { cutoffDays: config.cutoffDays });
  await deps.store.saveStatus(c.caseId, readiness);

  // 3. Ask owning journeys to remind (throttled); escalate blocked items and flagged results.
  for (const f of readiness.findings) {
    const item = items.find((i) => i.id === f.itemId);
    if (!item) continue;
    if (f.reason !== 'awaiting_surgeon_decision' && item.owner !== 'scheduler') {
      const last = item.lastReminderAt?.getTime();
      if (last === undefined || now.getTime() - last >= config.reminderIntervalHours * HOUR_MS) {
        await deps.reminders.requestReminder({
          practiceId: c.practiceId,
          caseId: c.caseId,
          itemId: item.id,
          itemLabel: item.label,
          journey: item.owner,
          reason: f.reason,
        });
        await deps.store.recordReminder(c.caseId, item.id, now);
        tally.reminders += 1;
      }
    }
    if (f.severity === 'blocked' || f.reason === 'awaiting_surgeon_decision') {
      await deps.escalations.escalateToToday(escalationFor(c, f, readiness.daysUntilSurgery));
      tally.escalated += 1;
    }
  }
}

/** Hourly sweep. One failing case does not stop the others. */
export async function runReadinessSweep(deps: SweepDeps, config: SweepConfig): Promise<SweepSummary> {
  if (!config.enabled) {
    return { skipped: true, casesChecked: 0, reopened: 0, remindersRequested: 0, escalated: 0, errors: [] };
  }
  const now = deps.clock.now();
  const cases = await deps.store.listTrackedCases();
  const tally: Tally = { reopened: 0, reminders: 0, escalated: 0 };
  const errors: { caseId: string; message: string }[] = [];
  let checked = 0;
  for (const c of cases) {
    if (c.urgentAddOn) continue;
    checked += 1;
    try {
      await sweepCase(c, deps, config, now, tally);
    } catch (e) {
      errors.push({ caseId: c.caseId, message: e instanceof Error ? e.message : String(e) });
    }
  }
  return {
    skipped: false,
    casesChecked: checked,
    reopened: tally.reopened,
    remindersRequested: tally.reminders,
    escalated: tally.escalated,
    errors,
  };
}
