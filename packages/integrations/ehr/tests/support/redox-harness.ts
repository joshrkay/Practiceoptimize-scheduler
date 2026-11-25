/**
 * Test harness: a Redox connector over a fake `fetch` that answers from synthetic per-EHR fixtures.
 * No network. Token endpoint and data model endpoint are simulated.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  InMemoryCredentialProvider,
  InMemoryRedoxInboundMessageStore,
  LocationSourceMap,
  RedoxEhrConnector,
  type EhrSystem,
  type FetchLike,
  type LocationSourceBinding,
  type RedoxCredentials,
} from '../../src/index.js';

export const TOKEN_URL = 'https://redox.test/auth/token';
export const API_BASE_URL = 'https://redox.test';

export interface RedoxFixtureSet {
  readonly ehr: EhrSystem;
  readonly patientId: string;
  readonly patientIdType: string;
  readonly phiMarkers: readonly string[];
  readonly patientSearchResponse: unknown;
  readonly orders: { receivedAt: string; payload: unknown }[];
}

const fixtureDir = (ehr: EhrSystem) => fileURLToPath(new URL(`../fixtures/redox/${ehr}/`, import.meta.url));
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

const META: Record<EhrSystem, { patientId: string; patientIdType: string; phiMarkers: string[] }> = {
  athenahealth: { patientId: 'ATH-100234', patientIdType: 'MR', phiMarkers: ['Avery', 'Testpatient', '1961-04-12'] },
  eclinicalworks: { patientId: 'ECW-88120', patientIdType: 'MRN', phiMarkers: ['Blake', 'Samplecase', '1978-09-30'] },
  nextgen: { patientId: 'NG-4410', patientIdType: 'PersonNumber', phiMarkers: ['Casey', 'Fixtureton', '1990-01-15'] },
};

export function loadRedoxFixtures(ehr: EhrSystem): RedoxFixtureSet {
  const dir = fixtureDir(ehr);
  return {
    ehr,
    ...META[ehr],
    patientSearchResponse: readJson(`${dir}patient-search-response.json`),
    orders: (readJson(`${dir}orders.json`) as { messages: RedoxFixtureSet['orders'] }).messages,
  };
}

export interface RecordedRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

export interface FakeRedox {
  readonly fetch: FetchLike;
  readonly requests: RecordedRequest[];
  /** Queue raw responses for the data model endpoint, consumed before fixture routing. */
  readonly queue: (Response | Error)[];
  /** Queue raw responses for the token endpoint. */
  readonly tokenQueue: (Response | Error)[];
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Fake Redox: answers PatientSearch from the fixture set for the destination, accepts Notes/New. */
export function fakeRedox(byDestination: Record<string, RedoxFixtureSet>): FakeRedox {
  const requests: RecordedRequest[] = [];
  const queue: (Response | Error)[] = [];
  const tokenQueue: (Response | Error)[] = [];
  let tokens = 0;
  const take = (q: (Response | Error)[]) => {
    const next = q.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  const fetch: FetchLike = async (url, init) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    requests.push({ url, headers, body: String(init.body) });
    if (url === TOKEN_URL) {
      return take(tokenQueue) ?? json(200, { access_token: `token-${++tokens}`, expires_in: 3600 });
    }
    if (url !== `${API_BASE_URL}/endpoint`) return json(404, {});
    const queued = take(queue);
    if (queued) return queued;
    const message = JSON.parse(String(init.body)) as {
      Meta: { DataModel: string; Destinations: { ID: string }[] };
      Patient?: { Identifiers?: { ID: string }[] };
    };
    const set = byDestination[message.Meta.Destinations[0]?.ID ?? ''];
    if (!set) return json(400, { Errors: [{ Text: 'unknown destination' }] });
    switch (message.Meta.DataModel) {
      case 'PatientSearch':
        return message.Patient?.Identifiers?.[0]?.ID === set.patientId
          ? json(200, set.patientSearchResponse)
          : json(200, { Meta: { DataModel: 'PatientSearch', EventType: 'Response' }, Patient: { Identifiers: [] } });
      case 'Notes':
        return new Response('', { status: 200 });
      default:
        return json(400, {});
    }
  };
  return { fetch, requests, queue, tokenQueue };
}

export const PRACTICE = 'practice-podiatry-pilot';

export function bindingFor(set: RedoxFixtureSet, locationId: string): LocationSourceBinding {
  return {
    practiceId: PRACTICE,
    locationId,
    ehr: set.ehr,
    redox: { destinationId: `dest-${set.ehr}`, patientIdType: set.patientIdType, facilityCode: `fac-${locationId}` },
  };
}

export const credentials = (overrides: Partial<RedoxCredentials> = {}) =>
  new InMemoryCredentialProvider({
    [PRACTICE]: {
      environment: 'development',
      clientId: 'client-test',
      tokenUrl: TOKEN_URL,
      apiBaseUrl: API_BASE_URL,
      ...overrides,
    },
  });

/** One practice, three locations, one per pilot EHR, all through Redox. */
export function buildRedoxPractice(options: { clock?: () => Date } = {}) {
  const sets = (['athenahealth', 'eclinicalworks', 'nextgen'] as const).map(loadRedoxFixtures);
  const bindings = sets.map((s) => bindingFor(s, `loc-${s.ehr}`));
  const sources = new LocationSourceMap(bindings);
  const inbound = new InMemoryRedoxInboundMessageStore();
  for (const s of sets) {
    for (const m of s.orders) inbound.add({ practiceId: PRACTICE, locationId: `loc-${s.ehr}`, ...m });
  }
  const redox = fakeRedox(Object.fromEntries(sets.map((s) => [`dest-${s.ehr}`, s])));
  const creds = credentials();
  const rejected: { practiceId: string; locationId: string; receivedAt: string }[] = [];
  const connector = new RedoxEhrConnector({
    sources,
    fetch: redox.fetch,
    credentials: creds,
    inbound,
    environment: 'development',
    newId: (() => {
      let n = 0;
      return () => `jti-${++n}`;
    })(),
    onRejectedMessage: (info) => rejected.push(info),
    ...(options.clock ? { clock: options.clock } : {}),
  });
  return { connector, sets, sources, inbound, redox, creds, rejected };
}
