import { describe, expect, it } from 'vitest';
import {
  AvailityConfigError,
  AvailityRequestError,
  InMemoryAuditSink,
  InMemoryCredentialProvider,
  InMemoryPracticeConnection,
  PermissionOrEnrollmentError,
  ReconnectRequiredError,
  RequestRefusedError,
  RetryableError,
  assertEndpointAllowed,
  createAvailityClient,
  loadAvailityConfig,
  type AvailityRequest,
} from './index.js';

const NOW = 1_700_000_000_000;
const GTID = 'x-test-transaction-id';
const policy = { allowedPrefixes: ['/v1/things'] };

interface Call {
  url: string;
  init: RequestInit;
}

function setup(opts: { env?: 'demo' | 'sandbox'; respond?: () => Response | Promise<Response> } = {}) {
  const calls: Call[] = [];
  const credentials = new InMemoryCredentialProvider();
  credentials.set('practice-a', { accessToken: 'token-a', expiresAt: NOW + 3_600_000 });
  credentials.set('practice-b', { accessToken: 'token-b' });
  const audit = new InMemoryAuditSink();
  const connection = new InMemoryPracticeConnection();
  const respond = opts.respond ?? (() => new Response('{"ok":true}', { status: 200, headers: { [GTID]: 'gtid-1' } }));
  const client = createAvailityClient({
    config: { environment: opts.env ?? 'sandbox', baseUrl: 'https://availity.example.test' },
    credentials,
    audit,
    connection,
    policy,
    transactionIdHeader: GTID,
    now: () => NOW,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return respond();
    },
  });
  return { client, calls, credentials, audit, connection };
}

const get = (practiceId: string, extra: Partial<AvailityRequest> = {}): AvailityRequest => ({
  practiceId,
  method: 'GET',
  path: '/v1/things/1',
  ...extra,
});

const authHeader = (c: Call | undefined) => (c?.init.headers as Record<string, string>)['authorization'];

describe('tenant-scoped call', () => {
  it('uses the practice token and records the transaction ID in the audit log', async () => {
    const { client, calls, audit } = setup();
    const res = await client.request(get('practice-a', { query: { page: '2' } }));
    expect(res).toEqual({ status: 200, transactionId: 'gtid-1', data: { ok: true } });
    expect(calls[0]?.url).toBe('https://availity.example.test/v1/things/1?page=2');
    expect(authHeader(calls[0])).toBe('Bearer token-a');
    expect(audit.records).toEqual([
      {
        practiceId: 'practice-a',
        transactionId: 'gtid-1',
        endpoint: 'GET /v1/things/1',
        status: 200,
        occurredAt: new Date(NOW).toISOString(),
      },
    ]);
    expect(JSON.stringify(audit.records)).not.toContain('page=2');
  });

  it('uses each practice own token', async () => {
    const { client, calls } = setup();
    await client.request(get('practice-b'));
    expect(authHeader(calls[0])).toBe('Bearer token-b');
  });

  it('sends a JSON body, and handles empty responses', async () => {
    const { client, calls } = setup({ respond: () => new Response(null, { status: 204 }) });
    const res = await client.request({ ...get('practice-a'), method: 'POST', body: { a: 1 }, endpointLabel: '/v1/things/{id}' });
    expect(res.data).toBeNull();
    expect(calls[0]?.init.body).toBe('{"a":1}');
    expect((calls[0]?.init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('uses the audit label instead of the path when given', async () => {
    const { client, audit } = setup();
    await client.request({ ...get('practice-a'), endpointLabel: '/v1/things/{id}' });
    expect(audit.records[0]?.endpoint).toBe('GET /v1/things/{id}');
  });

  it('refuses caller-supplied credentials', async () => {
    const { client, calls } = setup();
    await expect(client.request(get('practice-a', { query: { customerIdentifier: 'x' } }))).rejects.toBeInstanceOf(RequestRefusedError);
    await expect(
      client.request({ ...get('practice-a'), method: 'POST', body: { nested: [{ Authorization: 'Bearer evil' }] } }),
    ).rejects.toBeInstanceOf(RequestRefusedError);
    expect(calls).toHaveLength(0);
  });
});

describe('expired token (401)', () => {
  it('pauses the practice jobs, alerts via the connection port and throws reconnect required', async () => {
    const { client, audit, connection } = setup({ env: 'demo', respond: () => new Response('{}', { status: 401, headers: { [GTID]: 'g401' } }) });
    const err = await client.request(get('practice-a', { scenarioId: '401_unauthorized' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReconnectRequiredError);
    expect(connection.paused.get('practice-a')).toBe('token_rejected');
    expect(audit.records[0]).toMatchObject({ status: 401, transactionId: 'g401' });
  });

  it('does not call Availity when no token is stored', async () => {
    const { client, calls, connection, audit } = setup();
    await expect(client.request(get('practice-z'))).rejects.toBeInstanceOf(ReconnectRequiredError);
    expect(calls).toHaveLength(0);
    expect(connection.paused.get('practice-z')).toBe('token_missing');
    expect(audit.records[0]).toMatchObject({ practiceId: 'practice-z', status: 0 });
  });

  it('refreshes an expired token once and uses the new one', async () => {
    const { client, calls, credentials } = setup();
    credentials.set('practice-c', { accessToken: 'old', expiresAt: NOW - 1 }, { accessToken: 'fresh', expiresAt: NOW + 600_000 });
    await client.request(get('practice-c'));
    expect(credentials.refreshCalls).toEqual(['practice-c']);
    expect(authHeader(calls[0])).toBe('Bearer fresh');
  });

  it('requires reconnect when an expired token cannot be refreshed', async () => {
    const { client, calls, credentials, connection } = setup();
    credentials.set('practice-d', { accessToken: 'old', expiresAt: NOW + 10_000 });
    await expect(client.request(get('practice-d'))).rejects.toBeInstanceOf(ReconnectRequiredError);
    expect(connection.paused.get('practice-d')).toBe('token_expired');
    expect(calls).toHaveLength(0);
  });
});

describe('error mapping', () => {
  const status = async (code: number, headers: Record<string, string> = {}) => {
    const { client, audit } = setup({ respond: () => new Response('patient detail', { status: code, headers }) });
    const err = await client.request(get('practice-a')).catch((e: unknown) => e);
    return { err, audit };
  };

  it('maps 403 to permission or enrollment', async () => {
    const { err } = await status(403);
    expect(err).toBeInstanceOf(PermissionOrEnrollmentError);
    expect((err as PermissionOrEnrollmentError).retryable).toBe(false);
  });

  it('maps 429 and 5xx to retryable, honouring Retry-After', async () => {
    const a = (await status(429, { 'retry-after': '7' })).err as RetryableError;
    expect(a).toBeInstanceOf(RetryableError);
    expect(a.retryable).toBe(true);
    expect(a.retryAfterMs).toBe(7000);
    const b = (await status(500)).err as RetryableError;
    expect(b.retryAfterMs).toBeNull();
    const c = (await status(503, { 'retry-after': new Date(NOW + 5000).toUTCString() })).err as RetryableError;
    expect(c.retryAfterMs).toBe(5000);
    const d = (await status(503, { 'retry-after': 'garbage' })).err as RetryableError;
    expect(d.retryAfterMs).toBeNull();
  });

  it('maps other 4xx to a non-retryable error without keeping the body', async () => {
    const { err } = await status(422);
    expect(err).toBeInstanceOf(AvailityRequestError);
    expect(JSON.stringify(err)).not.toContain('patient detail');
    expect((err as Error).message).not.toContain('patient detail');
  });

  it('audits every failed call', async () => {
    const { audit } = await status(500, { [GTID]: 'g500' });
    expect(audit.records[0]).toMatchObject({ status: 500, transactionId: 'g500' });
  });

  it('treats network failures as retryable and audits status 0', async () => {
    const { client, audit } = setup({
      respond: () => {
        throw new Error('socket hang up');
      },
    });
    const err = await client.request(get('practice-a')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RetryableError);
    expect(audit.records[0]).toMatchObject({ status: 0, transactionId: null });
  });
});

describe('environments', () => {
  it('sends x-scenario-id only in demo', async () => {
    const { client, calls } = setup({ env: 'demo' });
    await client.request(get('practice-a', { scenarioId: '500_internal_server_error' }));
    expect((calls[0]?.init.headers as Record<string, string>)['x-scenario-id']).toBe('500_internal_server_error');
    await client.request(get('practice-a'));
    expect((calls[1]?.init.headers as Record<string, string>)['x-scenario-id']).toBeUndefined();
  });

  it('rejects a scenario ID outside demo', async () => {
    const { client, calls } = setup({ env: 'sandbox' });
    await expect(client.request(get('practice-a', { scenarioId: '401_unauthorized' }))).rejects.toBeInstanceOf(AvailityConfigError);
    expect(calls).toHaveLength(0);
  });

  it('loads config from AVAILITY_ENV and AVAILITY_BASE_URL', () => {
    expect(loadAvailityConfig({ AVAILITY_ENV: 'sandbox', AVAILITY_BASE_URL: 'https://a.example.test/' })).toEqual({
      environment: 'sandbox',
      baseUrl: 'https://a.example.test',
    });
    expect(loadAvailityConfig({ AVAILITY_ENV: 'demo', AVAILITY_BASE_URL: 'http://localhost:4010' }).environment).toBe('demo');
    expect(() => loadAvailityConfig({ AVAILITY_BASE_URL: 'https://a.example.test' })).toThrow(AvailityConfigError);
    expect(() => loadAvailityConfig({ AVAILITY_ENV: 'prod', AVAILITY_BASE_URL: 'https://a.example.test' })).toThrow(AvailityConfigError);
    expect(() => loadAvailityConfig({ AVAILITY_ENV: 'standard' })).toThrow(AvailityConfigError);
    expect(() => loadAvailityConfig({ AVAILITY_ENV: 'standard', AVAILITY_BASE_URL: 'nope' })).toThrow(AvailityConfigError);
    expect(() => loadAvailityConfig({ AVAILITY_ENV: 'standard', AVAILITY_BASE_URL: 'http://a.example.test' })).toThrow(AvailityConfigError);
  });
});

describe('endpoint allowlist', () => {
  const refused = (path: string) => expect(() => assertEndpointAllowed(path, policy)).toThrow(RequestRefusedError);

  it('allows listed prefixes on segment boundaries', () => {
    expect(() => assertEndpointAllowed('/v1/things', policy)).not.toThrow();
    expect(() => assertEndpointAllowed('/V1/Things/9/', policy)).not.toThrow();
    refused('/v1/thingsextra');
    refused('/v1/other');
  });

  it('refuses claim submission and remittance paths even under an allowed prefix', () => {
    const p = { allowedPrefixes: ['/v1'] };
    for (const path of ['/v1/claims', '/v1/claim-submissions/1', '/v1/Remittances', '/v1/x/era', '/v1/835', '/v1/%63laims']) {
      expect(() => assertEndpointAllowed(path, p)).toThrow(RequestRefusedError);
    }
  });

  it('refuses malformed and traversing paths', () => {
    refused('v1/things');
    refused('/v1/things?x=1');
    refused('/v1/things#f');
    refused('/v1/things\\x');
    refused('/v1/things/%3Fx');
    refused('/v1/things/../claims');
    refused('/v1/things/%2e%2e/x');
    refused('/v1/things/%zz');
    refused('/v1//things');
  });

  it('refuses a forbidden path through the client without calling fetch', async () => {
    const { client, calls, audit } = setup();
    await expect(client.request(get('practice-a', { path: '/v1/claims' }))).rejects.toBeInstanceOf(RequestRefusedError);
    expect(calls).toHaveLength(0);
    expect(audit.records).toHaveLength(0);
  });
});
