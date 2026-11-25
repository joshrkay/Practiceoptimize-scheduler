import type { EhrCapability } from '../capabilities.js';
import type { EhrConnector, LocationCapabilities } from '../connector.js';
import { locationCapabilities, withCapability } from '../guard.js';
import type { LocationSourceMap } from '../locations.js';
import type { Clock, CredentialProvider, FetchLike, RedoxEnvironment, RedoxInboundMessageStore } from '../ports.js';
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
  OrderQuery,
  Patient,
  ScheduleSlot,
  SlotQuery,
  SurgicalOrder,
  WriteReceipt,
} from '../types.js';
import { buildMeta, buildNotesNew, buildPatientSearchQuery, parseOrderMessage, parsePatientSearchResponse } from './messages.js';
import { RedoxTransport } from './transport.js';

export type RedoxOperationStatus = 'implemented' | 'placeholder';

export interface RedoxOperation {
  readonly status: RedoxOperationStatus;
  /** The Redox data model / event (or candidate) behind this capability. */
  readonly redox: string;
  readonly note: string;
}

/**
 * Which Redox calls are built, and which wait for sandbox access. A `placeholder` capability is reported
 * as `unsupported` with reason `connector_pending_verification` (and so becomes a workspace task) even
 * where the EHR supports it: we do not send messages whose wire format we have not verified.
 */
export const REDOX_OPERATIONS: Readonly<Record<EhrCapability, RedoxOperation>> = {
  'orders.read': {
    status: 'implemented',
    redox: 'Order / New, Update, Cancel (inbound, pushed to our webhook)',
    note: 'Parses stored inbound messages; field mapping unverified in a sandbox.',
  },
  'patient.read': {
    status: 'implemented',
    redox: 'PatientSearch / Query',
    note: 'Query by the location’s patient identifier type; field mapping unverified in a sandbox.',
  },
  'chart.write': {
    status: 'implemented',
    redox: 'Notes / New',
    note: 'Document ID is our idempotency key; response body is not read. Unverified in a sandbox.',
  },
  'coverage.read': {
    status: 'placeholder',
    redox: 'Candidate: insurances carried on patient or visit messages',
    note: 'Where each pilot EHR exposes coverage through Redox needs sandbox confirmation.',
  },
  'documents.read': {
    status: 'placeholder',
    redox: 'Candidate: ClinicalSummary or Media query',
    note: 'Document query support differs by EHR; needs sandbox confirmation.',
  },
  'appointments.read': {
    status: 'placeholder',
    redox: 'Candidate: Scheduling query or inbound Scheduling events',
    note: 'Needs sandbox confirmation.',
  },
  'schedule.read': {
    status: 'placeholder',
    redox: 'Candidate: Scheduling / AvailableSlots',
    note: 'Request and response shapes need sandbox confirmation.',
  },
  'appointments.book': {
    status: 'placeholder',
    redox: 'Candidate: Scheduling / New',
    note: 'Booking semantics and idempotency need sandbox confirmation.',
  },
  'inbasket.send': {
    status: 'placeholder',
    redox: 'No confirmed Redox data model; EHR-specific',
    note: 'Also marked unsupported in the provisional capability matrix.',
  },
};

const IMPLEMENTED: ReadonlySet<EhrCapability> = new Set(
  (Object.keys(REDOX_OPERATIONS) as EhrCapability[]).filter((c) => REDOX_OPERATIONS[c].status === 'implemented'),
);

export interface RedoxEhrConnectorOptions {
  readonly sources: LocationSourceMap;
  readonly fetch: FetchLike;
  readonly credentials: CredentialProvider;
  readonly inbound: RedoxInboundMessageStore;
  /** From `REDOX_ENV` (see `loadEhrConfig`). */
  readonly environment: RedoxEnvironment;
  readonly clock?: Clock;
  readonly newId?: () => string;
  /** Called for each stored inbound message that cannot be parsed, so it is dead-lettered, not lost. */
  readonly onRejectedMessage?: (info: { practiceId: string; locationId: string; receivedAt: string }) => void;
}

/** `EhrConnector` over Redox. Credentials come from the practice's vault through `CredentialProvider`. */
export class RedoxEhrConnector implements EhrConnector {
  readonly #o: RedoxEhrConnectorOptions;
  readonly #transport: RedoxTransport;
  readonly #clock: Clock;

  constructor(options: RedoxEhrConnectorOptions) {
    this.#o = options;
    this.#clock = options.clock ?? (() => new Date());
    this.#transport = new RedoxTransport({
      fetch: options.fetch,
      credentials: options.credentials,
      environment: options.environment,
      clock: this.#clock,
      ...(options.newId ? { newId: options.newId } : {}),
    });
  }

  async capabilities(ctx: EhrRequestContext): Promise<EhrResult<LocationCapabilities>> {
    return locationCapabilities(this.#o.sources, ctx, IMPLEMENTED);
  }

  listOrders(ctx: EhrRequestContext, query: OrderQuery): Promise<EhrResult<readonly SurgicalOrder[]>> {
    return this.#guard(ctx, 'orders.read', async (binding) => {
      const messages = await this.#o.inbound.list(ctx.practiceId, ctx.locationId, {
        dataModel: 'Order',
        ...(query.since !== undefined ? { since: query.since } : {}),
      });
      const orders: SurgicalOrder[] = [];
      for (const m of messages) {
        const order = parseOrderMessage(m.payload, binding.redox, ctx);
        if (order) orders.push(order);
        else this.#o.onRejectedMessage?.({ practiceId: m.practiceId, locationId: m.locationId, receivedAt: m.receivedAt });
      }
      return ok(orders);
    });
  }

  getPatient(ctx: EhrRequestContext, patientId: string): Promise<EhrResult<Patient>> {
    return this.#guard(ctx, 'patient.read', async (binding) => {
      const meta = buildMeta('PatientSearch', 'Query', binding.redox, this.#o.environment, this.#clock());
      const sent = await this.#transport.send(ctx.practiceId, buildPatientSearchQuery(meta, patientId, binding.redox));
      if (sent.status !== 'ok') return sent;
      const patient = parsePatientSearchResponse(sent.value, binding.redox);
      return patient && patient.id === patientId ? ok(patient) : ehrError('not_found', 'Patient not found.');
    }, { patientId });
  }

  writeChartDocument(ctx: EhrRequestContext, document: ChartDocumentWrite): Promise<EhrResult<WriteReceipt>> {
    return this.#guard(ctx, 'chart.write', async (binding) => {
      const meta = buildMeta('Notes', 'New', binding.redox, this.#o.environment, this.#clock());
      const sent = await this.#transport.send(ctx.practiceId, buildNotesNew(meta, document, binding.redox));
      if (sent.status !== 'ok') return sent;
      return ok({ externalId: document.idempotencyKey });
    }, { patientId: document.patientId });
  }

  // Placeholders awaiting Redox sandbox access. The guard returns `unsupported`
  // (connector_pending_verification) before `pending` can run; see REDOX_OPERATIONS.

  getCoverage(ctx: EhrRequestContext, patientId: string): Promise<EhrResult<readonly Coverage[]>> {
    return this.#guard(ctx, 'coverage.read', pending, { patientId });
  }

  listDocuments(ctx: EhrRequestContext, query: DocumentQuery): Promise<EhrResult<readonly ClinicalDocumentSummary[]>> {
    return this.#guard(ctx, 'documents.read', pending, { patientId: query.patientId });
  }

  getDocument(ctx: EhrRequestContext, patientId: string, _documentId: string): Promise<EhrResult<ClinicalDocument>> {
    return this.#guard(ctx, 'documents.read', pending, { patientId });
  }

  listAppointments(ctx: EhrRequestContext, query: AppointmentQuery): Promise<EhrResult<readonly Appointment[]>> {
    return this.#guard(ctx, 'appointments.read', pending, query.patientId === undefined ? undefined : { patientId: query.patientId });
  }

  findOpenSlots(ctx: EhrRequestContext, _query: SlotQuery): Promise<EhrResult<readonly ScheduleSlot[]>> {
    return this.#guard(ctx, 'schedule.read', pending);
  }

  bookAppointment(ctx: EhrRequestContext, request: BookAppointmentRequest): Promise<EhrResult<Appointment>> {
    return this.#guard(ctx, 'appointments.book', pending, { patientId: request.patientId });
  }

  sendInBasketMessage(ctx: EhrRequestContext, message: InBasketMessage): Promise<EhrResult<WriteReceipt>> {
    return this.#guard(ctx, 'inbasket.send', pending, message.patientId === undefined ? undefined : { patientId: message.patientId });
  }

  #guard<T>(
    ctx: EhrRequestContext,
    capability: EhrCapability,
    run: Parameters<typeof withCapability<T>>[3],
    subject?: { patientId: string },
  ): Promise<EhrResult<T>> {
    return withCapability(this.#o.sources, ctx, capability, run, {
      implemented: IMPLEMENTED,
      ...(subject ? { subject } : {}),
    });
  }
}

/* v8 ignore next 3 */
async function pending(): Promise<never> {
  throw new Error('Redox operation not implemented; guarded by REDOX_OPERATIONS.');
}
