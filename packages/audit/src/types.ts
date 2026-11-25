export type ActorType = 'user' | 'agent' | 'system';
export type AuditResult = 'success' | 'failure' | 'denied';

export interface AuditActor {
  readonly type: ActorType;
  readonly id: string;
}

export interface AuditTarget {
  readonly type: string;
  readonly id: string;
}

/** What a caller supplies. `inputs` is hashed; the raw inputs are never stored. */
export interface AuditEventInput {
  readonly practiceId: string;
  readonly locationId: string | null;
  readonly actor: AuditActor;
  readonly action: string;
  readonly target: AuditTarget;
  readonly inputs: unknown;
  readonly result: AuditResult;
  readonly autonomyTier: number;
  readonly approverId: string | null;
  /** For example an Availity GTID. */
  readonly externalTransactionId: string | null;
}

export interface AuditEvent {
  readonly id: string;
  readonly practiceId: string;
  readonly locationId: string | null;
  readonly actor: AuditActor;
  readonly action: string;
  readonly target: AuditTarget;
  readonly inputsHash: string;
  readonly result: AuditResult;
  readonly autonomyTier: number;
  readonly approverId: string | null;
  readonly externalTransactionId: string | null;
  /** ISO 8601 UTC. */
  readonly occurredAt: string;
}

/** Append-only by construction: there is deliberately no update or delete method. */
export interface AuditSink {
  append(event: AuditEvent): Promise<void>;
}
