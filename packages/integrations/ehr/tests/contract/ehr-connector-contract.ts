/**
 * Shared contract suite every `EhrConnector` implementation must pass.
 *
 * Usage, in a `*.test.ts` file:
 *   describeEhrConnectorContract('my connector (athenahealth)', async () => ({ connector, ctx, ... }));
 *
 * For every capability: when the location's EHR supports it the call succeeds with a well-formed value;
 * when it does not, the call returns `unsupported` with a workspace task for the same practice and
 * location. Never an empty success.
 */
import { describe, expect, it } from 'vitest';
import {
  EHR_CAPABILITIES,
  type EhrCapability,
  type EhrConnector,
  type EhrRequestContext,
  type EhrResult,
  type EhrSystem,
  type TimeWindow,
} from '../../src/index.js';

export interface EhrContractFixture {
  /** A patient that exists at `ctx`. */
  readonly patientId: string;
  /** A patient ID that does not exist at `ctx`. */
  readonly missingPatientId: string;
  /** Strings that must never appear in error messages (names, DOB of the seeded synthetic patient). */
  readonly phiMarkers: readonly string[];
  /** When `orders.read` is supported, at least this many orders exist for `ctx`. */
  readonly minOrders: number;
  /** When `documents.read` is supported, a document of `patientId`. */
  readonly documentId?: string;
  readonly providerId: string;
  /** When `schedule.read` is supported, contains at least one open slot for `providerId`. */
  readonly window: TimeWindow;
  readonly inBasketRecipientId: string;
}

export interface EhrContractHarness {
  readonly connector: EhrConnector;
  /** A mapped location with seeded data. */
  readonly ctx: EhrRequestContext;
  readonly expected: { readonly ehr: EhrSystem; readonly supported: ReadonlySet<EhrCapability> };
  readonly fixture: EhrContractFixture;
}

type Call = (h: EhrContractHarness, ctx: EhrRequestContext) => Promise<EhrResult<unknown>>;

const chartDocument = (h: EhrContractHarness, key: string) => ({
  patientId: h.fixture.patientId,
  documentType: 'Scheduling Note',
  title: 'Surgery scheduled',
  contentType: 'text/plain' as const,
  content: 'Synthetic note: surgery date confirmed with patient.',
  authoredAt: '2027-01-04T15:00:00.000Z',
  idempotencyKey: key,
});

const CALLS: Record<EhrCapability, Call> = {
  'orders.read': (h, ctx) => h.connector.listOrders(ctx, {}),
  'patient.read': (h, ctx) => h.connector.getPatient(ctx, h.fixture.patientId),
  'coverage.read': (h, ctx) => h.connector.getCoverage(ctx, h.fixture.patientId),
  'documents.read': (h, ctx) => h.connector.listDocuments(ctx, { patientId: h.fixture.patientId }),
  'appointments.read': (h, ctx) => h.connector.listAppointments(ctx, { ...h.fixture.window, patientId: h.fixture.patientId }),
  'schedule.read': (h, ctx) => h.connector.findOpenSlots(ctx, { ...h.fixture.window, providerId: h.fixture.providerId }),
  'appointments.book': (h, ctx) =>
    h.connector.bookAppointment(ctx, {
      patientId: h.fixture.patientId,
      providerId: h.fixture.providerId,
      visitType: 'Post-op',
      start: h.fixture.window.from,
      end: new Date(Date.parse(h.fixture.window.from) + 30 * 60_000).toISOString(),
      idempotencyKey: 'contract-book-1',
    }),
  'chart.write': (h, ctx) => h.connector.writeChartDocument(ctx, chartDocument(h, 'contract-doc-1')),
  'inbasket.send': (h, ctx) =>
    h.connector.sendInBasketMessage(ctx, {
      recipientId: h.fixture.inBasketRecipientId,
      patientId: h.fixture.patientId,
      subject: 'Pre-op clearance needed',
      body: 'Synthetic body text that must not leak into a workspace task.',
      idempotencyKey: 'contract-msg-1',
    }),
};

const nonEmptyString = (v: unknown) => typeof v === 'string' && v.length > 0;

const VERIFY: Record<EhrCapability, (value: unknown, h: EhrContractHarness) => void> = {
  'orders.read': (v, h) => {
    const orders = v as { practiceId: string; locationId: string; externalId: string; patientId: string; procedures: unknown[] }[];
    expect(orders.length).toBeGreaterThanOrEqual(h.fixture.minOrders);
    for (const o of orders) {
      expect(o.practiceId).toBe(h.ctx.practiceId);
      expect(o.locationId).toBe(h.ctx.locationId);
      expect(nonEmptyString(o.externalId) && nonEmptyString(o.patientId)).toBe(true);
      expect(Array.isArray(o.procedures)).toBe(true);
    }
  },
  'patient.read': (v, h) => {
    const p = v as { id: string; givenName: string; familyName: string; birthDate: string };
    expect(p.id).toBe(h.fixture.patientId);
    expect(nonEmptyString(p.givenName) && nonEmptyString(p.familyName)).toBe(true);
    expect(p.birthDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  },
  'coverage.read': (v) => {
    const c = v as { rank: number; memberId: string }[];
    expect(c.map((x) => x.rank)).toEqual([...c.map((x) => x.rank)].sort((a, b) => a - b));
    for (const x of c) expect(nonEmptyString(x.memberId)).toBe(true);
  },
  'documents.read': (v, h) => {
    for (const d of v as { patientId: string; content?: unknown }[]) {
      expect(d.patientId).toBe(h.fixture.patientId);
      expect(d).not.toHaveProperty('content');
    }
  },
  'appointments.read': (v, h) => {
    for (const a of v as { patientId: string }[]) expect(a.patientId).toBe(h.fixture.patientId);
  },
  'schedule.read': (v, h) => {
    const slots = v as { providerId: string; start: string }[];
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) {
      expect(s.providerId).toBe(h.fixture.providerId);
      expect(Date.parse(s.start)).toBeGreaterThanOrEqual(Date.parse(h.fixture.window.from));
      expect(Date.parse(s.start)).toBeLessThan(Date.parse(h.fixture.window.to));
    }
  },
  'appointments.book': (v, h) => {
    const a = v as { id: string; patientId: string; status: string };
    expect(nonEmptyString(a.id)).toBe(true);
    expect(a.patientId).toBe(h.fixture.patientId);
    expect(a.status).toBe('booked');
  },
  'chart.write': (v) => expect(nonEmptyString((v as { externalId: string }).externalId)).toBe(true),
  'inbasket.send': (v) => expect(nonEmptyString((v as { externalId: string }).externalId)).toBe(true),
};

export function describeEhrConnectorContract(
  name: string,
  makeHarness: () => EhrContractHarness | Promise<EhrContractHarness>,
): void {
  describe(`EhrConnector contract: ${name}`, () => {
    it('reports the expected capabilities for the location', async () => {
      const h = await makeHarness();
      const caps = await h.connector.capabilities(h.ctx);
      expect(caps.status).toBe('ok');
      if (caps.status !== 'ok') return;
      expect(caps.value.ehr).toBe(h.expected.ehr);
      expect([...caps.value.supported].sort()).toEqual([...h.expected.supported].sort());
    });

    for (const capability of EHR_CAPABILITIES) {
      it(`${capability}: succeeds when supported, otherwise returns unsupported with a workspace task`, async () => {
        const h = await makeHarness();
        const result = await CALLS[capability](h, h.ctx);
        if (h.expected.supported.has(capability)) {
          expect(result.status, JSON.stringify(result)).toBe('ok');
          if (result.status === 'ok') VERIFY[capability](result.value, h);
          return;
        }
        expect(result.status).toBe('unsupported');
        if (result.status !== 'unsupported') return;
        expect(result.capability).toBe(capability);
        expect(result.ehr).toBe(h.expected.ehr);
        const task = result.workspaceTask;
        expect(task).toMatchObject({
          kind: 'ehr_capability_gap',
          practiceId: h.ctx.practiceId,
          locationId: h.ctx.locationId,
          capability,
          ehr: h.expected.ehr,
        });
        expect(nonEmptyString(task.title) && nonEmptyString(task.instructions)).toBe(true);
        expect(JSON.stringify(task)).not.toContain('Synthetic body text');
      });
    }

    it('returns location_not_mapped for the same location under another practice, for every call', async () => {
      const h = await makeHarness();
      const other: EhrRequestContext = { practiceId: `${h.ctx.practiceId}-other`, locationId: h.ctx.locationId };
      const caps = await h.connector.capabilities(other);
      expect(caps).toMatchObject({ status: 'error', code: 'location_not_mapped' });
      for (const capability of EHR_CAPABILITIES) {
        expect(await CALLS[capability](h, other), capability).toMatchObject({
          status: 'error',
          code: 'location_not_mapped',
        });
      }
    });

    it('returns not_found for an unknown patient, without PHI in the message', async () => {
      const h = await makeHarness();
      if (!h.expected.supported.has('patient.read')) return;
      const result = await h.connector.getPatient(h.ctx, h.fixture.missingPatientId);
      expect(result).toMatchObject({ status: 'error', code: 'not_found' });
      if (result.status !== 'error') return;
      for (const marker of [h.fixture.missingPatientId, ...h.fixture.phiMarkers]) {
        expect(result.message).not.toContain(marker);
      }
    });

    it('chart writes are idempotent on the idempotency key', async () => {
      const h = await makeHarness();
      if (!h.expected.supported.has('chart.write')) return;
      const first = await h.connector.writeChartDocument(h.ctx, chartDocument(h, 'contract-doc-idem'));
      const second = await h.connector.writeChartDocument(h.ctx, chartDocument(h, 'contract-doc-idem'));
      expect(first.status).toBe('ok');
      expect(second).toEqual(first);
    });

    it('rejects an inverted time window as invalid_request', async () => {
      const h = await makeHarness();
      const inverted = { from: h.fixture.window.to, to: h.fixture.window.from };
      if (h.expected.supported.has('schedule.read')) {
        expect(await h.connector.findOpenSlots(h.ctx, inverted)).toMatchObject({ code: 'invalid_request' });
      }
      if (h.expected.supported.has('appointments.read')) {
        expect(await h.connector.listAppointments(h.ctx, inverted)).toMatchObject({ code: 'invalid_request' });
      }
      if (h.expected.supported.has('appointments.book')) {
        const r = await h.connector.bookAppointment(h.ctx, {
          patientId: h.fixture.patientId,
          providerId: h.fixture.providerId,
          visitType: 'Post-op',
          start: inverted.from,
          end: inverted.to,
          idempotencyKey: 'contract-book-inverted',
        });
        expect(r).toMatchObject({ code: 'invalid_request' });
      }
    });

    it('booking is idempotent on the idempotency key', async () => {
      const h = await makeHarness();
      if (!h.expected.supported.has('appointments.book')) return;
      const first = await CALLS['appointments.book'](h, h.ctx);
      const second = await CALLS['appointments.book'](h, h.ctx);
      expect(first.status).toBe('ok');
      expect(second).toEqual(first);
    });

    it('returns a single document with content when documents.read is supported', async () => {
      const h = await makeHarness();
      if (!h.expected.supported.has('documents.read') || h.fixture.documentId === undefined) return;
      const doc = await h.connector.getDocument(h.ctx, h.fixture.patientId, h.fixture.documentId);
      expect(doc.status).toBe('ok');
      if (doc.status === 'ok') {
        expect(doc.value.id).toBe(h.fixture.documentId);
        expect(nonEmptyString(doc.value.content)).toBe(true);
      }
      const missing = await h.connector.getDocument(h.ctx, h.fixture.patientId, 'no-such-document');
      expect(missing).toMatchObject({ status: 'error', code: 'not_found' });
    });
  });
}
