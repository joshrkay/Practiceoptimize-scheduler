/**
 * Ports the coordination journey needs from modules built elsewhere. Each is the minimal interface this
 * module uses; adapters are wired up at integration.
 *
 * - CaseReader: case record and state machine (RAH-15).
 * - CareTeamDirectory, OutboundSender: care team directory and outbound channels (RAH-35).
 * - ApprovalPolicy, ReviewQueue: policy engine and review queue (RAH-17).
 * - SchedulerTaskQueue: scheduler tasks; per-practice job queues (RAH-14) drive `runEscalation`.
 * - CaseRiskSignal: the Today view's case risk (RAH-59).
 * - CoordinationRequestStore: persistence (table `coordination_requests`, migration 0036).
 */
import type { CaseSnapshot } from './journey.js';
import type {
  CoordinationRequest,
  CoordinationRequestType,
  OutboundChannel,
  PartyRole,
} from './requests.js';

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}

export interface CaseReader {
  getCase(practiceId: string, caseId: string): Promise<CaseSnapshot | null>;
}

export interface PartyContact {
  partyId: string;
  role: PartyRole;
  preferredChannel: OutboundChannel;
}

export interface CareTeamDirectory {
  /** The party in `role` for this case (e.g. the case's facility OR desk), or null if none is on file. */
  resolveParty(practiceId: string, caseId: string, role: PartyRole): Promise<PartyContact | null>;
}

export type OutboundMessageKind = 'request' | 'updated_request' | 'reminder' | 'cancellation_notice';

/** Identifiers only: the channel adapter renders the content from the case and directory. */
export interface OutboundMessage {
  practiceId: string;
  caseId: string;
  requestId: string;
  partyId: string;
  channel: OutboundChannel;
  kind: OutboundMessageKind;
  requestType: CoordinationRequestType;
  surgeryDate: string;
  reminderLevel?: 1 | 2;
  supersedesRequestId?: string;
}

export interface OutboundSender {
  send(message: OutboundMessage): Promise<{ messageId: string }>;
}

export interface ApprovalAction {
  practiceId: string;
  caseId: string;
  requestType: CoordinationRequestType;
  partyRole: PartyRole;
}

export interface ApprovalPolicy {
  /** Whether the practice's autonomy tier requires a scheduler to approve this send. */
  requiresApproval(action: ApprovalAction): Promise<boolean>;
}

export interface ReviewQueue {
  submit(item: {
    practiceId: string;
    caseId: string;
    kind: 'coordination_request';
    requestId: string;
    requestType: CoordinationRequestType;
  }): Promise<{ reviewItemId: string }>;
  withdraw(practiceId: string, reviewItemId: string, reason: string): Promise<void>;
}

export type SchedulerTaskKind = 'phone_call' | 'resolve_contact';

export interface SchedulerTask {
  practiceId: string;
  caseId: string;
  kind: SchedulerTaskKind;
  /** The same key never creates a second task. */
  idempotencyKey: string;
  requestId?: string;
  partyRole: PartyRole;
}

export interface SchedulerTaskQueue {
  createTask(task: SchedulerTask): Promise<{ taskId: string }>;
}

export interface CaseRiskSignal {
  raise(signal: { practiceId: string; caseId: string; requestId: string; reason: 'coordination_overdue' }): Promise<void>;
  clear(signal: { practiceId: string; caseId: string; requestId: string }): Promise<void>;
}

/** Thrown by `insert` when an active request already exists for the same practice, case, party and type. */
export class DuplicateActiveRequestError extends Error {
  constructor(readonly key: string) {
    super(`An active coordination request already exists for ${key}`);
    this.name = 'DuplicateActiveRequestError';
  }
}

export interface CoordinationRequestStore {
  insert(request: CoordinationRequest): Promise<void>;
  update(request: CoordinationRequest): Promise<void>;
  get(practiceId: string, requestId: string): Promise<CoordinationRequest | null>;
  listByCase(practiceId: string, caseId: string): Promise<CoordinationRequest[]>;
  listActive(practiceId: string): Promise<CoordinationRequest[]>;
}
