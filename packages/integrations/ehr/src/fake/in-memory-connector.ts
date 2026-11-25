import type { EhrConnector, LocationCapabilities } from '../connector.js';
import { invalidWindow } from '../connector.js';
import { locationCapabilities, withCapability } from '../guard.js';
import type { LocationSourceMap } from '../locations.js';
import { ehrError, ok, type EhrResult } from '../result.js';
import type {
  Appointment,
  AppointmentQuery,
  BookAppointmentRequest,
  ChartDocumentWrite,
  ClinicalDocument,
  ClinicalDocumentSummary,
  Coverage,
  DocumentQuery,
  EhrRequestContext,
  InBasketMessage,
  LocationId,
  OrderQuery,
  Patient,
  PracticeId,
  ScheduleSlot,
  SlotQuery,
  SurgicalOrder,
  WriteReceipt,
} from '../types.js';

/** Seed data for one location's EHR. */
export interface FakeEhrLocationData {
  patients?: Patient[];
  coverage?: Record<string, Coverage[]>;
  orders?: (SurgicalOrder & { receivedAt: string })[];
  documents?: ClinicalDocument[];
  appointments?: Appointment[];
  slots?: ScheduleSlot[];
}

interface LocationStore {
  patients: Map<string, Patient>;
  coverage: Map<string, Coverage[]>;
  orders: (SurgicalOrder & { receivedAt: string })[];
  documents: ClinicalDocument[];
  appointments: Appointment[];
  slots: ScheduleSlot[];
  writtenDocuments: Map<string, ChartDocumentWrite>;
  inBasket: Map<string, InBasketMessage>;
  bookings: Map<string, Appointment>;
}

const key = (practiceId: PracticeId, locationId: LocationId) => `${practiceId}\u0000${locationId}`;
const inWindow = (iso: string, from: string, to: string) =>
  Date.parse(iso) >= Date.parse(from) && Date.parse(iso) < Date.parse(to);

/**
 * In-memory EHR connector for tests and local development. Honors the same location mapping and
 * capability matrix as the real connector, and passes the shared contract suite.
 */
export class InMemoryEhrConnector implements EhrConnector {
  readonly #sources: LocationSourceMap;
  readonly #stores = new Map<string, LocationStore>();

  constructor(sources: LocationSourceMap) {
    this.#sources = sources;
  }

  seed(practiceId: PracticeId, locationId: LocationId, data: FakeEhrLocationData): this {
    const store = this.#store({ practiceId, locationId });
    for (const p of data.patients ?? []) store.patients.set(p.id, p);
    for (const [patientId, c] of Object.entries(data.coverage ?? {})) store.coverage.set(patientId, c);
    store.orders.push(...(data.orders ?? []));
    store.documents.push(...(data.documents ?? []));
    store.appointments.push(...(data.appointments ?? []));
    store.slots.push(...(data.slots ?? []));
    return this;
  }

  /** Test inspection: what was written back to this location's chart and in-basket. */
  writes(ctx: EhrRequestContext): { documents: ChartDocumentWrite[]; inBasket: InBasketMessage[] } {
    const store = this.#store(ctx);
    return { documents: [...store.writtenDocuments.values()], inBasket: [...store.inBasket.values()] };
  }

  async capabilities(ctx: EhrRequestContext): Promise<EhrResult<LocationCapabilities>> {
    return locationCapabilities(this.#sources, ctx);
  }

  listOrders(ctx: EhrRequestContext, query: OrderQuery): Promise<EhrResult<readonly SurgicalOrder[]>> {
    return withCapability(this.#sources, ctx, 'orders.read', async () => {
      const since = query.since === undefined ? undefined : Date.parse(query.since);
      return ok(
        this.#store(ctx)
          .orders.filter((o) => since === undefined || Date.parse(o.receivedAt) >= since)
          .map(({ receivedAt: _r, ...order }) => order),
      );
    });
  }

  getPatient(ctx: EhrRequestContext, patientId: string): Promise<EhrResult<Patient>> {
    return withCapability(this.#sources, ctx, 'patient.read', async () => {
      const patient = this.#store(ctx).patients.get(patientId);
      return patient ? ok(patient) : ehrError('not_found', 'Patient not found.');
    }, { subject: { patientId } });
  }

  getCoverage(ctx: EhrRequestContext, patientId: string): Promise<EhrResult<readonly Coverage[]>> {
    return withCapability(this.#sources, ctx, 'coverage.read', async () => {
      const store = this.#store(ctx);
      if (!store.patients.has(patientId)) return ehrError('not_found', 'Patient not found.');
      return ok([...(store.coverage.get(patientId) ?? [])].sort((a, b) => a.rank - b.rank));
    }, { subject: { patientId } });
  }

  listDocuments(
    ctx: EhrRequestContext,
    query: DocumentQuery,
  ): Promise<EhrResult<readonly ClinicalDocumentSummary[]>> {
    return withCapability(this.#sources, ctx, 'documents.read', async () => {
      const store = this.#store(ctx);
      if (!store.patients.has(query.patientId)) return ehrError('not_found', 'Patient not found.');
      const since = query.since === undefined ? undefined : Date.parse(query.since);
      return ok(
        store.documents
          .filter((d) => d.patientId === query.patientId)
          .filter((d) => since === undefined || Date.parse(d.authoredAt) >= since)
          .map(({ content: _c, contentType: _t, ...summary }) => summary),
      );
    }, { subject: { patientId: query.patientId } });
  }

  getDocument(
    ctx: EhrRequestContext,
    patientId: string,
    documentId: string,
  ): Promise<EhrResult<ClinicalDocument>> {
    return withCapability(this.#sources, ctx, 'documents.read', async () => {
      const doc = this.#store(ctx).documents.find((d) => d.id === documentId && d.patientId === patientId);
      return doc ? ok(doc) : ehrError('not_found', 'Document not found.');
    }, { subject: { patientId } });
  }

  listAppointments(
    ctx: EhrRequestContext,
    query: AppointmentQuery,
  ): Promise<EhrResult<readonly Appointment[]>> {
    return withCapability(this.#sources, ctx, 'appointments.read', async () => {
      const invalid = invalidWindow(query);
      if (invalid) return ehrError('invalid_request', invalid);
      return ok(
        this.#store(ctx).appointments.filter(
          (a) =>
            inWindow(a.start, query.from, query.to) &&
            (query.patientId === undefined || a.patientId === query.patientId) &&
            (query.providerId === undefined || a.providerId === query.providerId),
        ),
      );
    }, query.patientId === undefined ? {} : { subject: { patientId: query.patientId } });
  }

  findOpenSlots(ctx: EhrRequestContext, query: SlotQuery): Promise<EhrResult<readonly ScheduleSlot[]>> {
    return withCapability(this.#sources, ctx, 'schedule.read', async () => {
      const invalid = invalidWindow(query);
      if (invalid) return ehrError('invalid_request', invalid);
      const store = this.#store(ctx);
      return ok(
        store.slots.filter(
          (s) =>
            inWindow(s.start, query.from, query.to) &&
            (query.providerId === undefined || s.providerId === query.providerId) &&
            (query.visitType === undefined || s.visitType === query.visitType) &&
            !store.appointments.some(
              (a) => a.status === 'booked' && a.providerId === s.providerId && a.start === s.start,
            ),
        ),
      );
    });
  }

  bookAppointment(ctx: EhrRequestContext, request: BookAppointmentRequest): Promise<EhrResult<Appointment>> {
    return withCapability(this.#sources, ctx, 'appointments.book', async () => {
      const invalid = invalidWindow({ from: request.start, to: request.end });
      if (invalid) return ehrError('invalid_request', invalid);
      const store = this.#store(ctx);
      const existing = store.bookings.get(request.idempotencyKey);
      if (existing) return ok(existing);
      if (!store.patients.has(request.patientId)) return ehrError('not_found', 'Patient not found.');
      const appointment: Appointment = {
        id: `appt-${store.appointments.length + 1}`,
        patientId: request.patientId,
        providerId: request.providerId,
        visitType: request.visitType,
        start: request.start,
        end: request.end,
        status: 'booked',
      };
      store.appointments.push(appointment);
      store.bookings.set(request.idempotencyKey, appointment);
      return ok(appointment);
    }, { subject: { patientId: request.patientId } });
  }

  writeChartDocument(ctx: EhrRequestContext, document: ChartDocumentWrite): Promise<EhrResult<WriteReceipt>> {
    return withCapability(this.#sources, ctx, 'chart.write', async () => {
      const store = this.#store(ctx);
      if (!store.patients.has(document.patientId)) return ehrError('not_found', 'Patient not found.');
      store.writtenDocuments.set(document.idempotencyKey, document);
      return ok({ externalId: document.idempotencyKey });
    }, { subject: { patientId: document.patientId } });
  }

  sendInBasketMessage(ctx: EhrRequestContext, message: InBasketMessage): Promise<EhrResult<WriteReceipt>> {
    return withCapability(this.#sources, ctx, 'inbasket.send', async () => {
      this.#store(ctx).inBasket.set(message.idempotencyKey, message);
      return ok({ externalId: message.idempotencyKey });
    }, message.patientId === undefined ? {} : { subject: { patientId: message.patientId } });
  }

  #store(ctx: { practiceId: PracticeId; locationId: LocationId }): LocationStore {
    const k = key(ctx.practiceId, ctx.locationId);
    let store = this.#stores.get(k);
    if (!store) {
      store = {
        patients: new Map(),
        coverage: new Map(),
        orders: [],
        documents: [],
        appointments: [],
        slots: [],
        writtenDocuments: new Map(),
        inBasket: new Map(),
        bookings: new Map(),
      };
      this.#stores.set(k, store);
    }
    return store;
  }
}
