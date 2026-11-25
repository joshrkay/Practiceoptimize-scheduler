/**
 * Ports the retention job depends on. The case model, PHI deleter, audit sink and chart write-back
 * are built elsewhere; these are the minimal shapes needed, wired up at integration.
 * Nothing here carries PHI: only opaque ids, statuses and dates.
 */

export type PracticeId = string;
export type CaseId = string;
export type SeriesId = string;

export type CaseStatus = 'open' | 'closed' | 'cancelled';

/** Non-PHI view of a case. `endedAt` is the close time (closed) or cancel time (cancelled). */
export interface CaseSummary {
  caseId: CaseId;
  practiceId: PracticeId;
  seriesId: SeriesId | null;
  status: CaseStatus;
  /** Null while open. A reopened cancelled case is `open` again, so it never ages out. */
  endedAt: Date | null;
  /** True once this case's own PHI has been deleted. */
  phiDeleted: boolean;
}

export interface CaseStore {
  listPracticeIds(): Promise<PracticeId[]>;
  listCases(practiceId: PracticeId): Promise<CaseSummary[]>;
}

export interface PhiDeleter {
  /** Deletes one case's own PHI. Idempotent. Returns the number of records removed. */
  deleteCasePhi(practiceId: PracticeId, caseId: CaseId): Promise<number>;
  /** Deletes data shared across a case series (authorization, shared documents). Idempotent. */
  deleteSeriesSharedPhi(practiceId: PracticeId, seriesId: SeriesId): Promise<number>;
}

export interface MetricsSnapshotter {
  /** Stores de-identified metrics for a case. Must be safe to call repeatedly. */
  snapshotCaseMetrics(practiceId: PracticeId, caseId: CaseId): Promise<void>;
}

export interface WriteBackCheck {
  hasPendingWriteBack(practiceId: PracticeId, caseId: CaseId): Promise<boolean>;
}

export type RetentionAuditAction =
  | 'retention.case_phi_deleted'
  | 'retention.series_phi_deleted'
  | 'retention.deletion_blocked_write_back';

/** Append-only. The job only ever adds events; it has no way to edit or delete them. */
export interface AuditSink {
  record(event: {
    practiceId: PracticeId;
    action: RetentionAuditAction;
    caseId?: CaseId;
    seriesId?: SeriesId;
    recordCount?: number;
    at: Date;
  }): Promise<void>;
}

export interface RetentionNotifier {
  /** Tells the practice these cases are past retention but held back by pending chart write-back. */
  flagPendingWriteBack(practiceId: PracticeId, caseIds: CaseId[]): Promise<void>;
  /** Delivers the counts-only report to the practice's compliance officer. */
  deliverReport(report: DeletionReport): Promise<void>;
}

export interface Clock {
  now(): Date;
}

/** Counts only. No ids, names or other PHI. */
export interface DeletionReport {
  practiceId: PracticeId;
  runAt: string;
  retentionDays: number;
  casesEvaluated: number;
  casesDeleted: number;
  seriesSharedDeleted: number;
  recordsDeleted: number;
  heldForPendingWriteBack: number;
  seriesKeptOpen: number;
  failures: number;
}

export interface RetentionPorts {
  store: CaseStore;
  deleter: PhiDeleter;
  snapshotter: MetricsSnapshotter;
  writeBack: WriteBackCheck;
  audit: AuditSink;
  notifier: RetentionNotifier;
  clock: Clock;
}
