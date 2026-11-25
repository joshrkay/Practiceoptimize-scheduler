import type { EhrCapability } from './capabilities.js';
import type { EhrResult } from './result.js';
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
  EhrSystem,
  InBasketMessage,
  OrderQuery,
  Patient,
  ScheduleSlot,
  SlotQuery,
  SurgicalOrder,
  WriteReceipt,
} from './types.js';

export interface LocationCapabilities {
  readonly ehr: EhrSystem;
  readonly supported: ReadonlySet<EhrCapability>;
}

/**
 * The only way our code reaches an EHR. Implementations: Redox (`redox/`) and the in-memory fake.
 *
 * Rules every implementation follows (enforced by the shared contract suite in `tests/contract/`):
 * - Every call is scoped to `ctx.practiceId` + `ctx.locationId`; an unmapped location returns
 *   `location_not_mapped`, and one practice can never read another practice's data.
 * - A capability the location's EHR connection lacks returns `unsupported` with a workspace task,
 *   never an empty success.
 * - Errors never carry PHI or vendor response bodies.
 */
export interface EhrConnector {
  /** What this location's EHR connection can do. `location_not_mapped` if unknown. */
  capabilities(ctx: EhrRequestContext): Promise<EhrResult<LocationCapabilities>>;

  /** `orders.read`: surgical orders received for this location. */
  listOrders(ctx: EhrRequestContext, query: OrderQuery): Promise<EhrResult<readonly SurgicalOrder[]>>;

  /** `patient.read`: demographics for one patient by EHR patient ID. */
  getPatient(ctx: EhrRequestContext, patientId: string): Promise<EhrResult<Patient>>;

  /** `coverage.read`: the patient's coverage, primary first. */
  getCoverage(ctx: EhrRequestContext, patientId: string): Promise<EhrResult<readonly Coverage[]>>;

  /** `documents.read`: document list for a patient. */
  listDocuments(
    ctx: EhrRequestContext,
    query: DocumentQuery,
  ): Promise<EhrResult<readonly ClinicalDocumentSummary[]>>;

  /** `documents.read`: one document with content. */
  getDocument(
    ctx: EhrRequestContext,
    patientId: string,
    documentId: string,
  ): Promise<EhrResult<ClinicalDocument>>;

  /** `appointments.read`. */
  listAppointments(
    ctx: EhrRequestContext,
    query: AppointmentQuery,
  ): Promise<EhrResult<readonly Appointment[]>>;

  /** `schedule.read`: open slots. */
  findOpenSlots(ctx: EhrRequestContext, query: SlotQuery): Promise<EhrResult<readonly ScheduleSlot[]>>;

  /** `appointments.book`. Idempotent on `request.idempotencyKey`. */
  bookAppointment(
    ctx: EhrRequestContext,
    request: BookAppointmentRequest,
  ): Promise<EhrResult<Appointment>>;

  /** `chart.write`: write a document or note back to the chart. Idempotent on `idempotencyKey`. */
  writeChartDocument(
    ctx: EhrRequestContext,
    document: ChartDocumentWrite,
  ): Promise<EhrResult<WriteReceipt>>;

  /** `inbasket.send`. Idempotent on `idempotencyKey`. */
  sendInBasketMessage(
    ctx: EhrRequestContext,
    message: InBasketMessage,
  ): Promise<EhrResult<WriteReceipt>>;
}

/** Validates a time window; returns an error message or undefined. */
export function invalidWindow(window: { from: string; to: string }): string | undefined {
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  if (Number.isNaN(from) || Number.isNaN(to)) return 'Time window must use ISO timestamps.';
  if (to <= from) return 'Time window must end after it starts.';
  return undefined;
}
