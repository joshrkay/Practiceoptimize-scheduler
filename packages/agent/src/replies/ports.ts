/**
 * Ports for the patient reply handler. Messaging, the review queue, the outreach journey, slot finding,
 * the patient case page and the Today view are built elsewhere; wire real adapters at integration.
 * In-memory fakes for tests live in `fakes.ts`.
 */

export type ReplyClass = 'confirm' | 'change_request' | 'stop' | 'help' | 'urgent' | 'other';

export interface InboundMessage {
  practiceId: string;
  channel: 'sms' | 'voice';
  /** Patient number, digits with optional leading +. */
  from: string;
  /** Practice number that received the message. */
  to: string;
  /** SMS text. Untrusted data. */
  body: string;
  /** Voice reminder keypress, when channel is voice. */
  digits?: string | undefined;
  providerMessageId: string;
  receivedAt: Date;
}

/** The case a reply is linked to (most recent open case for the patient's number). */
export interface ReplyCase {
  caseId: string;
  patientId: string;
  locationPhone: string | null;
  surgeonOfficePhone: string | null;
  confirmationSentAt: Date | null;
  confirmedAt: Date | null;
  /** Set when the patient has answered anything since the confirmation was sent. */
  repliedAt: Date | null;
}

export interface PracticeDirectory {
  /** Routes by the receiving number only. Returns null for unknown numbers. */
  practiceIdForNumber(receivingNumber: string): Promise<string | null>;
}

/** Webhook secrets live in the practice's vault path, never in env. */
export interface WebhookSecrets {
  inboundSecret(practiceId: string): Promise<string | null>;
}

export interface CaseDirectory {
  findCaseForPatientNumber(practiceId: string, patientNumber: string): Promise<ReplyCase | null>;
  /** Cases with a 72-hour confirmation sent and not confirmed. */
  listAwaitingConfirmation(practiceId: string): Promise<ReplyCase[]>;
}

export interface CaseUpdates {
  markConfirmed(practiceId: string, caseId: string, at: Date): Promise<void>;
  recordReply(practiceId: string, caseId: string, at: Date): Promise<void>;
}

export interface OutboundMessage {
  practiceId: string;
  to: string;
  text: string;
  kind: 'urgent_instructions' | 'help' | 'change_link' | 'change_no_slots';
  /** True only for safety text: bypasses quiet hours, feature flags and opt-out suppression. */
  safety: boolean;
}

export interface Messenger {
  send(message: OutboundMessage): Promise<void>;
}

export interface OptOuts {
  /** Opts the patient out of every automated channel (SMS, voice, email). */
  optOutAllChannels(practiceId: string, patientNumber: string, patientId: string | null): Promise<void>;
}

export type TaskKind = 'urgent_reply' | 'scheduler_reply' | 'confirm_no_reply_call';

export interface TaskInput {
  practiceId: string;
  caseId: string | null;
  kind: TaskKind;
  priority: 'priority' | 'normal';
  summary: string;
  /** The patient's own words, when relevant. */
  patientWords?: string | undefined;
  /** Idempotency key: creating the same key twice must create one task. */
  dedupeKey: string;
}

/** Scheduler task queue (Today view). */
export interface TaskQueue {
  createTask(task: TaskInput): Promise<void>;
}

export interface ChangePlanInput {
  practiceId: string;
  caseId: string;
  requestId: string;
  slotId: string;
  patientWords: string;
}

export interface ChangeRequestInput {
  practiceId: string;
  caseId: string | null;
  requestId?: string;
  patientWords: string;
  reason: 'no_pick_within_window' | 'no_slots_available';
}

/** Review queue. A reply never reschedules or cancels: it only submits items here. */
export interface ReviewQueue {
  submitChangePlan(plan: ChangePlanInput): Promise<void>;
  submitChangeRequest(request: ChangeRequestInput): Promise<void>;
}

export interface SlotOffer {
  /** Link to the case-page picker. */
  url: string;
  slotIds: string[];
}

export interface SlotOffers {
  /** Proposes three slots on the case page and returns the pick link. */
  proposeSlots(practiceId: string, caseId: string, requestId: string): Promise<SlotOffer | null>;
}

export interface PendingChange {
  requestId: string;
  practiceId: string;
  caseId: string;
  patientWords: string;
  slotIds: string[];
  expiresAt: Date;
  status: 'open' | 'picked' | 'expired';
}

export interface PendingChangeStore {
  add(change: PendingChange): Promise<void>;
  get(requestId: string): Promise<PendingChange | null>;
  /** Atomically moves open -> status. Returns false when it was no longer open. */
  close(requestId: string, status: 'picked' | 'expired'): Promise<boolean>;
  listOpenExpiringBy(now: Date): Promise<PendingChange[]>;
}

export interface ReplyAuditEvent {
  practiceId: string;
  caseId: string | null;
  providerMessageId: string;
  channel: 'sms' | 'voice';
  classification: ReplyClass;
  source: 'rules' | 'classifier' | 'keypress' | 'fallback';
  action: string;
}

/** Audit sink. Events carry no message text. */
export interface ReplyAudit {
  record(event: ReplyAuditEvent): Promise<void>;
}

export interface ReplyFlags {
  /** FEATURE_PATIENT_REPLIES. Never consulted for urgent or stop replies. */
  patientRepliesEnabled(practiceId: string): Promise<boolean>;
}

export interface ClassifierResult {
  label: string;
  confidence: number;
}

/** Model-backed classifier for text the rules do not settle. Input and output are untrusted. */
export interface ReplyClassifier {
  classify(text: string): Promise<ClassifierResult>;
}

export interface Clock {
  now(): Date;
}
