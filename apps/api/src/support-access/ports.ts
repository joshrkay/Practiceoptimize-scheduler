import type {
  AccessLogFilter,
  GrantId,
  PracticeId,
  SupportAuditEvent,
  SupportGrant,
  UserId,
} from './types.js';

/** Injected clock so expiry is testable. */
export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}

/**
 * Audit log port. Wire to the immutable audit log (RAH-8) at integration.
 * `record` must reject when the event could not be durably written.
 */
export interface AuditPort {
  record(event: SupportAuditEvent): Promise<void>;
  /** Events for one practice only, oldest first. */
  query(practiceId: PracticeId, filter: AccessLogFilter): Promise<readonly SupportAuditEvent[]>;
}

/**
 * Support-session port. Wire to the auth session store (RAH-12) at integration.
 * Sessions opened here are the scoped, time-limited support sessions.
 */
export interface SupportSessionPort {
  open(input: {
    grantId: GrantId;
    userId: UserId;
    practiceId: PracticeId;
    expiresAt: string;
  }): Promise<string>;
  /** Ends every live session tied to the grant; returns how many were ended. */
  endForGrant(grantId: GrantId): Promise<number>;
}

export interface PracticeNotification {
  readonly kind: 'break_glass_activated';
  readonly practiceId: PracticeId;
  readonly grantId: GrantId;
  readonly requesterUserId: UserId;
  readonly approverUserIds: readonly UserId[];
  readonly reason: string;
  readonly expiresAt: string;
}

/** Notifies the practice's admins (email, in-app). Must reject if delivery could not be queued. */
export interface PracticeNotifier {
  notify(notification: PracticeNotification): Promise<void>;
}

/** Persistence for grants. Returned objects are treated as immutable snapshots. */
export interface GrantStore {
  get(id: GrantId): Promise<SupportGrant | undefined>;
  save(grant: SupportGrant): Promise<void>;
  list(filter: { practiceId?: PracticeId; requesterUserId?: UserId }): Promise<readonly SupportGrant[]>;
}
