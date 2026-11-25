/**
 * Ports the Availity client needs from other packages. Real implementations are wired at integration:
 * CredentialProvider by the credential vault (RAH-11), AuditSink by @scheduler/audit,
 * PracticeConnectionPort by the per-practice job queue and alerting (RAH-14).
 */

export type PracticeId = string;

export interface AccessToken {
  accessToken: string;
  /** Epoch milliseconds. Omit when the vault does not know the expiry. */
  expiresAt?: number;
}

export interface CredentialProvider {
  /** Returns the practice's current token from its vault path, or null when none is stored. */
  getToken(practiceId: PracticeId): Promise<AccessToken | null>;
  /** Optional: obtain a fresh token (and store it) when the current one is expired. Null if it cannot. */
  refreshToken?(practiceId: PracticeId): Promise<AccessToken | null>;
}

export interface AvailityAuditRecord {
  practiceId: PracticeId;
  /** Availity transaction ID from the response, or null when absent. Never PHI. */
  transactionId: string | null;
  /** `METHOD /path` without query string. */
  endpoint: string;
  /** HTTP status, or 0 when no response was received. */
  status: number;
  occurredAt: string;
}

export interface AuditSink {
  record(entry: AvailityAuditRecord): Promise<void>;
}

export type ConnectionIssue = 'token_missing' | 'token_expired' | 'token_rejected';

export interface PracticeConnectionPort {
  /** Pause the practice's Availity jobs and alert its admin to reconnect. Must be idempotent. */
  reconnectRequired(practiceId: PracticeId, issue: ConnectionIssue): Promise<void>;
}
