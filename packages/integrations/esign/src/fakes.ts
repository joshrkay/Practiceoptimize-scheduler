import type {
  AuditPort,
  DocumentFilingPort,
  EnvelopeRecord,
  EnvelopeStore,
  FormLibraryPort,
  ReadinessPort,
  ReminderPort,
  RequiredFormItem,
  TaskPort,
} from './ports.js';
import type { ApprovedForm } from './types.js';

export class InMemoryEnvelopeStore implements EnvelopeStore {
  private readonly records = new Map<string, EnvelopeRecord>();
  private readonly events = new Set<string>();
  findByItem(practiceId: string, itemId: string) {
    return Promise.resolve(
      [...this.records.values()].find(
        (r) => r.practiceId === practiceId && r.readinessItemId === itemId,
      ),
    );
  }
  findByEnvelope(envelopeId: string) {
    return Promise.resolve(this.records.get(envelopeId));
  }
  listByCase(practiceId: string, caseId: string) {
    return Promise.resolve(
      [...this.records.values()].filter((r) => r.practiceId === practiceId && r.caseId === caseId),
    );
  }
  save(record: EnvelopeRecord) {
    this.records.set(record.envelopeId, record);
    return Promise.resolve();
  }
  hasProcessedEvent(eventId: string) {
    return Promise.resolve(this.events.has(eventId));
  }
  markEventProcessed(eventId: string) {
    this.events.add(eventId);
    return Promise.resolve();
  }
}

export class FakeFormLibrary implements FormLibraryPort {
  constructor(private readonly forms: ApprovedForm[]) {}
  get(_practiceId: string, formId: string, version: string) {
    return Promise.resolve(
      this.forms.find((f) => f.formId === formId && f.version === version) ?? null,
    );
  }
}

export class FakeReadiness implements ReadinessPort {
  readonly closed: string[] = [];
  constructor(public items: RequiredFormItem[]) {}
  requiredForms() {
    return Promise.resolve(this.items);
  }
  closeItem(_practiceId: string, id: string) {
    this.closed.push(id);
    return Promise.resolve();
  }
}

export class FakeFiling implements DocumentFilingPort {
  readonly caseDocs: string[] = [];
  readonly chartDocs: string[] = [];
  failChart = false;
  fileToCase(_p: string, _c: string, name: string) {
    this.caseDocs.push(name);
    return Promise.resolve();
  }
  fileToChart(_p: string, _c: string, name: string) {
    if (this.failChart) return Promise.reject(new Error('chart unavailable'));
    this.chartDocs.push(name);
    return Promise.resolve();
  }
}

export class FakeReminders implements ReminderPort {
  readonly active = new Set<string>();
  start(_p: string, _c: string, key: string) {
    this.active.add(key);
    return Promise.resolve();
  }
  stop(_p: string, key: string) {
    this.active.delete(key);
    return Promise.resolve();
  }
}

export class FakeTasks implements TaskPort {
  readonly tasks: { caseId: string; title: string; reason: string }[] = [];
  createSchedulerTask(_p: string, task: { caseId: string; title: string; reason: string }) {
    this.tasks.push(task);
    return Promise.resolve();
  }
}

export class FakeAudit implements AuditPort {
  readonly entries: { action: string }[] = [];
  record(_p: string, entry: { action: string }) {
    this.entries.push(entry);
    return Promise.resolve();
  }
}
