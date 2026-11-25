/** Shared types for practice-approved, time-limited support access to PHI. */

export type PracticeId = string;
export type UserId = string;
export type GrantId = string;

/** Roles relevant to support access. `support_engineer` carries no standing PHI access. */
export type SupportRole = 'support_engineer' | 'internal_approver' | 'practice_admin';

/**
 * The authenticated session as provided by the auth module (ported in ports.ts).
 * Internal staff sessions have `practiceId: null`; practice staff sessions always have one.
 */
export interface SessionContext {
  readonly userId: UserId;
  readonly practiceId: PracticeId | null;
  readonly roles: readonly SupportRole[];
}

export type GrantKind = 'standard' | 'break_glass';

export type GrantStatus = 'pending' | 'approved' | 'denied' | 'revoked' | 'expired';

export interface GrantApproval {
  readonly userId: UserId;
  readonly at: string;
}

export interface SupportGrant {
  readonly id: GrantId;
  readonly kind: GrantKind;
  readonly practiceId: PracticeId;
  /** Null means practice-wide. Break-glass grants are always practice-wide. */
  readonly caseId: string | null;
  readonly requesterUserId: UserId;
  readonly reason: string;
  readonly durationHours: number;
  readonly requestedAt: string;
  readonly status: GrantStatus;
  /** Practice admin (standard grants) who decided; null while pending. */
  readonly decidedBy: UserId | null;
  readonly decidedAt: string | null;
  readonly decisionReason: string | null;
  /** Break-glass: internal approvers so far (needs two distinct, neither the requester). */
  readonly approvals: readonly GrantApproval[];
  readonly startsAt: string | null;
  readonly expiresAt: string | null;
  readonly endedAt: string | null;
  /** False while a revoked or expired grant may still have live support sessions. */
  readonly sessionsEnded: boolean;
}

export type AuditEventType =
  | 'grant_requested'
  | 'grant_approved'
  | 'grant_denied'
  | 'grant_revoked'
  | 'grant_expired'
  | 'break_glass_requested'
  | 'break_glass_approval_recorded'
  | 'break_glass_activated'
  | 'session_opened'
  | 'session_ended'
  | 'phi_access'
  | 'phi_access_denied';

/** Audit record. Holds identifiers and reason codes only, never PHI values. */
export interface SupportAuditEvent {
  readonly type: AuditEventType;
  readonly practiceId: PracticeId;
  readonly actorUserId: UserId;
  readonly grantId: GrantId | null;
  readonly caseId: string | null;
  /** For phi_access: the action performed, e.g. `case.view`. */
  readonly action: string | null;
  readonly detail: string | null;
  readonly at: string;
}

export interface AccessLogFilter {
  readonly grantId?: GrantId;
  readonly caseId?: string;
  readonly from?: string;
  readonly to?: string;
  readonly limit?: number;
}

export type SupportAccessErrorCode = 'forbidden' | 'not_found' | 'invalid_request' | 'conflict';

export class SupportAccessError extends Error {
  readonly code: SupportAccessErrorCode;
  constructor(code: SupportAccessErrorCode, message: string) {
    super(message);
    this.name = 'SupportAccessError';
    this.code = code;
  }
}
