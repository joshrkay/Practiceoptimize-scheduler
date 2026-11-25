/**
 * Translation between our domain types and Redox data model messages.
 *
 * Shapes follow Redox's published data model conventions (a `Meta` block with `DataModel`, `EventType`,
 * `Test`, `Destinations`; `Patient.Identifiers[]` of `{ ID, IDType }`; `Patient.Demographics`). Field-level
 * mapping is UNVERIFIED against a Redox sandbox for any pilot EHR; see `REDOX_OPERATIONS` in
 * `connector.ts` for the status of each call. Parsers are defensive: they read `unknown` and return
 * `undefined` instead of throwing on unexpected shapes.
 */
import type { RedoxEnvironment } from '../ports.js';
import type { RedoxSourceBinding } from '../locations.js';
import type {
  AdministrativeSex,
  ChartDocumentWrite,
  CodedConcept,
  LocationId,
  OrderPriority,
  OrderStatus,
  Patient,
  PracticeId,
  ProviderRef,
  SurgicalOrder,
} from '../types.js';

export interface RedoxMeta {
  readonly DataModel: string;
  readonly EventType: string;
  readonly EventDateTime: string;
  readonly Test: boolean;
  readonly Destinations: readonly { readonly ID: string }[];
  readonly FacilityCode?: string;
}

export function buildMeta(
  dataModel: string,
  eventType: string,
  binding: RedoxSourceBinding,
  environment: RedoxEnvironment,
  now: Date,
): RedoxMeta {
  return {
    DataModel: dataModel,
    EventType: eventType,
    EventDateTime: now.toISOString(),
    Test: environment !== 'production',
    Destinations: [{ ID: binding.destinationId }],
    ...(binding.facilityCode !== undefined ? { FacilityCode: binding.facilityCode } : {}),
  };
}

const identifiers = (patientId: string, binding: RedoxSourceBinding) => [
  { ID: patientId, IDType: binding.patientIdType },
];

/** PatientSearch / Query by the location's patient identifier type. */
export function buildPatientSearchQuery(meta: RedoxMeta, patientId: string, binding: RedoxSourceBinding) {
  return { Meta: meta, Patient: { Identifiers: identifiers(patientId, binding) } };
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function patientIdFrom(patient: unknown, binding: RedoxSourceBinding): string | undefined {
  if (!isObj(patient)) return undefined;
  const ids = arr(patient.Identifiers).filter(isObj);
  const match = ids.find((i) => i.IDType === binding.patientIdType);
  return str(match?.ID);
}

function sexFrom(v: unknown): AdministrativeSex {
  const s = typeof v === 'string' ? v.toLowerCase() : '';
  if (s === 'female' || s === 'male' || s === 'other') return s;
  return 'unknown';
}

/** PatientSearch / Query response; `undefined` when no patient with our identifier came back. */
export function parsePatientSearchResponse(body: unknown, binding: RedoxSourceBinding): Patient | undefined {
  if (!isObj(body) || !isObj(body.Patient)) return undefined;
  const id = patientIdFrom(body.Patient, binding);
  const demo = body.Patient.Demographics;
  if (!id || !isObj(demo)) return undefined;
  const givenName = str(demo.FirstName);
  const familyName = str(demo.LastName);
  const birthDate = str(demo.DOB)?.slice(0, 10);
  if (!givenName || !familyName || !birthDate) return undefined;
  const phones = isObj(demo.PhoneNumber) ? demo.PhoneNumber : {};
  const phone = str(phones.Mobile) ?? str(phones.Home);
  return {
    id,
    givenName,
    familyName,
    birthDate,
    sex: sexFrom(demo.Sex),
    ...(phone !== undefined ? { phone } : {}),
  };
}

const ORDER_STATUS: Record<string, OrderStatus> = { New: 'new', Update: 'updated', Cancel: 'cancelled' };

function priorityFrom(v: unknown): OrderPriority {
  const s = typeof v === 'string' ? v.toLowerCase() : '';
  if (s === 'stat' || s === 'asap' || s === 'urgent') return 'urgent';
  if (s === 'routine') return 'routine';
  return 'unknown';
}

function conceptFrom(v: unknown, descriptionKey: 'Description' | 'Name'): CodedConcept | undefined {
  if (!isObj(v)) return undefined;
  const code = str(v.Code);
  const codeSystem = str(v.Codeset);
  if (!code || !codeSystem) return undefined;
  const description = str(v[descriptionKey]);
  return { code, codeSystem, ...(description !== undefined ? { description } : {}) };
}

function providerFrom(v: unknown): ProviderRef | undefined {
  if (!isObj(v)) return undefined;
  const npi = str(v.NPI);
  const id = str(v.ID) ?? npi;
  if (!id) return undefined;
  const name = [str(v.FirstName), str(v.LastName)].filter(Boolean).join(' ');
  return { id, ...(name ? { name } : {}), ...(npi !== undefined ? { npi } : {}) };
}

/** Inbound Order / New | Update | Cancel. `undefined` when required fields are missing. */
export function parseOrderMessage(
  body: unknown,
  binding: RedoxSourceBinding,
  scope: { practiceId: PracticeId; locationId: LocationId },
): SurgicalOrder | undefined {
  if (!isObj(body) || !isObj(body.Meta) || !isObj(body.Order)) return undefined;
  if (body.Meta.DataModel !== 'Order') return undefined;
  const status = ORDER_STATUS[String(body.Meta.EventType)];
  const patientId = patientIdFrom(body.Patient, binding);
  const externalId = str(body.Order.ID);
  const orderedAt = str(body.Order.TransactionDateTime) ?? str(body.Meta.EventDateTime);
  if (!status || !patientId || !externalId || !orderedAt) return undefined;
  const procedure = conceptFrom(body.Order.Procedure, 'Description');
  const orderingProvider = providerFrom(body.Order.Provider);
  return {
    externalId,
    practiceId: scope.practiceId,
    locationId: scope.locationId,
    patientId,
    status,
    priority: priorityFrom(body.Order.Priority),
    orderedAt,
    ...(orderingProvider ? { orderingProvider } : {}),
    procedures: procedure ? [procedure] : [],
    diagnoses: arr(body.Order.Diagnoses)
      .map((d) => conceptFrom(d, 'Name'))
      .filter((d): d is CodedConcept => d !== undefined),
  };
}

/** Notes / New: file a document in the chart. Our idempotency key becomes the document ID. */
export function buildNotesNew(meta: RedoxMeta, doc: ChartDocumentWrite, binding: RedoxSourceBinding) {
  return {
    Meta: meta,
    Patient: { Identifiers: identifiers(doc.patientId, binding) },
    Note: {
      ContentType: doc.contentType === 'text/plain' ? 'Plain Text' : 'Base64 Encoded',
      FileName: doc.title,
      FileContents: doc.content,
      DocumentType: doc.documentType,
      DocumentID: doc.idempotencyKey,
      ServiceDateTime: doc.authoredAt,
      DocumentationDateTime: doc.authoredAt,
      ...(doc.authorProviderId !== undefined ? { Provider: { ID: doc.authorProviderId } } : {}),
    },
  };
}
