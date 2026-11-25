import type {
  AuditPort,
  Clock,
  GrantStore,
  IdGenerator,
  PracticeNotifier,
  SupportSessionPort,
} from './ports.js';
import {
  SupportAccessError,
  type AccessLogFilter,
  type AuditEventType,
  type GrantId,
  type PracticeId,
  type SessionContext,
  type SupportAuditEvent,
  type SupportGrant,
  type SupportRole,
} from './types.js';

export const DEFAULT_MAX_GRANT_HOURS = 24;
export const BREAK_GLASS_REQUIRED_APPROVERS = 2;
/** Run `sweep()` at least this often so revoked or expired sessions end within one minute. */
export const SWEEP_INTERVAL_MS = 30_000;
const MAX_REASON_LENGTH = 1000;

/** Reads `SUPPORT_GRANT_MAX_HOURS`; falls back to 24 when unset or invalid. */
export function readMaxGrantHours(env: Record<string, string | undefined>): number {
  const parsed = Number(env['SUPPORT_GRANT_MAX_HOURS']);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_GRANT_HOURS;
}

export interface SupportAccessDeps {
  readonly store: GrantStore;
  readonly audit: AuditPort;
  readonly sessions: SupportSessionPort;
  readonly notifier: PracticeNotifier;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Cap for every grant, break-glass included. */
  readonly maxGrantHours?: number;
}

export interface RequestGrantInput {
  /** The target practice. Internal sessions have no practice of their own. */
  readonly practiceId: PracticeId;
  readonly caseId?: string | undefined;
  readonly reason: string;
  readonly durationHours: number;
}

export interface BreakGlassRequestInput {
  readonly practiceId: PracticeId;
  readonly reason: string;
  readonly durationHours: number;
}

export interface AccessRequest {
  readonly practiceId: PracticeId;
  readonly caseId?: string | undefined;
  /** What the engineer is doing, e.g. `case.view`. Identifier only, no PHI. */
  readonly action: string;
}

export interface AccessDecision {
  readonly allowed: boolean;
  readonly grantId: GrantId | null;
  readonly reason: string;
}

function requireRole(session: SessionContext, role: SupportRole): void {
  if (!session.roles.includes(role)) {
    throw new SupportAccessError('forbidden', `requires role ${role}`);
  }
}

/** Practice admin acting on their own practice. Returns the practice from the session. */
function requirePracticeAdmin(session: SessionContext): PracticeId {
  requireRole(session, 'practice_admin');
  if (session.practiceId === null) {
    throw new SupportAccessError('forbidden', 'practice session required');
  }
  return session.practiceId;
}

export class SupportAccessService {
  private readonly maxHours: number;

  constructor(private readonly deps: SupportAccessDeps) {
    this.maxHours = deps.maxGrantHours ?? DEFAULT_MAX_GRANT_HOURS;
  }

  private nowIso(): string {
    return this.deps.clock.now().toISOString();
  }

  private async audit(
    type: AuditEventType,
    grant: { practiceId: PracticeId; id: GrantId | null; caseId: string | null },
    actorUserId: string,
    extra: { action?: string; detail?: string } = {},
  ): Promise<void> {
    const event: SupportAuditEvent = {
      type,
      practiceId: grant.practiceId,
      actorUserId,
      grantId: grant.id,
      caseId: grant.caseId,
      action: extra.action ?? null,
      detail: extra.detail ?? null,
      at: this.nowIso(),
    };
    await this.deps.audit.record(event);
  }

  private validate(reason: string, durationHours: number): string {
    const trimmed = typeof reason === 'string' ? reason.trim() : '';
    if (trimmed.length === 0 || trimmed.length > MAX_REASON_LENGTH) {
      throw new SupportAccessError('invalid_request', 'reason is required (1-1000 characters)');
    }
    if (typeof durationHours !== 'number' || !Number.isFinite(durationHours) || durationHours <= 0) {
      throw new SupportAccessError('invalid_request', 'durationHours must be a positive number');
    }
    if (durationHours > this.maxHours) {
      throw new SupportAccessError('invalid_request', `durationHours exceeds the maximum of ${this.maxHours}`);
    }
    return trimmed;
  }

  private newGrant(
    kind: SupportGrant['kind'],
    session: SessionContext,
    practiceId: PracticeId,
    caseId: string | null,
    reason: string,
    durationHours: number,
  ): SupportGrant {
    return {
      id: this.deps.ids.next(),
      kind,
      practiceId,
      caseId,
      requesterUserId: session.userId,
      reason,
      durationHours,
      requestedAt: this.nowIso(),
      status: 'pending',
      decidedBy: null,
      decidedAt: null,
      decisionReason: null,
      approvals: [],
      startsAt: null,
      expiresAt: null,
      endedAt: null,
      sessionsEnded: true,
    };
  }

  /** A support engineer asks a practice for time-limited access. */
  async requestGrant(session: SessionContext, input: RequestGrantInput): Promise<SupportGrant> {
    requireRole(session, 'support_engineer');
    if (typeof input.practiceId !== 'string' || input.practiceId === '') {
      throw new SupportAccessError('invalid_request', 'practiceId is required');
    }
    const reason = this.validate(input.reason, input.durationHours);
    const grant = this.newGrant(
      'standard',
      session,
      input.practiceId,
      input.caseId ?? null,
      reason,
      input.durationHours,
    );
    await this.audit('grant_requested', grant, session.userId);
    await this.deps.store.save(grant);
    return grant;
  }

  private async loadForPractice(practiceId: PracticeId, id: GrantId): Promise<SupportGrant> {
    const grant = await this.deps.store.get(id);
    // Other practices' grants are indistinguishable from missing ones.
    if (!grant || grant.practiceId !== practiceId) {
      throw new SupportAccessError('not_found', 'grant not found');
    }
    return grant;
  }

  /** Practice admin approves a pending standard grant. The clock starts at approval. */
  async approveGrant(session: SessionContext, id: GrantId): Promise<SupportGrant> {
    const practiceId = requirePracticeAdmin(session);
    const grant = await this.loadForPractice(practiceId, id);
    if (grant.kind !== 'standard' || grant.status !== 'pending') {
      throw new SupportAccessError('conflict', 'grant is not awaiting practice approval');
    }
    const now = this.deps.clock.now();
    const approved: SupportGrant = {
      ...grant,
      status: 'approved',
      decidedBy: session.userId,
      decidedAt: now.toISOString(),
      startsAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + grant.durationHours * 3_600_000).toISOString(),
      sessionsEnded: false,
    };
    // Audit first: no approval exists without its audit record.
    await this.audit('grant_approved', approved, session.userId);
    await this.deps.store.save(approved);
    return approved;
  }

  async denyGrant(session: SessionContext, id: GrantId, decisionReason?: string): Promise<SupportGrant> {
    const practiceId = requirePracticeAdmin(session);
    const grant = await this.loadForPractice(practiceId, id);
    if (grant.kind !== 'standard' || grant.status !== 'pending') {
      throw new SupportAccessError('conflict', 'grant is not awaiting practice approval');
    }
    const denied: SupportGrant = {
      ...grant,
      status: 'denied',
      decidedBy: session.userId,
      decidedAt: this.nowIso(),
      decisionReason: decisionReason?.trim() || null,
    };
    await this.audit('grant_denied', denied, session.userId);
    await this.deps.store.save(denied);
    return denied;
  }

  /**
   * Practice admin revokes a pending or active grant (standard or break-glass).
   * State is saved first so access checks fail at once; sessions are then ended,
   * and `sweep()` retries if the session store is unavailable.
   */
  async revokeGrant(session: SessionContext, id: GrantId, decisionReason?: string): Promise<SupportGrant> {
    const practiceId = requirePracticeAdmin(session);
    const grant = await this.loadForPractice(practiceId, id);
    const live = this.effectiveStatus(grant);
    if (live !== 'approved' && live !== 'pending') {
      throw new SupportAccessError('conflict', `grant is already ${live}`);
    }
    const now = this.nowIso();
    const revoked: SupportGrant = {
      ...grant,
      status: 'revoked',
      decidedBy: session.userId,
      decidedAt: now,
      decisionReason: decisionReason?.trim() || null,
      endedAt: now,
      sessionsEnded: false,
    };
    await this.deps.store.save(revoked);
    await this.audit('grant_revoked', revoked, session.userId);
    return this.endSessions(revoked, session.userId);
  }

  private async endSessions(grant: SupportGrant, actor: string): Promise<SupportGrant> {
    try {
      const count = await this.deps.sessions.endForGrant(grant.id);
      const done: SupportGrant = { ...grant, sessionsEnded: true };
      await this.deps.store.save(done);
      if (count > 0) {
        await this.audit('session_ended', done, actor, { detail: `${count} session(s) ended` });
      }
      return done;
    } catch {
      // Access is already denied by status; the sweep retries ending sessions.
      return grant;
    }
  }

  /** Status as of now: an approved grant past its expiry is expired. */
  private effectiveStatus(grant: SupportGrant): SupportGrant['status'] {
    if (
      grant.status === 'approved' &&
      grant.expiresAt !== null &&
      Date.parse(grant.expiresAt) <= this.deps.clock.now().getTime()
    ) {
      return 'expired';
    }
    return grant.status;
  }

  /**
   * Expires due grants and ends sessions of revoked or expired grants that still have any.
   * Call at least every SWEEP_INTERVAL_MS. Returns the number of grants touched.
   */
  async sweep(): Promise<number> {
    let touched = 0;
    for (const grant of await this.deps.store.list({})) {
      let current = grant;
      if (this.effectiveStatus(current) === 'expired' && current.status === 'approved') {
        current = { ...current, status: 'expired', endedAt: current.expiresAt, sessionsEnded: false };
        await this.deps.store.save(current);
        await this.audit('grant_expired', current, 'system');
        touched += 1;
      }
      if ((current.status === 'expired' || current.status === 'revoked') && !current.sessionsEnded) {
        await this.endSessions(current, 'system');
        touched += 1;
      }
    }
    return touched;
  }

  /** Engineer opens a scoped support session against an active grant of their own. */
  async openSession(session: SessionContext, id: GrantId): Promise<{ sessionId: string; expiresAt: string }> {
    requireRole(session, 'support_engineer');
    const grant = await this.deps.store.get(id);
    if (!grant || grant.requesterUserId !== session.userId) {
      throw new SupportAccessError('not_found', 'grant not found');
    }
    if (this.effectiveStatus(grant) !== 'approved' || grant.expiresAt === null) {
      throw new SupportAccessError('forbidden', 'grant is not active');
    }
    await this.audit('session_opened', grant, session.userId);
    const sessionId = await this.deps.sessions.open({
      grantId: grant.id,
      userId: session.userId,
      practiceId: grant.practiceId,
      expiresAt: grant.expiresAt,
    });
    return { sessionId, expiresAt: grant.expiresAt };
  }

  /**
   * Checks and audits one page view or action. Fails closed: if the audit record
   * cannot be written, access is refused. Cases are covered by a case-scoped grant
   * for that case or a practice-wide grant; resources with no case need practice-wide.
   */
  async checkAccess(session: SessionContext, req: AccessRequest): Promise<AccessDecision> {
    const caseId = req.caseId ?? null;
    const grants = await this.deps.store.list({ practiceId: req.practiceId, requesterUserId: session.userId });
    const covering = session.roles.includes('support_engineer')
      ? grants.find(
          (g) =>
            this.effectiveStatus(g) === 'approved' && (g.caseId === null || (caseId !== null && g.caseId === caseId)),
        )
      : undefined;
    const base = { practiceId: req.practiceId, caseId };
    if (!covering) {
      const hasGrant = grants.some((g) => this.effectiveStatus(g) === 'approved');
      const reason = hasGrant ? 'outside grant scope' : 'no active grant';
      await this.audit('phi_access_denied', { ...base, id: null }, session.userId, {
        action: req.action,
        detail: reason,
      }).catch(() => undefined);
      return { allowed: false, grantId: null, reason };
    }
    try {
      await this.audit('phi_access', { ...base, id: covering.id }, session.userId, { action: req.action });
    } catch {
      return { allowed: false, grantId: covering.id, reason: 'audit unavailable' };
    }
    return { allowed: true, grantId: covering.id, reason: 'granted' };
  }

  /** Grants for the admin's own practice, newest first. */
  async listGrants(session: SessionContext): Promise<readonly SupportGrant[]> {
    const practiceId = requirePracticeAdmin(session);
    const grants = await this.deps.store.list({ practiceId });
    return grants
      .map((g) => ({ ...g, status: this.effectiveStatus(g) }))
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  }

  /** Practice-visible access log: audit events for the admin's own practice only. */
  async accessLog(session: SessionContext, filter: AccessLogFilter = {}): Promise<readonly SupportAuditEvent[]> {
    const practiceId = requirePracticeAdmin(session);
    return this.deps.audit.query(practiceId, filter);
  }

  /**
   * Break-glass request for a production incident: practice-wide, same duration cap.
   * Needs two distinct internal approvers, neither the requester.
   */
  async requestBreakGlass(session: SessionContext, input: BreakGlassRequestInput): Promise<SupportGrant> {
    requireRole(session, 'support_engineer');
    if (typeof input.practiceId !== 'string' || input.practiceId === '') {
      throw new SupportAccessError('invalid_request', 'practiceId is required');
    }
    const reason = this.validate(input.reason, input.durationHours);
    const grant = this.newGrant('break_glass', session, input.practiceId, null, reason, input.durationHours);
    await this.audit('break_glass_requested', grant, session.userId);
    await this.deps.store.save(grant);
    return grant;
  }

  async approveBreakGlass(session: SessionContext, id: GrantId): Promise<SupportGrant> {
    requireRole(session, 'internal_approver');
    const grant = await this.deps.store.get(id);
    if (!grant || grant.kind !== 'break_glass') {
      throw new SupportAccessError('not_found', 'break-glass request not found');
    }
    if (grant.status !== 'pending') {
      throw new SupportAccessError('conflict', 'break-glass request is not pending');
    }
    if (grant.requesterUserId === session.userId) {
      throw new SupportAccessError('forbidden', 'requester cannot approve their own break-glass request');
    }
    if (grant.approvals.some((a) => a.userId === session.userId)) {
      throw new SupportAccessError('conflict', 'already approved by this approver');
    }
    const now = this.deps.clock.now();
    const approvals = [...grant.approvals, { userId: session.userId, at: now.toISOString() }];
    if (approvals.length < BREAK_GLASS_REQUIRED_APPROVERS) {
      const partial = { ...grant, approvals };
      await this.audit('break_glass_approval_recorded', partial, session.userId);
      await this.deps.store.save(partial);
      return partial;
    }
    const active: SupportGrant = {
      ...grant,
      approvals,
      status: 'approved',
      decidedBy: session.userId,
      decidedAt: now.toISOString(),
      startsAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + grant.durationHours * 3_600_000).toISOString(),
      sessionsEnded: false,
    };
    // Fail closed: notify the practice and audit before the grant becomes usable.
    await this.deps.notifier.notify({
      kind: 'break_glass_activated',
      practiceId: active.practiceId,
      grantId: active.id,
      requesterUserId: active.requesterUserId,
      approverUserIds: approvals.map((a) => a.userId),
      reason: active.reason,
      expiresAt: active.expiresAt as string,
    });
    await this.audit('break_glass_activated', active, session.userId);
    await this.deps.store.save(active);
    return active;
  }
}
