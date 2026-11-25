import { describe, expect, it } from 'vitest';
import {
  API_BASE_URL,
  buildRedoxPractice,
  credentials,
  fakeRedox,
  PRACTICE,
  TOKEN_URL,
} from '../../tests/support/redox-harness.js';
import { InMemoryCredentialProvider } from '../ports.js';
import { loadEhrConfig } from './config.js';
import { buildMeta, parseOrderMessage, parsePatientSearchResponse } from './messages.js';
import { RedoxTransport } from './transport.js';

const ctx = (ehr: string) => ({ practiceId: PRACTICE, locationId: `loc-${ehr}` });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe('loadEhrConfig', () => {
  it('reads EHR_PROVIDER and REDOX_ENV', () => {
    expect(loadEhrConfig({ EHR_PROVIDER: 'redox', REDOX_ENV: 'staging' })).toEqual({ provider: 'redox', redoxEnv: 'staging' });
    expect(loadEhrConfig({ REDOX_ENV: 'production' }).provider).toBe('redox');
  });

  it('rejects other providers and unknown environments', () => {
    expect(() => loadEhrConfig({ EHR_PROVIDER: 'direct', REDOX_ENV: 'staging' })).toThrow(/EHR_PROVIDER/);
    expect(() => loadEhrConfig({})).toThrow(/REDOX_ENV/);
    expect(() => loadEhrConfig({ REDOX_ENV: 'prod' })).toThrow(/REDOX_ENV/);
  });
});

describe('RedoxEhrConnector over fixtures', () => {
  it('Scenario 1: reads the patient at each pilot EHR, with per-EHR identifier types', async () => {
    const { connector, redox } = buildRedoxPractice();
    expect(await connector.getPatient(ctx('athenahealth'), 'ATH-100234')).toEqual({
      status: 'ok',
      value: { id: 'ATH-100234', givenName: 'Avery', familyName: 'Testpatient', birthDate: '1961-04-12', sex: 'female', phone: '555-0101' },
    });
    expect(await connector.getPatient(ctx('eclinicalworks'), 'ECW-88120')).toMatchObject({
      value: { birthDate: '1978-09-30', sex: 'male', phone: '555-0110' },
    });
    const ng = await connector.getPatient(ctx('nextgen'), 'NG-4410');
    expect(ng).toMatchObject({ value: { id: 'NG-4410', sex: 'unknown' } });
    expect(ng.status === 'ok' && 'phone' in ng.value).toBe(false);

    const sent = redox.requests.filter((r) => r.url === `${API_BASE_URL}/endpoint`).map((r) => JSON.parse(r.body));
    expect(sent.map((m) => m.Patient.Identifiers[0].IDType)).toEqual(['MR', 'MRN', 'PersonNumber']);
    expect(sent[0].Meta).toMatchObject({
      DataModel: 'PatientSearch',
      EventType: 'Query',
      Test: true,
      Destinations: [{ ID: 'dest-athenahealth' }],
      FacilityCode: 'fac-loc-athenahealth',
    });
  });

  it('authenticates with a signed client assertion from the credential provider, and caches the token', async () => {
    const { connector, redox, creds } = buildRedoxPractice();
    await connector.getPatient(ctx('athenahealth'), 'ATH-100234');
    await connector.getPatient(ctx('nextgen'), 'NG-4410');
    const tokenCalls = redox.requests.filter((r) => r.url === TOKEN_URL);
    expect(tokenCalls).toHaveLength(1);
    const form = new URLSearchParams(tokenCalls[0]!.body);
    expect(form.get('grant_type')).toBe('client_credentials');
    expect(form.get('client_assertion_type')).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    expect(form.get('client_assertion')).toBe(`test-assertion.${PRACTICE}.jti-1`);
    expect(creds.signed[0]).toMatchObject({ iss: 'client-test', sub: 'client-test', aud: TOKEN_URL, jti: 'jti-1' });
    expect(creds.signed[0]!.exp - creds.signed[0]!.iat).toBe(300);
    const apiCall = redox.requests.find((r) => r.url.endsWith('/endpoint'))!;
    expect(apiCall.headers.authorization).toBe('Bearer token-1');
  });

  it('refreshes the token once it is close to expiry', async () => {
    let now = Date.parse('2027-01-01T00:00:00.000Z');
    const { connector, redox } = buildRedoxPractice({ clock: () => new Date(now) });
    await connector.getPatient(ctx('athenahealth'), 'ATH-100234');
    now += 3600_000 - 30_000;
    await connector.getPatient(ctx('athenahealth'), 'ATH-100234');
    expect(redox.requests.filter((r) => r.url === TOKEN_URL)).toHaveLength(2);
  });

  it('retries once with a fresh token on 401, then reports auth_failed', async () => {
    const { connector, redox } = buildRedoxPractice();
    redox.queue.push(json(401, {}));
    expect(await connector.getPatient(ctx('athenahealth'), 'ATH-100234')).toMatchObject({ status: 'ok' });
    expect(redox.requests.filter((r) => r.url === TOKEN_URL)).toHaveLength(2);

    redox.queue.push(json(401, {}), json(401, {}));
    expect(await connector.getPatient(ctx('athenahealth'), 'ATH-100234')).toMatchObject({ code: 'auth_failed' });
  });

  it.each([
    [403, 'auth_failed', false],
    [404, 'not_found', false],
    [422, 'invalid_request', false],
    [429, 'upstream_error', true],
    [503, 'upstream_error', true],
  ] as const)('maps HTTP %i to %s without echoing the body', async (status, code, retryable) => {
    const { connector, redox } = buildRedoxPractice();
    redox.queue.push(json(status, { Errors: [{ Text: 'Patient Avery Testpatient' }] }));
    const result = await connector.getPatient(ctx('athenahealth'), 'ATH-100234');
    expect(result).toEqual({ status: 'error', code, retryable, message: `Redox returned ${status}.` });
  });

  it('reports network failures and non-JSON bodies as retryable upstream errors', async () => {
    const { connector, redox } = buildRedoxPractice();
    redox.queue.push(new Error('ECONNRESET'));
    expect(await connector.getPatient(ctx('athenahealth'), 'ATH-100234')).toMatchObject({ code: 'upstream_error', retryable: true });
    redox.queue.push(new Response('<html>', { status: 200 }));
    expect(await connector.getPatient(ctx('athenahealth'), 'ATH-100234')).toMatchObject({ code: 'upstream_error', retryable: true });
    redox.queue.push(new Response('', { status: 200 }));
    expect(await connector.getPatient(ctx('athenahealth'), 'ATH-100234')).toMatchObject({ code: 'not_found' });
  });

  it('maps token endpoint failures', async () => {
    const { connector, redox } = buildRedoxPractice();
    redox.tokenQueue.push(new Error('down'));
    expect(await connector.getPatient(ctx('athenahealth'), 'ATH-100234')).toMatchObject({ code: 'upstream_error', retryable: true });
    redox.tokenQueue.push(json(502, {}));
    expect(await connector.getPatient(ctx('athenahealth'), 'ATH-100234')).toMatchObject({ code: 'upstream_error', retryable: true });
    redox.tokenQueue.push(json(400, {}));
    expect(await connector.getPatient(ctx('athenahealth'), 'ATH-100234')).toMatchObject({ code: 'auth_failed', retryable: false });
    redox.tokenQueue.push(new Response('nope', { status: 200 }));
    expect(await connector.getPatient(ctx('athenahealth'), 'ATH-100234')).toMatchObject({ code: 'auth_failed' });
    redox.tokenQueue.push(json(200, { access_token: 'no-expiry' }));
    expect(await connector.getPatient(ctx('athenahealth'), 'ATH-100234')).toMatchObject({ status: 'ok' });
  });

  it('parses inbound orders per EHR and reports unparseable messages instead of dropping them silently', async () => {
    const { connector, rejected } = buildRedoxPractice();
    const ath = await connector.listOrders(ctx('athenahealth'), {});
    expect(ath).toMatchObject({
      status: 'ok',
      value: [
        {
          externalId: 'ord-ath-5001',
          status: 'new',
          priority: 'routine',
          patientId: 'ATH-100234',
          orderingProvider: { id: 'prov-ath-9', name: 'Robin Footdoc', npi: '1000000009' },
          procedures: [{ code: '28296', codeSystem: 'CPT' }],
          diagnoses: [{ code: 'M20.11', codeSystem: 'ICD-10-CM', description: 'Hallux valgus, right foot' }],
        },
        { externalId: 'ord-ath-4990', status: 'cancelled', orderedAt: '2027-01-04T08:59:00.000Z', procedures: [{ code: '28285' }] },
      ],
    });
    const ecw = await connector.listOrders(ctx('eclinicalworks'), {});
    expect(ecw).toMatchObject({ value: [{ externalId: 'ord-ecw-301', priority: 'urgent', orderingProvider: { id: '1000000017', name: 'Heelspur' } }] });
    expect(ecw.status === 'ok' && ecw.value[0]?.diagnoses).toHaveLength(1);
    expect(rejected).toEqual([{ practiceId: PRACTICE, locationId: 'loc-eclinicalworks', receivedAt: '2027-01-05T11:00:00.000Z' }]);
    expect(await connector.listOrders(ctx('nextgen'), { since: '2027-01-06T00:00:00.000Z' })).toMatchObject({
      value: [{ externalId: 'ord-ng-77', status: 'updated', priority: 'unknown' }],
    });
    expect(await connector.listOrders(ctx('nextgen'), { since: '2027-01-07T00:00:00.000Z' })).toEqual({ status: 'ok', value: [] });
  });

  it('writes a chart document as Notes / New with our idempotency key as the document ID', async () => {
    const { connector, redox } = buildRedoxPractice();
    const receipt = await connector.writeChartDocument(ctx('nextgen'), {
      patientId: 'NG-4410',
      documentType: 'Scheduling Note',
      title: 'Surgery scheduled',
      contentType: 'application/pdf',
      content: 'JVBERi0xLjQK',
      authoredAt: '2027-01-04T15:00:00.000Z',
      authorProviderId: 'prov-ng-1',
      idempotencyKey: 'case-1-note-1',
    });
    expect(receipt).toEqual({ status: 'ok', value: { externalId: 'case-1-note-1' } });
    const body = JSON.parse(redox.requests.find((r) => r.url.endsWith('/endpoint'))!.body);
    expect(body.Meta).toMatchObject({ DataModel: 'Notes', EventType: 'New', Destinations: [{ ID: 'dest-nextgen' }] });
    expect(body.Patient.Identifiers).toEqual([{ ID: 'NG-4410', IDType: 'PersonNumber' }]);
    expect(body.Note).toMatchObject({
      ContentType: 'Base64 Encoded',
      FileContents: 'JVBERi0xLjQK',
      DocumentID: 'case-1-note-1',
      DocumentType: 'Scheduling Note',
      Provider: { ID: 'prov-ng-1' },
    });
  });

  it('propagates transport errors from chart writes', async () => {
    const { connector, redox } = buildRedoxPractice();
    redox.queue.push(json(500, {}));
    const r = await connector.writeChartDocument(ctx('athenahealth'), {
      patientId: 'ATH-100234', documentType: 'Note', title: 't', contentType: 'text/plain', content: 'c',
      authoredAt: '2027-01-04T15:00:00.000Z', idempotencyKey: 'k',
    });
    expect(r).toMatchObject({ code: 'upstream_error', retryable: true });
  });

  it('reports placeholder operations as pending verification, without calling Redox', async () => {
    const { connector, redox } = buildRedoxPractice();
    const window = { from: '2027-02-01T00:00:00.000Z', to: '2027-02-02T00:00:00.000Z' };
    const results = [
      await connector.getCoverage(ctx('athenahealth'), 'ATH-100234'),
      await connector.listDocuments(ctx('athenahealth'), { patientId: 'ATH-100234' }),
      await connector.getDocument(ctx('athenahealth'), 'ATH-100234', 'doc-1'),
      await connector.listAppointments(ctx('athenahealth'), window),
      await connector.findOpenSlots(ctx('athenahealth'), window),
      await connector.bookAppointment(ctx('athenahealth'), { patientId: 'ATH-100234', providerId: 'p', visitType: 'v', start: window.from, end: window.to, idempotencyKey: 'k' }),
    ];
    for (const r of results) expect(r).toMatchObject({ status: 'unsupported', reason: 'connector_pending_verification' });
    expect(await connector.sendInBasketMessage(ctx('athenahealth'), { recipientId: 'r', subject: 's', body: 'b', idempotencyKey: 'k' }))
      .toMatchObject({ status: 'unsupported', reason: 'ehr_does_not_support' });
    expect(redox.requests).toEqual([]);
  });

  it('reports pending verification even where the location override says the EHR supports in-basket', async () => {
    const { connector, sources } = buildRedoxPractice();
    sources.register({
      practiceId: PRACTICE,
      locationId: 'loc-verified',
      ehr: 'athenahealth',
      redox: { destinationId: 'dest-athenahealth', patientIdType: 'MR' },
      capabilityOverrides: { 'inbasket.send': 'supported' },
    });
    const r = await connector.sendInBasketMessage(
      { practiceId: PRACTICE, locationId: 'loc-verified' },
      { recipientId: 'r', patientId: 'ATH-100234', subject: 's', body: 'b', idempotencyKey: 'k' },
    );
    expect(r).toMatchObject({ status: 'unsupported', reason: 'connector_pending_verification', workspaceTask: { subject: { patientId: 'ATH-100234' } } });
  });
});

describe('RedoxTransport credential guards', () => {
  it('refuses when the vault has no credentials for the practice', async () => {
    const t = new RedoxTransport({ fetch: fakeRedox({}).fetch, credentials: new InMemoryCredentialProvider({}), environment: 'development' });
    expect(await t.send('p-none', {})).toMatchObject({ code: 'auth_failed' });
  });

  it('refuses credentials for a different environment than REDOX_ENV', async () => {
    const redox = fakeRedox({});
    const t = new RedoxTransport({ fetch: redox.fetch, credentials: credentials({ environment: 'production' }), environment: 'development' });
    expect(t.environment).toBe('development');
    expect(await t.send(PRACTICE, {})).toMatchObject({ code: 'auth_failed', message: expect.stringContaining('different environment') });
    expect(redox.requests).toEqual([]);
  });

  it('uses the real clock and random IDs by default', async () => {
    const redox = fakeRedox({});
    const creds = credentials();
    const t = new RedoxTransport({ fetch: redox.fetch, credentials: creds, environment: 'development' });
    expect(await t.send(PRACTICE, { Meta: { DataModel: 'X', Destinations: [] } })).toMatchObject({ code: 'invalid_request' });
    expect(creds.signed[0]?.jti).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('Redox message parsing', () => {
  const binding = { destinationId: 'd', patientIdType: 'MR' };
  const scope = { practiceId: 'p', locationId: 'l' };

  it('marks production messages as non-test', () => {
    expect(buildMeta('Notes', 'New', binding, 'production', new Date(0))).toEqual({
      DataModel: 'Notes', EventType: 'New', EventDateTime: '1970-01-01T00:00:00.000Z', Test: false, Destinations: [{ ID: 'd' }],
    });
  });

  it.each([
    ['non-object', 'x'],
    ['missing demographics', { Patient: { Identifiers: [{ ID: '1', IDType: 'MR' }] } }],
    ['missing name', { Patient: { Identifiers: [{ ID: '1', IDType: 'MR' }], Demographics: { FirstName: 'A', DOB: '2000-01-01' } } }],
    ['other identifier type only', { Patient: { Identifiers: [{ ID: '1', IDType: 'SSN-like' }], Demographics: {} } }],
  ])('returns undefined for a patient response with %s', (_label, body) => {
    expect(parsePatientSearchResponse(body, binding)).toBeUndefined();
  });

  it.each([
    ['non-object', null],
    ['other data model', { Meta: { DataModel: 'Scheduling', EventType: 'New' }, Order: {} }],
    ['unknown event', { Meta: { DataModel: 'Order', EventType: 'GroupedOrders' }, Order: { ID: '1' }, Patient: { Identifiers: [{ ID: '1', IDType: 'MR' }] } }],
    ['no timestamp', { Meta: { DataModel: 'Order', EventType: 'New' }, Order: { ID: '1' }, Patient: { Identifiers: [{ ID: '1', IDType: 'MR' }] } }],
  ])('returns undefined for an order with %s', (_label, body) => {
    expect(parseOrderMessage(body, binding, scope)).toBeUndefined();
  });

  it('keeps an order with an unnamed provider and no procedure', () => {
    const order = parseOrderMessage(
      {
        Meta: { DataModel: 'Order', EventType: 'New', EventDateTime: '2027-01-01T00:00:00.000Z' },
        Patient: { Identifiers: [{ ID: '1', IDType: 'MR' }] },
        Order: { ID: 'o1', Provider: { ID: 'x' }, Diagnoses: 'not-an-array' },
      },
      binding,
      scope,
    );
    expect(order).toMatchObject({ orderingProvider: { id: 'x' }, procedures: [], diagnoses: [] });
    expect(order?.orderingProvider).not.toHaveProperty('name');
    expect(parseOrderMessage(
      { Meta: { DataModel: 'Order', EventType: 'New', EventDateTime: 't' }, Patient: { Identifiers: [{ ID: '1', IDType: 'MR' }] }, Order: { ID: 'o', Provider: {} } },
      binding,
      scope,
    )).not.toHaveProperty('orderingProvider');
  });
});
