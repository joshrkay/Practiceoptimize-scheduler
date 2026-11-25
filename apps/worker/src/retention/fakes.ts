import type {
  CaseId,
  CaseSummary,
  DeletionReport,
  PracticeId,
  RetentionAuditAction,
  RetentionPorts,
  SeriesId,
} from './ports.js';

export interface FakeWorld {
  ports: RetentionPorts;
  cases: CaseSummary[];
  pendingWriteBack: Set<CaseId>;
  deletedCases: CaseId[];
  deletedSeries: SeriesId[];
  snapshots: CaseId[];
  auditEvents: { action: RetentionAuditAction; caseId?: CaseId | undefined; seriesId?: SeriesId | undefined }[];
  flagged: { practiceId: PracticeId; caseIds: CaseId[] }[];
  reports: DeletionReport[];
  failSnapshotFor: Set<CaseId>;
  failDeleteFor: Set<CaseId>;
  now: Date;
}

/** In-memory ports. Deleters are idempotent: a second delete removes 0 records. */
export function createFakeWorld(cases: CaseSummary[], now: Date): FakeWorld {
  const w: FakeWorld = {
    cases,
    pendingWriteBack: new Set(),
    deletedCases: [],
    deletedSeries: [],
    snapshots: [],
    auditEvents: [],
    flagged: [],
    reports: [],
    failSnapshotFor: new Set(),
    failDeleteFor: new Set(),
    now,
    ports: undefined as unknown as RetentionPorts,
  };
  w.ports = {
    store: {
      listPracticeIds: async () => [...new Set(w.cases.map((c) => c.practiceId))],
      listCases: async (p) => w.cases.filter((c) => c.practiceId === p),
    },
    deleter: {
      async deleteCasePhi(_p, caseId) {
        if (w.failDeleteFor.has(caseId)) throw new Error('delete failed');
        const c = w.cases.find((x) => x.caseId === caseId);
        if (!c || c.phiDeleted) return 0;
        c.phiDeleted = true;
        w.deletedCases.push(caseId);
        return 5;
      },
      async deleteSeriesSharedPhi(_p, seriesId) {
        if (w.deletedSeries.includes(seriesId)) return 0;
        w.deletedSeries.push(seriesId);
        return 3;
      },
    },
    snapshotter: {
      async snapshotCaseMetrics(_p, caseId) {
        if (w.failSnapshotFor.has(caseId)) throw new Error('snapshot failed');
        w.snapshots.push(caseId);
      },
    },
    writeBack: { hasPendingWriteBack: async (_p, caseId) => w.pendingWriteBack.has(caseId) },
    audit: {
      async record(e) {
        w.auditEvents.push({ action: e.action, ...(e.caseId ? { caseId: e.caseId } : {}), ...(e.seriesId ? { seriesId: e.seriesId } : {}) });
      },
    },
    notifier: {
      async flagPendingWriteBack(practiceId, caseIds) {
        w.flagged.push({ practiceId, caseIds });
      },
      async deliverReport(r) {
        w.reports.push(r);
      },
    },
    clock: { now: () => w.now },
  };
  return w;
}
