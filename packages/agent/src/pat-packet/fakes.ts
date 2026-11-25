import type {
  CaseDataPort,
  CaseDocument,
  CaseInfo,
  ClockPort,
  FacilityPatRules,
  FacilityRulesPort,
  HolidayPort,
  IsoDate,
  OpenItemPort,
  OpenItemRequest,
  OutboundPacket,
  PacketRecord,
  PacketStorePort,
  PatSendPort,
  SchedulerAlert,
  SchedulerAlertPort,
  SendMode,
  SendPolicyPort,
} from './ports.js';

export class FakeCaseData implements CaseDataPort {
  cases = new Map<string, CaseInfo>();
  documents = new Map<string, CaseDocument[]>();
  async getCase(_practiceId: string, caseId: string) {
    return this.cases.get(caseId);
  }
  async listDocuments(_practiceId: string, caseId: string) {
    return [...(this.documents.get(caseId) ?? [])];
  }
}

export class FakeRules implements FacilityRulesPort {
  rules = new Map<string, FacilityPatRules>();
  async resolvePatRules(_practiceId: string, facilityId: string) {
    return this.rules.get(facilityId);
  }
}

export class FakeClock implements ClockPort {
  constructor(public date: IsoDate) {}
  today() {
    return this.date;
  }
}

export class FakeHolidays implements HolidayPort {
  constructor(private readonly set: ReadonlySet<IsoDate> = new Set()) {}
  holidays() {
    return this.set;
  }
}

export class FakeSender implements PatSendPort {
  sent: OutboundPacket[] = [];
  async send(packet: OutboundPacket) {
    const i = this.sent.findIndex((p) => p.idempotencyKey === packet.idempotencyKey);
    if (i === -1) this.sent.push(packet);
    return { transmissionId: `tx-${i === -1 ? this.sent.length : i + 1}` };
  }
}

export class FakeAlerts implements SchedulerAlertPort {
  alerts: SchedulerAlert[] = [];
  async alertScheduler(alert: SchedulerAlert) {
    this.alerts.push(alert);
  }
}

export class FakeOpenItems implements OpenItemPort {
  items = new Map<string, OpenItemRequest>();
  async createOpenItem(item: OpenItemRequest) {
    this.items.set(item.sourceRequestId, item);
    return { itemId: `item-${item.sourceRequestId}` };
  }
}

/** Defaults to autonomous sending. */
export class FakePolicy implements SendPolicyPort {
  mode: SendMode = 'autonomous';
  approvals: string[] = [];
  async sendMode() {
    return this.mode;
  }
  async requestApproval(_practiceId: string, _caseId: string, key: string) {
    this.approvals.push(key);
  }
}

export class FakeStore implements PacketStorePort {
  records: PacketRecord[] = [];
  async findByKey(_practiceId: string, key: string) {
    return this.records.find((r) => r.idempotencyKey === key);
  }
  async listForCase(_practiceId: string, caseId: string) {
    return this.records.filter((r) => r.caseId === caseId);
  }
  async save(record: PacketRecord) {
    this.records.push(record);
  }
}
