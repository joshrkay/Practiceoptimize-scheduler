/**
 * Ports for dependencies that live on other branches (readiness items, coordination requests and
 * reminders, directory and send tool, inbound document matching, EHR connector, facility rules).
 * Only the minimal surface this module needs is defined here, with in-memory fakes for tests.
 */

export type IsoDate = string; // yyyy-mm-dd

export interface Clock {
  now(): Date;
}

export type ItemKind = 'clearance' | 'test';
export type ItemStatus = 'open' | 'satisfied';

export interface ReviewFlag {
  reason: 'out_of_range' | 'no_configured_range' | 'unit_mismatch' | 'expired_before_surgery';
  details: string[];
}

export type SatisfiedBy =
  | { source: 'document'; documentId: string; decisionText: string; issuedAt: IsoDate; validUntil: IsoDate }
  | { source: 'human'; userId: string; note: string; issuedAt: IsoDate; validUntil: IsoDate };

export interface ReadinessItem {
  id: string;
  practiceId: string;
  caseId: string;
  kind: ItemKind;
  /** e.g. `cardiology`, `a1c`, `vascular_study`. */
  subtype: string;
  neededBy: IsoDate;
  status: ItemStatus;
  /** Date the patient is scheduled to have the test (tests only). */
  testDate?: IsoDate;
  satisfiedBy?: SatisfiedBy;
  reviewFlag?: ReviewFlag;
  reopenedReason?: string;
}

export interface CaseContext {
  practiceId: string;
  caseId: string;
  /** Opaque reference; the send tool resolves identity. No clinical content travels in requests. */
  patientId: string;
  facilityId: string;
  surgeryDate: IsoDate;
  procedure: string;
  surgeonName: string;
}

export interface ReadinessPort {
  getItem(practiceId: string, itemId: string): Promise<ReadinessItem | undefined>;
  listOpenItems(practiceId: string): Promise<ReadinessItem[]>;
  listItemsForCase(practiceId: string, caseId: string): Promise<ReadinessItem[]>;
  update(item: ReadinessItem): Promise<void>;
}

export type RecipientKind = 'provider' | 'lab' | 'imaging';

export interface DirectoryEntry {
  id: string;
  name: string;
  kind: RecipientKind;
}

export interface DirectoryPort {
  /** The patient's provider for a clearance specialty, or the lab/imaging site for a test. */
  find(practiceId: string, patientId: string, kind: RecipientKind, subtype: string): Promise<DirectoryEntry | undefined>;
}

/** Minimum necessary fields for an outbound request. */
export interface OutboundRequest {
  practiceId: string;
  caseId: string;
  itemId: string;
  patientId: string;
  recipientId: string;
  purpose: 'clearance_request' | 'test_request' | 'result_chase';
  /** Information requests and reminders are autonomous per the PRD. */
  autonomy: 'autonomous';
  surgeryDate: IsoDate;
  procedure: string;
  surgeonName: string;
  neededBy: IsoDate;
  /** Name of the clearance specialty or test requested. */
  requested: string;
  testDate?: IsoDate;
}

export interface SendPort {
  send(request: OutboundRequest): Promise<{ requestId: string }>;
}

export interface TrackedRequest {
  requestId: string;
  practiceId: string;
  itemId: string;
  purpose: OutboundRequest['purpose'];
  sentAt: string; // ISO timestamp
}

export interface RequestStore {
  record(entry: TrackedRequest): Promise<void>;
  listForItem(practiceId: string, itemId: string): Promise<TrackedRequest[]>;
}

/** An inbound clearance letter or result already matched to a case and readiness item (RAH-37). */
export interface ResultValue {
  code: string; // e.g. `a1c`
  value: number;
  unit: string;
}

export interface MatchedDocument {
  documentId: string;
  practiceId: string;
  caseId: string;
  itemId: string;
  kind: 'clearance_letter' | 'test_result';
  receivedAt: IsoDate;
  /** Date on the document; falls back to receivedAt. */
  issuedAt?: IsoDate;
  /** The provider's decision/statement exactly as written. Never paraphrased. */
  decisionText: string;
  values?: ResultValue[];
}

export interface RangeRule {
  min?: number;
  max?: number;
  unit: string;
}

export interface PracticeRulesPort {
  /** Practice-configured normal ranges keyed by result code. */
  ranges(practiceId: string): Promise<Record<string, RangeRule>>;
  /** Whether the practice allows routing already-signed orders through the EHR. */
  allowsSignedOrderRouting(practiceId: string): Promise<boolean>;
}

export interface FacilityRulesPort {
  /** Resolved validity window; undefined means "use the default". */
  validityDays(facilityId: string, subtype: string): Promise<number | undefined>;
}

/** Orders signed by the surgeon in the EHR. This module never creates an order. */
export interface SignedOrder {
  orderId: string;
  signedBy: string;
  signedAt: string;
}

export interface EhrPort {
  routeSignedOrder(practiceId: string, order: SignedOrder): Promise<{ routed: boolean }>;
}

export interface Deps {
  readiness: ReadinessPort;
  directory: DirectoryPort;
  send: SendPort;
  requests: RequestStore;
  practiceRules: PracticeRulesPort;
  facilityRules: FacilityRulesPort;
  clock: Clock;
}

// ---------- in-memory fakes ----------

export class FakeReadiness implements ReadinessPort {
  items = new Map<string, ReadinessItem>();
  constructor(items: ReadinessItem[] = []) {
    for (const i of items) this.items.set(i.id, structuredClone(i));
  }
  async getItem(practiceId: string, itemId: string) {
    const i = this.items.get(itemId);
    return i && i.practiceId === practiceId ? structuredClone(i) : undefined;
  }
  async listOpenItems(practiceId: string) {
    return [...this.items.values()]
      .filter((i) => i.practiceId === practiceId && i.status === 'open')
      .map((i) => structuredClone(i));
  }
  async listItemsForCase(practiceId: string, caseId: string) {
    return [...this.items.values()]
      .filter((i) => i.practiceId === practiceId && i.caseId === caseId)
      .map((i) => structuredClone(i));
  }
  async update(item: ReadinessItem) {
    this.items.set(item.id, structuredClone(item));
  }
}

export class FakeDirectory implements DirectoryPort {
  constructor(private entries: Record<string, DirectoryEntry> = {}) {}
  async find(_p: string, _patient: string, kind: RecipientKind, subtype: string) {
    return this.entries[`${kind}:${subtype}`];
  }
}

export class FakeSend implements SendPort {
  sent: OutboundRequest[] = [];
  async send(request: OutboundRequest) {
    this.sent.push(structuredClone(request));
    return { requestId: `req-${this.sent.length}` };
  }
}

export class FakeRequestStore implements RequestStore {
  entries: TrackedRequest[] = [];
  async record(entry: TrackedRequest) {
    this.entries.push(entry);
  }
  async listForItem(practiceId: string, itemId: string) {
    return this.entries.filter((e) => e.practiceId === practiceId && e.itemId === itemId);
  }
}

export class FakePracticeRules implements PracticeRulesPort {
  constructor(
    public rangeMap: Record<string, RangeRule> = {},
    public routing = false,
  ) {}
  async ranges() {
    return this.rangeMap;
  }
  async allowsSignedOrderRouting() {
    return this.routing;
  }
}

export class FakeFacilityRules implements FacilityRulesPort {
  constructor(private days: Record<string, number> = {}) {}
  async validityDays(facilityId: string, subtype: string) {
    return this.days[`${facilityId}:${subtype}`];
  }
}

export class FakeEhr implements EhrPort {
  routed: SignedOrder[] = [];
  async routeSignedOrder(_p: string, order: SignedOrder) {
    this.routed.push(order);
    return { routed: true };
  }
}

export class FixedClock implements Clock {
  constructor(public current: Date) {}
  now() {
    return this.current;
  }
}
