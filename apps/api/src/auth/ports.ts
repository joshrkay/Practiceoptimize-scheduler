import type { PracticeId, Role, Scope } from './roles';

/** Result of a completed SAML/OIDC login. practiceId comes from the practice's own IdP connection, never from the client. */
export interface IdentityAssertion {
  readonly subject: string;
  readonly practiceId: PracticeId;
  readonly mfaCompleted: boolean;
  readonly authenticatedAt: Date;
}

export interface LoginRedirect {
  readonly redirectUrl: string;
  readonly state: string;
}

export interface LoginCallback {
  readonly state: string;
  readonly code: string;
}

/** Port for SAML/OIDC. A real adapter is deferred; see the PR. */
export interface IdentityProvider {
  beginLogin(practiceId: PracticeId): Promise<LoginRedirect>;
  completeLogin(callback: LoginCallback): Promise<IdentityAssertion>;
}

/** A user's role and scope inside one practice. Vendor support grants must carry an expiry. */
export interface UserGrant {
  readonly userId: string;
  readonly role: Role;
  readonly scope: Scope;
  readonly expiresAt?: Date;
}

export interface UserDirectory {
  findGrant(practiceId: PracticeId, subject: string): Promise<UserGrant | null>;
}
