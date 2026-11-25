import type {
  AuditEventInput,
  AuditPort,
  AuthorizedContact,
  CaseReadPort,
  CaseSource,
  ChangePlanPort,
  Clock,
  ContactPreferencesPort,
  FinancialLinks,
  FinancialLinksPort,
  LinkDeliveryPort,
  MessageType,
  PatientIdentityPort,
  PatientLinkRecord,
  PatientLinkStore,
  PatientSessionRecord,
  PatientSessionStore,
  ProposedSlot,
  SchedulerNotificationPort,
  SlotProposalPort,
} from './ports.js';

export class FakeClock implements Clock {
  constructor(private current: Date = new Date('2026-03-02T15:00:00Z')) {}
  now(): Date {
    return new Date(this.current);
  }
  advanceMinutes(minutes: number): void {
    this.current = new Date(this.current.getTime() + minutes * 60_000);
  }
}

export class InMemoryLinkStore implements PatientLinkStore {
  readonly links = new Map<string, PatientLinkRecord>();
  insert(link: PatientLinkRecord): Promise<void> {
    this.links.set(link.id, { ...link });
    return Promise.resolve();
  }
  findById(id: string): Promise<PatientLinkRecord | null> {
    const link = this.links.get(id);
    return Promise.resolve(link ? { ...link } : null);
  }
  latestForCase(practiceId: string, caseId: string): Promise<PatientLinkRecord | null> {
    const matches = [...this.links.values()]
      .filter((l) => l.practiceId === practiceId && l.caseId === caseId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return Promise.resolve(matches[0] ? { ...matches[0] } : null);
  }
  recordFailedAttempt(id: string): Promise<number> {
    const link = this.mustGet(id);
    link.failedAttempts += 1;
    return Promise.resolve(link.failedAttempts);
  }
  lock(id: string, at: Date): Promise<void> {
    this.mustGet(id).lockedAt = at;
    return Promise.resolve();
  }
  consume(id: string, at: Date): Promise<boolean> {
    const link = this.mustGet(id);
    if (link.usedAt) return Promise.resolve(false);
    link.usedAt = at;
    return Promise.resolve(true);
  }
  private mustGet(id: string): PatientLinkRecord {
    const link = this.links.get(id);
    if (!link) throw new Error(`unknown link ${id}`);
    return link;
  }
}

export class InMemorySessionStore implements PatientSessionStore {
  readonly sessions = new Map<string, PatientSessionRecord>();
  insert(session: PatientSessionRecord): Promise<void> {
    this.sessions.set(session.id, { ...session });
    return Promise.resolve();
  }
  findById(id: string): Promise<PatientSessionRecord | null> {
    const session = this.sessions.get(id);
    return Promise.resolve(session ? { ...session } : null);
  }
}

export class FakeIdentity implements PatientIdentityPort {
  constructor(private readonly dobs: Record<string, string> = {}) {}
  getDateOfBirth(_practiceId: string, caseId: string): Promise<string | null> {
    return Promise.resolve(this.dobs[caseId] ?? null);
  }
}

export class FakeCaseRead implements CaseReadPort {
  constructor(private readonly cases: Record<string, CaseSource> = {}) {}
  getCase(practiceId: string, caseId: string): Promise<CaseSource | null> {
    const found = this.cases[caseId];
    return Promise.resolve(found && found.practiceId === practiceId ? found : null);
  }
}

export class FakeContacts implements ContactPreferencesPort {
  constructor(public contacts: AuthorizedContact[] = []) {}
  list(): Promise<AuthorizedContact[]> {
    return Promise.resolve(this.contacts.map((c) => ({ ...c })));
  }
  setMessageTypes(
    _practiceId: string,
    _caseId: string,
    contactId: string,
    types: MessageType[],
  ): Promise<boolean> {
    const contact = this.contacts.find((c) => c.id === contactId);
    if (!contact) return Promise.resolve(false);
    contact.enabledMessageTypes = [...types];
    return Promise.resolve(true);
  }
}

export class FakeSlots implements SlotProposalPort {
  constructor(public slots: ProposedSlot[] = []) {}
  propose(): Promise<ProposedSlot[]> {
    return Promise.resolve(this.slots);
  }
}

export class FakeChangePlans implements ChangePlanPort {
  readonly created: { caseId: string; slot: ProposedSlot }[] = [];
  createRescheduleChangePlan(input: { caseId: string; slot: ProposedSlot }) {
    this.created.push({ caseId: input.caseId, slot: input.slot });
    return Promise.resolve({
      changePlanId: `plan-${this.created.length}`,
      status: 'pending_scheduler_approval' as const,
    });
  }
}

export class FakeFinancialLinks implements FinancialLinksPort {
  constructor(
    public links: FinancialLinks = { quoteUrl: null, financialConsentUrl: null, depositUrl: null },
  ) {}
  getLinks(): Promise<FinancialLinks> {
    return Promise.resolve(this.links);
  }
}

export class FakeAudit implements AuditPort {
  readonly events: AuditEventInput[] = [];
  failNext = false;
  record(event: AuditEventInput): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('audit unavailable'));
    }
    this.events.push(event);
    return Promise.resolve();
  }
}

export class FakeNotifier implements SchedulerNotificationPort {
  readonly sent: { caseId: string; kind: string }[] = [];
  notify(input: { caseId: string; kind: string }): Promise<void> {
    this.sent.push({ caseId: input.caseId, kind: input.kind });
    return Promise.resolve();
  }
}

export class FakeLinkDelivery implements LinkDeliveryPort {
  readonly sent: { caseId: string; url: string }[] = [];
  send(input: { caseId: string; url: string }): Promise<void> {
    this.sent.push({ caseId: input.caseId, url: input.url });
    return Promise.resolve();
  }
}
