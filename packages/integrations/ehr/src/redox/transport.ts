import type { Clock, CredentialProvider, FetchLike, RedoxCredentials, RedoxEnvironment } from '../ports.js';
import { ehrError, ok, type EhrResult } from '../result.js';
import type { PracticeId } from '../types.js';

export interface RedoxTransportOptions {
  readonly fetch: FetchLike;
  readonly credentials: CredentialProvider;
  /** From `REDOX_ENV`; credentials for any other environment are refused. */
  readonly environment: RedoxEnvironment;
  readonly clock?: Clock;
  readonly newId?: () => string;
}

interface CachedToken {
  readonly accessToken: string;
  readonly expiresAt: number;
}

/** Refresh a token this long before it expires. */
const EXPIRY_SKEW_MS = 60_000;
const ASSERTION_LIFETIME_S = 300;

/**
 * Authenticated transport to the Redox data model API.
 *
 * Auth is OAuth 2.0 client credentials with a signed JWT client assertion (RFC 6749 section 4.4,
 * RFC 7523). The token URL comes from the vault with the credential. The exact claims Redox expects
 * (`aud` value, key ID header) are UNVERIFIED pending sandbox access; `aud` is set to the token URL.
 */
export class RedoxTransport {
  readonly #options: RedoxTransportOptions;
  readonly #clock: Clock;
  readonly #newId: () => string;
  readonly #tokens = new Map<PracticeId, CachedToken>();

  constructor(options: RedoxTransportOptions) {
    this.#options = options;
    this.#clock = options.clock ?? (() => new Date());
    this.#newId = options.newId ?? (() => crypto.randomUUID());
  }

  get environment(): RedoxEnvironment {
    return this.#options.environment;
  }

  /** POSTs one data model message to `${apiBaseUrl}/endpoint`, retrying once on a 401 with a fresh token. */
  async send(practiceId: PracticeId, message: unknown): Promise<EhrResult<unknown>> {
    const creds = await this.#credentials(practiceId);
    if (creds.status !== 'ok') return creds;
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.#token(practiceId, creds.value);
      if (token.status !== 'ok') return token;
      let response: Response;
      try {
        response = await this.#options.fetch(`${creds.value.apiBaseUrl}/endpoint`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token.value}`, 'content-type': 'application/json' },
          body: JSON.stringify(message),
        });
      } catch {
        return ehrError('upstream_error', 'Could not reach Redox.', true);
      }
      if (response.status === 401 && attempt === 0) {
        this.#tokens.delete(practiceId);
        continue;
      }
      return toResult(response);
    }
    /* v8 ignore next */
    return ehrError('auth_failed', 'Redox rejected the access token.');
  }

  async #credentials(practiceId: PracticeId): Promise<EhrResult<RedoxCredentials>> {
    const creds = await this.#options.credentials.getRedoxCredentials(practiceId);
    if (!creds) return ehrError('auth_failed', 'No Redox credentials in this practice’s vault path.');
    if (creds.environment !== this.#options.environment) {
      return ehrError('auth_failed', 'Redox credentials are for a different environment than REDOX_ENV.');
    }
    return ok(creds);
  }

  async #token(practiceId: PracticeId, creds: RedoxCredentials): Promise<EhrResult<string>> {
    const now = this.#clock().getTime();
    const cached = this.#tokens.get(practiceId);
    if (cached && cached.expiresAt - EXPIRY_SKEW_MS > now) return ok(cached.accessToken);

    const iat = Math.floor(now / 1000);
    const assertion = await this.#options.credentials.signRedoxClientAssertion(practiceId, {
      iss: creds.clientId,
      sub: creds.clientId,
      aud: creds.tokenUrl,
      jti: this.#newId(),
      iat,
      exp: iat + ASSERTION_LIFETIME_S,
    });
    let response: Response;
    try {
      response = await this.#options.fetch(creds.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
          client_assertion: assertion,
        }).toString(),
      });
    } catch {
      return ehrError('upstream_error', 'Could not reach the Redox token endpoint.', true);
    }
    if (!response.ok) {
      return response.status >= 500
        ? ehrError('upstream_error', `Redox token endpoint returned ${response.status}.`, true)
        : ehrError('auth_failed', `Redox token endpoint returned ${response.status}.`);
    }
    const body = (await response.json().catch(() => undefined)) as
      | { access_token?: unknown; expires_in?: unknown }
      | undefined;
    if (typeof body?.access_token !== 'string') {
      return ehrError('auth_failed', 'Redox token response had no access token.');
    }
    const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 300;
    this.#tokens.set(practiceId, { accessToken: body.access_token, expiresAt: now + expiresIn * 1000 });
    return ok(body.access_token);
  }
}

async function toResult(response: Response): Promise<EhrResult<unknown>> {
  // Vendor bodies may echo PHI, so error messages carry the status code only.
  if (response.status === 401 || response.status === 403) {
    return ehrError('auth_failed', `Redox returned ${response.status}.`);
  }
  if (response.status === 404) return ehrError('not_found', 'Redox returned 404.');
  if (response.status === 429 || response.status >= 500) {
    return ehrError('upstream_error', `Redox returned ${response.status}.`, true);
  }
  if (!response.ok) return ehrError('invalid_request', `Redox returned ${response.status}.`);
  const text = await response.text();
  if (text.trim() === '') return ok(undefined);
  try {
    return ok(JSON.parse(text) as unknown);
  } catch {
    return ehrError('upstream_error', 'Redox returned a response that is not JSON.', true);
  }
}
