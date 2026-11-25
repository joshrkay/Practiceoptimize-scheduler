import { randomBytes } from 'node:crypto';
import type { PracticeId, Role, Scope } from './roles';

export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

export interface AuthConfig {
  readonly sessionTtlMinutes: number;
  readonly idleLogoffMinutes: number;
}

const DEFAULTS = { sessionTtlMinutes: 480, idleLogoffMinutes: 15 };

function positive(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
  return n;
}

export function loadAuthConfig(env: Readonly<Record<string, string | undefined>>): AuthConfig {
  return {
    sessionTtlMinutes: positive(env['AUTH_SESSION_TTL_MINUTES'], DEFAULTS.sessionTtlMinutes, 'AUTH_SESSION_TTL_MINUTES'),
    idleLogoffMinutes: positive(env['AUTH_IDLE_LOGOFF_MINUTES'], DEFAULTS.idleLogoffMinutes, 'AUTH_IDLE_LOGOFF_MINUTES'),
  };
}

/** Immutable. practiceId and scope are set once at issuance from authentication; there is no way to change them. */
export interface Session {
  readonly id: string;
  readonly userId: string;
  readonly practiceId: PracticeId;
  readonly role: Role;
  readonly scope: Scope;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export type SessionCheck =
  | { readonly ok: true; readonly session: Session }
  | { readonly ok: false; readonly reason: 'unknown' | 'expired' | 'idle' };

const MS = 60_000;

export class SessionManager {
  private readonly sessions = new Map<string, { session: Session; lastActivity: Date }>();

  constructor(
    private readonly config: AuthConfig,
    private readonly clock: Clock = systemClock,
  ) {}

  /** expiresAtCap lets a time-limited grant (vendor support) shorten the session. */
  issue(input: { userId: string; practiceId: PracticeId; role: Role; scope: Scope; expiresAtCap?: Date }): Session {
    const now = this.clock.now();
    let expiresAt = new Date(now.getTime() + this.config.sessionTtlMinutes * MS);
    if (input.expiresAtCap !== undefined && input.expiresAtCap < expiresAt) expiresAt = input.expiresAtCap;
    const session: Session = Object.freeze({
      id: randomBytes(32).toString('hex'),
      userId: input.userId,
      practiceId: input.practiceId,
      role: input.role,
      scope: input.scope,
      issuedAt: now,
      expiresAt,
    });
    this.sessions.set(session.id, { session, lastActivity: now });
    return session;
  }

  /** Validates and, on success, records activity. Expired or idle sessions are removed. */
  validate(sessionId: string): SessionCheck {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) return { ok: false, reason: 'unknown' };
    const now = this.clock.now();
    if (now >= entry.session.expiresAt) {
      this.sessions.delete(sessionId);
      return { ok: false, reason: 'expired' };
    }
    if (now.getTime() - entry.lastActivity.getTime() >= this.config.idleLogoffMinutes * MS) {
      this.sessions.delete(sessionId);
      return { ok: false, reason: 'idle' };
    }
    entry.lastActivity = now;
    return { ok: true, session: entry.session };
  }

  revoke(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
