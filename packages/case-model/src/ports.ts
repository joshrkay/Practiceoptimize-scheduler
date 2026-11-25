/**
 * Ports this package needs from packages that are built separately.
 *
 * `AuditSink` is the minimal interface onto `@scheduler/audit` (built in parallel). Wire the real
 * immutable audit log in at integration. Events carry identifiers, codes and states only, never PHI.
 */
import type {
  Actor,
  CaseId,
  CaseState,
  CaseType,
  ChangeEventId,
  ChangeEventKind,
  IsoDateTime,
  PracticeId,
} from './case.js';

export type CaseAuditAction = `case.${ChangeEventKind}`;

export interface CaseAuditEvent {
  practiceId: PracticeId;
  caseId: CaseId;
  /** The change event this audit entry mirrors. */
  changeEventId: ChangeEventId;
  action: CaseAuditAction;
  actor: Actor;
  occurredAt: IsoDateTime;
  fromState?: CaseState;
  toState?: CaseState;
  fromCaseType?: CaseType;
  toCaseType?: CaseType;
  reason?: string;
  details?: Record<string, string | number | boolean>;
}

export interface AuditSink {
  /** Must reject if the event could not be durably recorded; the transition then fails. */
  record(event: CaseAuditEvent): Promise<void>;
}
