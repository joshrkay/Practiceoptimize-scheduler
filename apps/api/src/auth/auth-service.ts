import type { IdentityProvider, LoginCallback, UserDirectory } from './ports';
import { mfaRequiredFor, normalizeScope } from './roles';
import type { Clock, Session, SessionManager } from './session';
import { systemClock } from './session';

export type SignInResult =
  | { readonly ok: true; readonly session: Session }
  | { readonly ok: false; readonly reason: 'idp_failed' | 'no_access' | 'mfa_required' | 'grant_expired' };

export class AuthService {
  constructor(
    private readonly idp: IdentityProvider,
    private readonly directory: UserDirectory,
    private readonly sessions: SessionManager,
    private readonly clock: Clock = systemClock,
  ) {}

  /** Issues a session only after a verified IdP assertion, MFA, and an explicit grant in that practice. */
  async completeSignIn(callback: LoginCallback): Promise<SignInResult> {
    let assertion;
    try {
      assertion = await this.idp.completeLogin(callback);
    } catch {
      return { ok: false, reason: 'idp_failed' };
    }
    const grant = await this.directory.findGrant(assertion.practiceId, assertion.subject);
    if (grant === null) return { ok: false, reason: 'no_access' };
    if (mfaRequiredFor(grant.role) && !assertion.mfaCompleted) return { ok: false, reason: 'mfa_required' };
    if (grant.role === 'vendor_support' && grant.expiresAt === undefined) return { ok: false, reason: 'no_access' };
    if (grant.expiresAt !== undefined && grant.expiresAt <= this.clock.now()) {
      return { ok: false, reason: 'grant_expired' };
    }
    let scope;
    try {
      scope = normalizeScope(grant.scope);
    } catch {
      return { ok: false, reason: 'no_access' };
    }
    const session = this.sessions.issue({
      userId: grant.userId,
      practiceId: assertion.practiceId,
      role: grant.role,
      scope,
      ...(grant.expiresAt !== undefined ? { expiresAtCap: grant.expiresAt } : {}),
    });
    return { ok: true, session };
  }
}
