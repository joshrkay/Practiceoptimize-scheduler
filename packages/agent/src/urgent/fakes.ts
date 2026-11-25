/** In-memory fakes for every urgent add-on port. Used by tests; replaced by real adapters at integration. */
import type {
  AscChannelPort,
  AscDirectoryPort,
  AscFacility,
  AscSubmissionStatus,
  AuditPort,
  AuthorizationRoutingPort,
  BookSlotResult,
  CaseRequest,
  CaseState,
  CaseStatePort,
  ClockPort,
  JourneyRecipient,
  OfficeSchedulePort,
  OrderIntakePort,
  PatientMessagingPort,
  PolicyDecision,
  PolicyEnginePort,
  PostOpBookingPort,
  PracticeId,
  RoomSlot,
  SchedulerNotificationPort,
  SignedUrgentOrder,
  TodayItem,
  TodayTasksPort,
  UrgentAddOnDeps,
  UrgentAddOnRecord,
  UrgentAddOnStorePort,
} from './ports.js';

const key = (practiceId: PracticeId, id: string): string => `${practiceId}::${id}`;

export class FakeClock implements ClockPort {
  private current: Date;
  constructor(start: string | Date) {
    this.current = new Date(start);
  }
  now(): Date {
    return new Date(this.current);
  }
  advanceMinutes(minutes: number): void {
    this.current = new Date(this.current.getTime() + minutes * 60_000);
  }
}

export class FakeOrderIntake implements OrderIntakePort {
  readonly orders = new Map<string, SignedUrgentOrder>();
  readonly requests = new Map<string, CaseRequest>();
  addOrder(order: SignedUrgentOrder): void {
    this.orders.set(key(order.practiceId, order.orderId), order);
  }
  addCaseRequest(request: CaseRequest): void {
    this.requests.set(key(request.practiceId, request.caseId), request);
  }
  async getSignedOrder(practiceId: PracticeId, orderId: string): Promise<SignedUrgentOrder | null> {
    return this.orders.get(key(practiceId, orderId)) ?? null;
  }
  async getCaseRequest(practiceId: PracticeId, caseId: string): Promise<CaseRequest | null> {
    return this.requests.get(key(practiceId, caseId)) ?? null;
  }
}

export interface FakeRoomEntry {
  readonly practiceId: PracticeId;
  readonly locationId: string;
  readonly slot: RoomSlot;
  /** Case already holding the slot, if any. */
  bookedCaseId: string | null;
  appointmentId: string | null;
}

export class FakeOfficeSchedule implements OfficeSchedulePort {
  readonly entries: FakeRoomEntry[] = [];
  readonly bookCalls: string[] = [];
  /** Slot IDs that another booking grabs between search and book (simulates a race). */
  readonly raceTaken = new Set<string>();
  private nextId = 1;

  addSlot(practiceId: PracticeId, locationId: string, slot: RoomSlot, bookedCaseId: string | null = null): void {
    this.entries.push({ practiceId, locationId, slot, bookedCaseId, appointmentId: bookedCaseId === null ? null : `existing-${slot.slotId}` });
  }

  async findOpenSlots(query: Parameters<OfficeSchedulePort['findOpenSlots']>[0]): Promise<readonly RoomSlot[]> {
    return this.entries
      .filter(
        (e) =>
          e.practiceId === query.practiceId &&
          e.locationId === query.locationId &&
          e.slot.roomId === query.roomId &&
          e.bookedCaseId === null &&
          e.slot.date >= query.onOrAfter &&
          new Date(e.slot.start).getTime() >= query.notBefore.getTime() &&
          new Date(e.slot.end).getTime() - new Date(e.slot.start).getTime() >= query.durationMinutes * 60_000,
      )
      .map((e) => e.slot)
      .sort((a, b) => a.start.localeCompare(b.start))
      .slice(0, query.limit);
  }

  async bookSlot(request: Parameters<OfficeSchedulePort['bookSlot']>[0]): Promise<BookSlotResult> {
    this.bookCalls.push(request.slotId);
    const entry = this.entries.find((e) => e.practiceId === request.practiceId && e.slot.slotId === request.slotId);
    if (entry === undefined) return { ok: false, reason: 'slot_taken' };
    if (this.raceTaken.has(request.slotId)) {
      entry.bookedCaseId = 'race-winner';
      entry.appointmentId = `race-${request.slotId}`;
    }
    if (entry.bookedCaseId !== null) return { ok: false, reason: 'slot_taken' };
    entry.bookedCaseId = request.caseId;
    entry.appointmentId = `appt-${this.nextId++}`;
    return { ok: true, appointmentId: entry.appointmentId };
  }
}

export class FakeAscDirectory implements AscDirectoryPort {
  readonly facilities = new Map<string, AscFacility>();
  add(practiceId: PracticeId, facility: AscFacility): void {
    this.facilities.set(key(practiceId, facility.facilityId), facility);
  }
  async getFacility(practiceId: PracticeId, facilityId: string): Promise<AscFacility | null> {
    return this.facilities.get(key(practiceId, facilityId)) ?? null;
  }
}

export class FakeAscChannel implements AscChannelPort {
  readonly submissions: Parameters<AscChannelPort['submitAddOn']>[0][] = [];
  readonly statuses = new Map<string, AscSubmissionStatus>();
  failSubmit = false;
  private nextId = 1;
  async submitAddOn(request: Parameters<AscChannelPort['submitAddOn']>[0]): Promise<{ readonly submissionId: string }> {
    if (this.failSubmit) throw new Error('channel unavailable');
    this.submissions.push(request);
    const submissionId = `sub-${this.nextId++}`;
    this.statuses.set(key(request.practiceId, submissionId), { status: 'pending' });
    return { submissionId };
  }
  setStatus(practiceId: PracticeId, submissionId: string, status: AscSubmissionStatus): void {
    this.statuses.set(key(practiceId, submissionId), status);
  }
  async getStatus(practiceId: PracticeId, submissionId: string): Promise<AscSubmissionStatus> {
    return this.statuses.get(key(practiceId, submissionId)) ?? { status: 'pending' };
  }
}

export class FakePolicyEngine implements PolicyEnginePort {
  decision: PolicyDecision = { outcome: 'allow' };
  readonly requests: Parameters<PolicyEnginePort['evaluate']>[0][] = [];
  async evaluate(request: Parameters<PolicyEnginePort['evaluate']>[0]): Promise<PolicyDecision> {
    this.requests.push(request);
    return this.decision;
  }
}

export class FakeCaseState implements CaseStatePort {
  readonly states = new Map<string, CaseState>();
  readonly billable = new Set<string>();
  readonly transitions: Parameters<CaseStatePort['transition']>[0][] = [];
  set(practiceId: PracticeId, caseId: string, state: CaseState): void {
    this.states.set(key(practiceId, caseId), state);
  }
  async getState(practiceId: PracticeId, caseId: string): Promise<CaseState | null> {
    return this.states.get(key(practiceId, caseId)) ?? null;
  }
  async transition(request: Parameters<CaseStatePort['transition']>[0]): Promise<void> {
    const current = this.states.get(key(request.practiceId, request.caseId));
    if (current !== request.from) throw new Error(`illegal transition from ${String(current)}`);
    this.transitions.push(request);
    this.states.set(key(request.practiceId, request.caseId), request.to);
  }
  async setBillable(request: Parameters<CaseStatePort['setBillable']>[0]): Promise<void> {
    this.billable.add(key(request.practiceId, request.caseId));
  }
  isBillable(practiceId: PracticeId, caseId: string): boolean {
    return this.billable.has(key(practiceId, caseId));
  }
}

export class FakeTodayTasks implements TodayTasksPort {
  readonly items: (TodayItem & { readonly itemId: string })[] = [];
  async createItem(item: TodayItem): Promise<{ readonly itemId: string }> {
    const itemId = `today-${this.items.length + 1}`;
    this.items.push({ ...item, itemId });
    return { itemId };
  }
}

export class FakeSchedulerNotifications implements SchedulerNotificationPort {
  readonly notices: Parameters<SchedulerNotificationPort['notify']>[0][] = [];
  async notify(notice: Parameters<SchedulerNotificationPort['notify']>[0]): Promise<void> {
    this.notices.push(notice);
  }
}

export class FakePatientMessaging implements PatientMessagingPort {
  readonly recipients = new Map<string, readonly JourneyRecipient[]>();
  readonly sent: Parameters<PatientMessagingPort['sendJourney']>[0][] = [];
  setRecipients(practiceId: PracticeId, patientId: string, recipients: readonly JourneyRecipient[]): void {
    this.recipients.set(key(practiceId, patientId), recipients);
  }
  async getAuthorizedRecipients(practiceId: PracticeId, patientId: string): Promise<readonly JourneyRecipient[]> {
    return this.recipients.get(key(practiceId, patientId)) ?? [];
  }
  async sendJourney(request: Parameters<PatientMessagingPort['sendJourney']>[0]): Promise<void> {
    this.sent.push(request);
  }
}

export class FakePostOpBooking implements PostOpBookingPort {
  available = true;
  readonly requests: Parameters<PostOpBookingPort['bookPostOpVisit']>[0][] = [];
  async bookPostOpVisit(
    request: Parameters<PostOpBookingPort['bookPostOpVisit']>[0],
  ): Promise<{ readonly appointmentId: string; readonly start: string } | null> {
    this.requests.push(request);
    if (!this.available) return null;
    const start = new Date(new Date(request.surgeryStart).getTime() + 7 * 24 * 60 * 60_000).toISOString();
    return { appointmentId: `postop-${this.requests.length}`, start };
  }
}

export class FakeAuthorizationRouting implements AuthorizationRoutingPort {
  /** Payer notification windows in hours after the procedure; a missing payer means the rule is unknown. */
  readonly windowsHours = new Map<string, number>();
  readonly opened: Parameters<AuthorizationRoutingPort['openRetroAuthorization']>[0][] = [];
  async getRetroNotificationDeadline(
    request: Parameters<AuthorizationRoutingPort['getRetroNotificationDeadline']>[0],
  ): Promise<Date | null> {
    const hours = this.windowsHours.get(request.payerId);
    return hours === undefined ? null : new Date(request.performedAt.getTime() + hours * 60 * 60_000);
  }
  async openRetroAuthorization(
    request: Parameters<AuthorizationRoutingPort['openRetroAuthorization']>[0],
  ): Promise<{ readonly itemId: string }> {
    this.opened.push(request);
    return { itemId: `retro-${this.opened.length}` };
  }
}

export class FakeUrgentAddOnStore implements UrgentAddOnStorePort {
  readonly records = new Map<string, UrgentAddOnRecord>();
  async get(practiceId: PracticeId, caseId: string): Promise<UrgentAddOnRecord | null> {
    return this.records.get(key(practiceId, caseId)) ?? null;
  }
  async save(record: UrgentAddOnRecord): Promise<void> {
    this.records.set(key(record.practiceId, record.caseId), record);
  }
}

export class FakeAudit implements AuditPort {
  readonly events: Parameters<AuditPort['record']>[0][] = [];
  async record(event: Parameters<AuditPort['record']>[0]): Promise<void> {
    this.events.push(event);
  }
}

export interface FakeUrgentAddOnDeps extends UrgentAddOnDeps {
  readonly intake: FakeOrderIntake;
  readonly officeSchedule: FakeOfficeSchedule;
  readonly ascDirectory: FakeAscDirectory;
  readonly ascChannel: FakeAscChannel;
  readonly policy: FakePolicyEngine;
  readonly caseState: FakeCaseState;
  readonly today: FakeTodayTasks;
  readonly scheduler: FakeSchedulerNotifications;
  readonly messaging: FakePatientMessaging;
  readonly postOp: FakePostOpBooking;
  readonly authorization: FakeAuthorizationRouting;
  readonly store: FakeUrgentAddOnStore;
  readonly clock: FakeClock;
  readonly audit: FakeAudit;
}

export function createFakeUrgentAddOnDeps(now: string | Date): FakeUrgentAddOnDeps {
  return {
    intake: new FakeOrderIntake(),
    officeSchedule: new FakeOfficeSchedule(),
    ascDirectory: new FakeAscDirectory(),
    ascChannel: new FakeAscChannel(),
    policy: new FakePolicyEngine(),
    caseState: new FakeCaseState(),
    today: new FakeTodayTasks(),
    scheduler: new FakeSchedulerNotifications(),
    messaging: new FakePatientMessaging(),
    postOp: new FakePostOpBooking(),
    authorization: new FakeAuthorizationRouting(),
    store: new FakeUrgentAddOnStore(),
    clock: new FakeClock(now),
    audit: new FakeAudit(),
  };
}
