import { assertEndpointAllowed, type EndpointPolicy } from './allowlist.js';
import { createTokenResolver } from './auth.js';
import type { AvailityConfig } from './config.js';
import {
  AvailityConfigError,
  AvailityRequestError,
  PermissionOrEnrollmentError,
  ReconnectRequiredError,
  RequestRefusedError,
  RetryableError,
} from './errors.js';
import type { AuditSink, CredentialProvider, PracticeConnectionPort, PracticeId } from './ports.js';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface AvailityClientOptions {
  config: AvailityConfig;
  credentials: CredentialProvider;
  audit: AuditSink;
  connection: PracticeConnectionPort;
  policy: EndpointPolicy;
  /** Response header carrying the Availity transaction ID (GTID). Confirm against the spec. */
  transactionIdHeader: string;
  fetch: FetchLike;
  now?: () => number;
}

export interface AvailityRequest {
  practiceId: PracticeId;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Path starting with "/", no query string and no PHI. */
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  /** Demo environment only: sent as x-scenario-id. */
  scenarioId?: string;
  /** Audit label to use instead of the path (for paths that embed identifiers). */
  endpointLabel?: string;
}

export interface AvailityResponse<T = unknown> {
  status: number;
  transactionId: string | null;
  data: T;
}

const FORBIDDEN_KEYS = new Set(['customeridentifier', 'authorization', 'access_token', 'accesstoken']);

function assertNoCallerCredentials(req: AvailityRequest): void {
  const scan = (value: unknown, depth: number): void => {
    if (depth > 6 || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach((v) => scan(v, depth + 1));
      return;
    }
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(k.toLowerCase())) {
        throw new RequestRefusedError(`Callers may not supply "${k}"; the client injects it per practice`);
      }
      scan(v, depth + 1);
    }
  };
  scan(req.query, 0);
  scan(req.body, 0);
}

function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

export function createAvailityClient(opts: AvailityClientOptions) {
  const now = opts.now ?? Date.now;
  const resolveToken = createTokenResolver({ credentials: opts.credentials, connection: opts.connection, now });
  const demo = opts.config.environment === 'demo';

  async function request<T = unknown>(req: AvailityRequest): Promise<AvailityResponse<T>> {
    assertEndpointAllowed(req.path, opts.policy);
    assertNoCallerCredentials(req);
    if (req.scenarioId !== undefined && !demo) {
      throw new AvailityConfigError('scenarioId is only valid when AVAILITY_ENV is demo');
    }
    const endpoint = `${req.method} ${req.endpointLabel ?? req.path}`;
    const audit = (status: number, transactionId: string | null) =>
      opts.audit.record({
        practiceId: req.practiceId,
        transactionId,
        endpoint,
        status,
        occurredAt: new Date(now()).toISOString(),
      });

    let token: string;
    try {
      token = await resolveToken(req.practiceId);
    } catch (err) {
      if (err instanceof ReconnectRequiredError) await audit(0, null);
      throw err;
    }

    const url = new URL(opts.config.baseUrl + req.path);
    for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json' };
    if (req.body !== undefined) headers['content-type'] = 'application/json';
    if (demo && req.scenarioId !== undefined) headers['x-scenario-id'] = req.scenarioId;

    let res: Response;
    try {
      res = await opts.fetch(url.toString(), {
        method: req.method,
        headers,
        ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
      });
    } catch {
      await audit(0, null);
      throw new RetryableError({ practiceId: req.practiceId, status: 0, transactionId: null, retryAfterMs: null });
    }

    const transactionId = res.headers.get(opts.transactionIdHeader);
    await audit(res.status, transactionId);
    const ctx = { practiceId: req.practiceId, status: res.status, transactionId };

    if (res.ok) {
      const text = await res.text();
      return { status: res.status, transactionId, data: (text ? JSON.parse(text) : null) as T };
    }
    if (res.status === 401) {
      await opts.connection.reconnectRequired(req.practiceId, 'token_rejected');
      throw new ReconnectRequiredError(req.practiceId, 401, transactionId);
    }
    if (res.status === 403) throw new PermissionOrEnrollmentError(ctx);
    if (res.status === 429 || res.status >= 500) {
      throw new RetryableError({ ...ctx, retryAfterMs: parseRetryAfter(res.headers.get('retry-after'), now()) });
    }
    throw new AvailityRequestError(ctx);
  }

  return { request };
}

export type AvailityClient = ReturnType<typeof createAvailityClient>;
