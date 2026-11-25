import type {
  AuditPort,
  BookRequest,
  BookResult,
  ChangeResult,
  OpenSlot,
  PolicyDecision,
  PolicyPort,
  PostOpDeps,
  PostOpVisit,
  ScheduleConnector,
  SettingsPort,
  SlotSearch,
  SlotSearchResult,
  TaskInput,
  TaskPort,
  VisitStore,
} from './ports.js';

export class FakeScheduleConnector implements ScheduleConnector {
  unsupported = false;
  openSlots: OpenSlot[];
  appointments = new Map<string, { slot: OpenSlot; caseId: string }>();
  bookCalls = 0;
  private byKey = new Map<string, string>();
  private n = 0;

  constructor(slots: OpenSlot[] = []) {
    this.openSlots = [...slots];
  }

  findOpenSlots(search: SlotSearch): Promise<SlotSearchResult> {
    if (this.unsupported) return Promise.resolve({ kind: 'unsupported', ehr: 'fake-ehr' });
    const slots = this.openSlots.filter((s) => {
      const d = s.startsAt.slice(0, 10);
      return (
        search.providerIds.includes(s.providerId) &&
        s.locationId === search.locationId &&
        d >= search.fromDate &&
        d <= search.toDate
      );
    });
    return Promise.resolve({ kind: 'slots', slots });
  }

  bookAppointment(req: BookRequest): Promise<BookResult> {
    this.bookCalls += 1;
    if (this.unsupported) return Promise.resolve({ kind: 'unsupported', ehr: 'fake-ehr' });
    const prior = this.byKey.get(req.idempotencyKey);
    if (prior) return Promise.resolve({ kind: 'booked', appointmentId: prior });
    if (!this.take(req.slot.slotId)) return Promise.resolve({ kind: 'slot_taken' });
    const id = `appt-${++this.n}`;
    this.appointments.set(id, { slot: req.slot, caseId: req.caseId });
    this.byKey.set(req.idempotencyKey, id);
    return Promise.resolve({ kind: 'booked', appointmentId: id });
  }

  moveAppointment(args: { appointmentId: string; slot: OpenSlot }): Promise<BookResult | ChangeResult> {
    if (this.unsupported) return Promise.resolve({ kind: 'unsupported', ehr: 'fake-ehr' });
    const existing = this.appointments.get(args.appointmentId);
    if (!existing) return Promise.resolve({ kind: 'not_found' });
    if (!this.take(args.slot.slotId)) return Promise.resolve({ kind: 'slot_taken' });
    this.openSlots.push(existing.slot);
    existing.slot = args.slot;
    return Promise.resolve({ kind: 'ok' });
  }

  cancelAppointment(args: { appointmentId: string }): Promise<ChangeResult> {
    if (this.unsupported) return Promise.resolve({ kind: 'unsupported', ehr: 'fake-ehr' });
    const existing = this.appointments.get(args.appointmentId);
    if (!existing) return Promise.resolve({ kind: 'not_found' });
    this.appointments.delete(args.appointmentId);
    this.openSlots.push(existing.slot);
    return Promise.resolve({ kind: 'ok' });
  }

  private take(slotId: string): boolean {
    const i = this.openSlots.findIndex((s) => s.slotId === slotId);
    if (i < 0) return false;
    this.openSlots.splice(i, 1);
    return true;
  }
}

export class FakeSettings implements SettingsPort {
  window: { minDays: number; maxDays: number } | undefined;
  postOpWindow(): Promise<{ minDays: number; maxDays: number } | undefined> {
    return Promise.resolve(this.window);
  }
}

export class FakePolicy implements PolicyPort {
  /** Defaults to autonomous; see "Decisions to confirm" in the PR. */
  decision: PolicyDecision = 'autonomous';
  decide(): Promise<PolicyDecision> {
    return Promise.resolve(this.decision);
  }
}

export class FakeTasks implements TaskPort {
  tasks: TaskInput[] = [];
  createTask(task: TaskInput): Promise<void> {
    this.tasks.push(task);
    return Promise.resolve();
  }
}

export class FakeAudit implements AuditPort {
  events: { action: string; caseId: string }[] = [];
  record(event: { action: string; caseId: string }): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
}

export class InMemoryVisitStore implements VisitStore {
  private rows = new Map<string, PostOpVisit>();
  get(practiceId: string, caseId: string): Promise<PostOpVisit | undefined> {
    return Promise.resolve(this.rows.get(`${practiceId}:${caseId}`));
  }
  save(visit: PostOpVisit): Promise<void> {
    this.rows.set(`${visit.practiceId}:${visit.caseId}`, { ...visit });
    return Promise.resolve();
  }
}

export function makeFakeDeps(slots: OpenSlot[] = []) {
  const connector = new FakeScheduleConnector(slots);
  const settings = new FakeSettings();
  const policy = new FakePolicy();
  const tasks = new FakeTasks();
  const audit = new FakeAudit();
  const visits = new InMemoryVisitStore();
  const deps: PostOpDeps = { enabled: true, connector, settings, policy, tasks, audit, visits };
  return { deps, connector, settings, policy, tasks, audit, visits };
}
