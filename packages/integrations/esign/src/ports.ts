import type { ApprovedForm, CaseId, EnvelopeStatus, PracticeId } from './types.js';

/** A readiness item (from the readiness branch) that requires a form. */
export interface RequiredFormItem {
  readonly readinessItemId: string;
  readonly formId: string;
  readonly formVersion: string;
}

export interface ReadinessPort {
  requiredForms(practiceId: PracticeId, caseId: CaseId): Promise<RequiredFormItem[]>;
  closeItem(practiceId: PracticeId, readinessItemId: string): Promise<void>;
}

export interface FormLibraryPort {
  get(practiceId: PracticeId, formId: string, version: string): Promise<ApprovedForm | null>;
}

export interface DocumentFilingPort {
  /** Files to the case record (case page) or the chart (chart write-back branch). */
  fileToCase(practiceId: PracticeId, caseId: CaseId, name: string, pdf: Uint8Array): Promise<void>;
  fileToChart(practiceId: PracticeId, caseId: CaseId, name: string, pdf: Uint8Array): Promise<void>;
}

export interface ReminderPort {
  /** Starts the patient reminder cadence for an unsigned form. */
  start(practiceId: PracticeId, caseId: CaseId, key: string): Promise<void>;
  stop(practiceId: PracticeId, key: string): Promise<void>;
}

export interface TaskPort {
  createSchedulerTask(
    practiceId: PracticeId,
    task: {
      caseId: CaseId;
      title: string;
      reason: 'form-declined' | 'form-expired' | 'in-clinic-form';
    },
  ): Promise<void>;
}

export interface AuditPort {
  record(
    practiceId: PracticeId,
    entry: { action: string; caseId: CaseId; envelopeId?: string; status?: EnvelopeStatus },
  ): Promise<void>;
}

export interface EnvelopeRecord {
  readonly practiceId: PracticeId;
  readonly caseId: CaseId;
  readonly readinessItemId: string;
  readonly formId: string;
  readonly formVersion: string;
  readonly formTitle: string;
  readonly envelopeId: string;
  readonly signingUrl: string;
  status: EnvelopeStatus;
}

/** Persistence for envelopes and processed provider event IDs. */
export interface EnvelopeStore {
  findByItem(practiceId: PracticeId, readinessItemId: string): Promise<EnvelopeRecord | undefined>;
  findByEnvelope(envelopeId: string): Promise<EnvelopeRecord | undefined>;
  listByCase(practiceId: PracticeId, caseId: CaseId): Promise<EnvelopeRecord[]>;
  save(record: EnvelopeRecord): Promise<void>;
  hasProcessedEvent(eventId: string): Promise<boolean>;
  markEventProcessed(eventId: string): Promise<void>;
}
