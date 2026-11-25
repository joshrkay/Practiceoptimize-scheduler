/**
 * Ports the tool layer depends on. The real implementations live in other packages that are being
 * built in parallel (audit log RAH-8, row-level security RAH-10, case model RAH-15, vault paths);
 * they are wired in at integration. In-memory fakes for tests live in `fakes.ts`.
 */

/** The practice is the isolation boundary. Always comes from the authenticated session, never the model. */
export type PracticeId = string & { readonly __brand: 'PracticeId' };
export type LocationId = string & { readonly __brand: 'LocationId' };
export type UserId = string & { readonly __brand: 'UserId' };

export const practiceId = (value: string): PracticeId => value as PracticeId;
export const locationId = (value: string): LocationId => value as LocationId;
export const userId = (value: string): UserId => value as UserId;

export type SideEffect = 'read' | 'write';

export type ToolCallOutcome =
  | 'success'
  | 'dry_run'
  | 'not_found'
  | 'invalid_input'
  | 'forbidden'
  | 'unknown_tool'
  | 'error';

/**
 * One audit event per tool call. Carries argument names but not argument values: values may hold
 * PHI, and PHI scrubbing belongs to the audit package.
 */
export interface ToolCallAuditEvent {
  readonly type: 'tool_call';
  readonly at: string;
  readonly practiceId: PracticeId;
  readonly locationId: LocationId | null;
  readonly actorUserId: UserId;
  readonly correlationId: string;
  readonly toolName: string;
  readonly sideEffect: SideEffect | null;
  readonly dryRun: boolean;
  readonly outcome: ToolCallOutcome;
  readonly argumentNames: readonly string[];
  /** Case IDs the call resolved inside the caller's practice. */
  readonly caseIds: readonly string[];
}

export type SecurityEventKind =
  /** The model referenced a case that belongs to another practice. */
  | 'cross_practice_reference'
  /** The model referenced a case that does not resolve in the caller's practice (owner unknown). */
  | 'unresolved_case_reference'
  /** The model tried to supply a practice, tenant, customer or credential argument. */
  | 'scope_argument_supplied';

export interface SecurityEvent {
  readonly type: 'security';
  readonly kind: SecurityEventKind;
  readonly at: string;
  readonly practiceId: PracticeId;
  readonly actorUserId: UserId;
  readonly correlationId: string;
  readonly toolName: string;
  readonly detail: string;
}

/** Append-only sink. Implemented by the immutable audit log (RAH-8). */
export interface AuditSink {
  recordToolCall(event: ToolCallAuditEvent): Promise<void>;
  recordSecurityEvent(event: SecurityEvent): Promise<void>;
}

/** The minimal view of a case the tool layer needs. The full record comes from the case model (RAH-15). */
export interface CaseRef {
  readonly caseId: string;
  readonly practiceId: PracticeId;
  readonly locationId: LocationId | null;
  readonly status: string;
}

/**
 * Case lookup that can only see one practice's rows (backed by row-level security, RAH-10).
 * Returns null when the case does not exist in that practice, including when it exists elsewhere.
 */
export interface CaseLookup {
  findCase(practice: PracticeId, caseId: string): Promise<CaseRef | null>;
}

/**
 * Optional, narrowly privileged probe (a security-definer function in production) that says only whether
 * a case ID exists in some other practice. Used to classify security events; it never returns the row.
 */
export interface CaseOwnershipProbe {
  belongsToAnotherPractice(caller: PracticeId, caseId: string): Promise<boolean>;
}

/**
 * An opaque reference to a credential in the practice's vault path. It never holds the secret itself;
 * the integration client redeems it at the edge.
 */
export interface CredentialHandle {
  readonly kind: 'credential_handle';
  readonly system: string;
  readonly practiceId: PracticeId;
  readonly vaultPath: string;
}

export interface CredentialHandleProvider {
  handleFor(practice: PracticeId, system: string): Promise<CredentialHandle>;
}

export interface Clock {
  now(): Date;
}
