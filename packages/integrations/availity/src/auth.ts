import type { ConnectionIssue, CredentialProvider, PracticeConnectionPort, PracticeId } from './ports.js';
import { ReconnectRequiredError } from './errors.js';

export interface TokenResolverOptions {
  credentials: CredentialProvider;
  connection: PracticeConnectionPort;
  now?: () => number;
  /** Treat tokens expiring within this window as expired. Default 30s. */
  skewMs?: number;
}

/** Resolves the practice's own bearer token. The caller never supplies a token. */
export function createTokenResolver(opts: TokenResolverOptions) {
  const now = opts.now ?? Date.now;
  const skew = opts.skewMs ?? 30_000;
  const expired = (t: { expiresAt?: number }) => t.expiresAt !== undefined && t.expiresAt - skew <= now();

  async function fail(practiceId: PracticeId, issue: ConnectionIssue): Promise<never> {
    await opts.connection.reconnectRequired(practiceId, issue);
    throw new ReconnectRequiredError(practiceId, 0, null);
  }

  return async function resolve(practiceId: PracticeId): Promise<string> {
    let token = await opts.credentials.getToken(practiceId);
    if (!token) return fail(practiceId, 'token_missing');
    if (expired(token)) {
      token = (await opts.credentials.refreshToken?.(practiceId)) ?? null;
      if (!token || expired(token)) return fail(practiceId, 'token_expired');
    }
    return token.accessToken;
  };
}
