import type {
  CaseId,
  CaseSummary,
  DeletionReport,
  PracticeId,
  RetentionPorts,
  SeriesId,
} from './ports.js';

export const DEFAULT_PHI_RETENTION_DAYS = 90;
const DAY_MS = 86_400_000;

/** Reads PHI_RETENTION_DAYS; falls back to 90 when unset, throws on an invalid value. */
export function resolveRetentionDays(raw: string | undefined = process.env.PHI_RETENTION_DAYS): number {
  if (raw === undefined || raw === '') return DEFAULT_PHI_RETENTION_DAYS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error('PHI_RETENTION_DAYS must be a positive integer');
  }
  return n;
}

/** A case is past retention when it ended (closed, or cancelled and not reopened) `days` or more ago. */
export function isPastRetention(c: CaseSummary, now: Date, days: number): boolean {
  if (c.status === 'open' || c.endedAt === null) return false;
  return now.getTime() - c.endedAt.getTime() >= days * DAY_MS;
}

/**
 * Runs the retention pass for one practice. Re-running is safe: deleters are idempotent, cases whose PHI
 * is already gone are skipped, and audit events are only written when something was actually deleted.
 */
export async function runPracticeRetention(
  practiceId: PracticeId,
  ports: RetentionPorts,
  days: number,
): Promise<DeletionReport> {
  const now = ports.clock.now();
  const cases = await ports.store.listCases(practiceId);
  const report: DeletionReport = {
    practiceId,
    runAt: now.toISOString(),
    retentionDays: days,
    casesEvaluated: cases.length,
    casesDeleted: 0,
    seriesSharedDeleted: 0,
    recordsDeleted: 0,
    heldForPendingWriteBack: 0,
    seriesKeptOpen: 0,
    failures: 0,
  };
  const held = new Set<CaseId>();
  const pendingCache = new Map<CaseId, boolean>();
  const pending = async (id: CaseId): Promise<boolean> => {
    let v = pendingCache.get(id);
    if (v === undefined) {
      v = await ports.writeBack.hasPendingWriteBack(practiceId, id);
      pendingCache.set(id, v);
    }
    return v;
  };

  // Each case's own data follows its own clock.
  for (const c of cases) {
    if (c.phiDeleted || !isPastRetention(c, now, days)) continue;
    if (await pending(c.caseId)) {
      held.add(c.caseId);
      continue;
    }
    try {
      await ports.snapshotter.snapshotCaseMetrics(practiceId, c.caseId); // snapshot before delete
      const removed = await ports.deleter.deleteCasePhi(practiceId, c.caseId);
      report.casesDeleted += 1;
      report.recordsDeleted += removed;
      await ports.audit.record({
        practiceId,
        action: 'retention.case_phi_deleted',
        caseId: c.caseId,
        recordCount: removed,
        at: now,
      });
    } catch {
      report.failures += 1;
    }
  }

  // Series-shared data waits for the last case in the series.
  const series = new Map<SeriesId, CaseSummary[]>();
  for (const c of cases) {
    if (c.seriesId === null) continue;
    series.set(c.seriesId, [...(series.get(c.seriesId) ?? []), c]);
  }
  for (const [seriesId, members] of series) {
    const pastCount = members.filter((m) => isPastRetention(m, now, days)).length;
    if (pastCount < members.length) {
      if (pastCount > 0) report.seriesKeptOpen += 1;
      continue;
    }
    let blocked = false;
    for (const m of members) {
      if (await pending(m.caseId)) {
        held.add(m.caseId);
        blocked = true;
      }
    }
    if (blocked) continue;
    try {
      const removed = await ports.deleter.deleteSeriesSharedPhi(practiceId, seriesId);
      if (removed > 0) {
        report.seriesSharedDeleted += 1;
        report.recordsDeleted += removed;
        await ports.audit.record({
          practiceId,
          action: 'retention.series_phi_deleted',
          seriesId,
          recordCount: removed,
          at: now,
        });
      }
    } catch {
      report.failures += 1;
    }
  }

  report.heldForPendingWriteBack = held.size;
  if (held.size > 0) {
    const ids = [...held];
    await ports.notifier.flagPendingWriteBack(practiceId, ids);
    for (const caseId of ids) {
      await ports.audit.record({
        practiceId,
        action: 'retention.deletion_blocked_write_back',
        caseId,
        at: now,
      });
    }
  }
  await ports.notifier.deliverReport(report);
  return report;
}

/** Daily entry point: one pass per practice. */
export async function runPhiRetention(
  ports: RetentionPorts,
  days: number = resolveRetentionDays(),
): Promise<DeletionReport[]> {
  const reports: DeletionReport[] = [];
  for (const practiceId of await ports.store.listPracticeIds()) {
    reports.push(await runPracticeRetention(practiceId, ports, days));
  }
  return reports;
}
