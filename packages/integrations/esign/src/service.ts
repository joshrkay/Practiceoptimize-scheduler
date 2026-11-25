import type {
  AuditPort,
  DocumentFilingPort,
  EnvelopeRecord,
  EnvelopeStore,
  FormLibraryPort,
  ReadinessPort,
  ReminderPort,
  TaskPort,
} from './ports.js';
import type {
  CaseId,
  ESignProvider,
  EnvelopeStatus,
  PracticeId,
  RemoteForm,
} from './types.js';

declare const verified: unique symbol;
/** Produced only by the verified patient case page (identity check done); never by this package. */
export interface VerifiedPatientSession {
  readonly practiceId: PracticeId;
  readonly caseId: CaseId;
  readonly [verified]: true;
}

/** For the patient case page to call after identity verification, and for tests. */
export function asVerifiedPatientSession(session: {
  practiceId: PracticeId;
  caseId: CaseId;
}): VerifiedPatientSession {
  return session as VerifiedPatientSession;
}

export interface FormListItem {
  readonly title: string;
  readonly status: EnvelopeStatus;
  readonly signingUrl: string | null;
}

export interface SendResult {
  readonly sent: string[];
  /** Readiness items that stay clinic tasks because the form is in-clinic only. */
  readonly inClinic: string[];
  readonly alreadySent: string[];
}

export interface ESignServiceDeps {
  provider: ESignProvider;
  library: FormLibraryPort;
  readiness: ReadinessPort;
  store: EnvelopeStore;
  filing: DocumentFilingPort;
  reminders: ReminderPort;
  tasks: TaskPort;
  audit: AuditPort;
}

const TERMINAL: readonly EnvelopeStatus[] = ['signed', 'declined', 'expired'];
const RANK: Record<EnvelopeStatus, number> = {
  sent: 0,
  viewed: 1,
  signed: 2,
  declined: 2,
  expired: 2,
};

export class ESignService {
  constructor(private readonly d: ESignServiceDeps) {}

  /** Sends every remote form the checklist requires. Takes IDs from the library, never free text. */
  async sendRequiredForms(
    practiceId: PracticeId,
    caseId: CaseId,
    patientRef: string,
  ): Promise<SendResult> {
    const result = { sent: [] as string[], inClinic: [] as string[], alreadySent: [] as string[] };
    for (const item of await this.d.readiness.requiredForms(practiceId, caseId)) {
      const form = await this.d.library.get(practiceId, item.formId, item.formVersion);
      if (!form) {
        throw new Error(`Form ${item.formId}@${item.formVersion} is not in the approved library`);
      }
      if (form.delivery !== 'remote') {
        result.inClinic.push(item.readinessItemId);
        continue;
      }
      if (await this.d.store.findByItem(practiceId, item.readinessItemId)) {
        result.alreadySent.push(item.readinessItemId);
        continue;
      }
      const envelope = await this.d.provider.createEnvelope({
        practiceId,
        caseId,
        form: form as RemoteForm,
        patientRef,
        idempotencyKey: `${practiceId}:${item.readinessItemId}`,
      });
      await this.d.store.save({
        practiceId,
        caseId,
        readinessItemId: item.readinessItemId,
        formId: form.formId,
        formVersion: form.version,
        formTitle: form.title,
        envelopeId: envelope.envelopeId,
        signingUrl: envelope.signingUrl,
        status: 'sent',
      });
      await this.d.reminders.start(practiceId, caseId, envelope.envelopeId);
      await this.d.audit.record(practiceId, {
        action: 'esign.sent',
        caseId,
        envelopeId: envelope.envelopeId,
      });
      result.sent.push(item.readinessItemId);
    }
    return result;
  }

  /** Forms list for the patient case page. Signing links exist only for a verified session. */
  async listForms(session: VerifiedPatientSession): Promise<FormListItem[]> {
    const records = await this.d.store.listByCase(session.practiceId, session.caseId);
    return records.map((r) => ({
      title: r.formTitle,
      status: r.status,
      signingUrl: TERMINAL.includes(r.status) ? null : r.signingUrl,
    }));
  }

  /** Provider webhook: verified first, then idempotent by provider event ID. */
  async handleWebhook(
    rawBody: string,
    signature: string,
  ): Promise<'applied' | 'duplicate' | 'ignored'> {
    const event = this.d.provider.verifyWebhook(rawBody, signature);
    if (await this.d.store.hasProcessedEvent(event.eventId)) return 'duplicate';
    const record = await this.d.store.findByEnvelope(event.envelopeId);
    if (!record) return 'ignored';

    // Out-of-order or repeated states never move an envelope backwards or sideways.
    const advances = RANK[event.type] > RANK[record.status];
    if (advances) await this.apply(record, event.type);
    await this.d.store.markEventProcessed(event.eventId);
    return advances ? 'applied' : 'ignored';
  }

  /** Creates the clinic task for each in-clinic-only item; the item itself is never sent. */
  async createInClinicTasks(practiceId: PracticeId, caseId: CaseId): Promise<number> {
    let count = 0;
    for (const item of await this.d.readiness.requiredForms(practiceId, caseId)) {
      const form = await this.d.library.get(practiceId, item.formId, item.formVersion);
      if (form && form.delivery !== 'remote') {
        await this.d.tasks.createSchedulerTask(practiceId, {
          caseId,
          title: `Collect "${form.title}" in clinic`,
          reason: 'in-clinic-form',
        });
        count += 1;
      }
    }
    return count;
  }

  private async apply(record: EnvelopeRecord, status: EnvelopeStatus): Promise<void> {
    const { practiceId, caseId, envelopeId } = record;
    if (status === 'signed') {
      // If filing fails the event is not marked processed, so the provider's retry re-runs this.
      const pdf = await this.d.provider.downloadSignedDocument(envelopeId);
      const name = `${record.formId}-v${record.formVersion}-signed.pdf`;
      await this.d.filing.fileToCase(practiceId, caseId, name, pdf);
      await this.d.filing.fileToChart(practiceId, caseId, name, pdf);
      await this.d.readiness.closeItem(practiceId, record.readinessItemId);
    }
    if (status === 'declined') {
      await this.d.tasks.createSchedulerTask(practiceId, {
        caseId,
        title: `Patient declined "${record.formTitle}"`,
        reason: 'form-declined',
      });
    }
    if (status === 'expired') {
      await this.d.tasks.createSchedulerTask(practiceId, {
        caseId,
        title: `"${record.formTitle}" expired unsigned`,
        reason: 'form-expired',
      });
    }
    if (TERMINAL.includes(status)) await this.d.reminders.stop(practiceId, envelopeId);
    record.status = status;
    await this.d.store.save(record);
    await this.d.audit.record(practiceId, { action: `esign.${status}`, caseId, envelopeId, status });
  }
}
