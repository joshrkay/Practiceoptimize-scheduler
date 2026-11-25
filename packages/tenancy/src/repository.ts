import type { Queryable } from '@scheduler/db';
import {
  BAA_STATUSES,
  FACILITY_TYPES,
  POSTING_METHODS,
  PRIVILEGE_STATUSES,
  WEEKDAYS,
  type Address,
  type BaaStatus,
  type BlockSchedule,
  type Facility,
  type FacilityId,
  type FacilityPrivilege,
  type FacilityType,
  type Location,
  type LocationId,
  type OpeningHours,
  type OrDeskContact,
  type Organization,
  type OrganizationId,
  type PostingMethod,
  type Practice,
  type PracticeFacility,
  type PracticeFacilitySettings,
  type PracticeId,
  type Surgeon,
  type SurgeonId,
} from './model.js';
import {
  Checker,
  isIsoDate,
  isLocalTime,
  isUsStateCode,
  isValidNpi,
  isValidTimeZone,
  isValidTin,
} from './validation.js';

type WithOptionalId<T extends { id: unknown }> = Omit<T, 'id'> & { readonly id?: T['id'] };

export type NewOrganization = WithOptionalId<Organization>;
export type NewPractice = WithOptionalId<Practice>;
export type NewLocation = WithOptionalId<Location>;
export type NewFacility = WithOptionalId<Facility>;
export type NewSurgeon = WithOptionalId<Surgeon>;

/**
 * Reads and writes the practice model. Every practice-owned read takes the `practiceId` explicitly and
 * filters on it; row-level security (RAH-10) enforces the same boundary again in the database.
 */
export interface PracticeRepository {
  createOrganization(input: NewOrganization): Promise<Organization>;
  createPractice(input: NewPractice): Promise<Practice>;
  createLocation(input: NewLocation): Promise<Location>;
  createFacility(input: NewFacility): Promise<Facility>;
  /** Creates or replaces one practice's settings at a shared facility. */
  savePracticeFacilitySettings(input: PracticeFacilitySettings): Promise<PracticeFacilitySettings>;
  /** Creates the surgeon with their locations and facility privileges in one statement. */
  createSurgeon(input: NewSurgeon): Promise<Surgeon>;

  getOrganization(id: OrganizationId): Promise<Organization | null>;
  getPractice(id: PracticeId): Promise<Practice | null>;
  getLocation(practiceId: PracticeId, id: LocationId): Promise<Location | null>;
  listLocations(practiceId: PracticeId): Promise<Location[]>;
  getFacility(id: FacilityId): Promise<Facility | null>;
  getPracticeFacility(practiceId: PracticeId, facilityId: FacilityId): Promise<PracticeFacility | null>;
  listPracticeFacilities(practiceId: PracticeId): Promise<PracticeFacility[]>;
  getSurgeon(practiceId: PracticeId, id: SurgeonId): Promise<Surgeon | null>;
  listSurgeons(practiceId: PracticeId): Promise<Surgeon[]>;
}

// ---------------------------------------------------------------------------------------------------------
// Validation

function checkAddress(c: Checker, label: string, address: Address): void {
  c.check(address.line1.trim().length > 0, `${label}: address line 1 is required`)
    .check(address.city.trim().length > 0, `${label}: city is required`)
    .check(isUsStateCode(address.state), `${label}: "${address.state}" is not a US state code`)
    .check(/^\d{5}(-\d{4})?$/.test(address.postalCode), `${label}: postal code must be a ZIP or ZIP+4`);
}

function checkHours(c: Checker, label: string, hours: OpeningHours): void {
  for (const [day, span] of Object.entries(hours)) {
    c.check((WEEKDAYS as readonly string[]).includes(day), `${label}: "${day}" is not a weekday`);
    if (!span) continue;
    c.check(
      isLocalTime(span.open) && isLocalTime(span.close) && span.open < span.close,
      `${label}: hours for ${day} must be HH:MM with open before close`,
    );
  }
}

export function validatePractice(input: NewPractice): void {
  const c = new Checker();
  c.check(input.name.trim().length > 0, 'practice name is required')
    .check(BAA_STATUSES.includes(input.baaStatus), `unknown BAA status "${input.baaStatus}"`)
    .check(
      input.baaStatus !== 'signed' || (input.baaSignedOn !== null && isIsoDate(input.baaSignedOn)),
      'a signed BAA needs its signed date (YYYY-MM-DD)',
    );
  c.throwIfInvalid();
}

export function validateLocation(input: NewLocation): void {
  const c = new Checker();
  const label = `location "${input.name}"`;
  c.check(input.name.trim().length > 0, 'location name is required')
    .check(isValidNpi(input.billingNpi), `${label}: billing NPI ${input.billingNpi} fails the NPI check digit`)
    .check(isValidTin(input.billingTin), `${label}: billing TIN must be nine digits`)
    .check(isValidTimeZone(input.timeZone), `${label}: "${input.timeZone}" is not an IANA time zone`)
    .check(input.phoneNumber.trim().length > 0, `${label}: phone number is required`);
  checkAddress(c, label, input.address);
  checkHours(c, label, input.hours);
  c.throwIfInvalid();
}

export function validateFacility(input: NewFacility): void {
  const c = new Checker();
  const label = `facility "${input.name}"`;
  c.check(input.name.trim().length > 0, 'facility name is required')
    .check(FACILITY_TYPES.includes(input.facilityType), `${label}: unsupported facility type "${input.facilityType}"`)
    .check(input.npi === null || isValidNpi(input.npi), `${label}: NPI ${input.npi} fails the NPI check digit`)
    .check(isValidTimeZone(input.timeZone), `${label}: "${input.timeZone}" is not an IANA time zone`);
  checkAddress(c, label, input.address);
  c.throwIfInvalid();
}

export function validatePracticeFacilitySettings(input: PracticeFacilitySettings): void {
  const c = new Checker();
  c.check(POSTING_METHODS.includes(input.postingMethod), `unknown posting method "${input.postingMethod}"`);
  for (const block of input.blockSchedules) {
    c.check(WEEKDAYS.includes(block.weekday), `block schedule: "${block.weekday}" is not a weekday`).check(
      isLocalTime(block.start) && isLocalTime(block.end) && block.start < block.end,
      'block schedule: start and end must be HH:MM with start before end',
    );
  }
  for (const contact of input.orDeskContacts) {
    c.check(contact.name.trim().length > 0, 'OR desk contact needs a name');
  }
  c.throwIfInvalid();
}

export function validateSurgeon(input: NewSurgeon): void {
  const c = new Checker();
  c.check(isValidNpi(input.npi), `surgeon ${input.lastName}: NPI ${input.npi} fails the NPI check digit`)
    .check(input.firstName.trim().length > 0 && input.lastName.trim().length > 0, 'surgeon name is required')
    .check(input.locationIds.length > 0, `surgeon ${input.lastName}: needs at least one location`);
  for (const privilege of input.facilityPrivileges) {
    c.check(PRIVILEGE_STATUSES.includes(privilege.status), `unknown privilege status "${privilege.status}"`).check(
      privilege.expiresOn === null || isIsoDate(privilege.expiresOn),
      'privilege expiry must be YYYY-MM-DD',
    );
  }
  c.throwIfInvalid();
}

// ---------------------------------------------------------------------------------------------------------
// Row mapping

interface OrganizationRow {
  id: string;
  name: string;
}

interface PracticeRow {
  id: string;
  organization_id: string | null;
  name: string;
  is_covered_entity: boolean;
  baa_status: BaaStatus;
  baa_signed_on: string | null;
  availity_customer_id: string | null;
}

interface AddressColumns {
  address_line1: string;
  address_line2: string | null;
  city: string;
  state: string;
  postal_code: string;
}

interface LocationRow extends AddressColumns {
  id: string;
  practice_id: string;
  name: string;
  time_zone: string;
  billing_npi: string;
  billing_tin: string;
  phone_number: string;
  sms_number: string | null;
  hours: OpeningHours;
  source_ehr_instance: string | null;
}

interface FacilityRow extends AddressColumns {
  id: string;
  name: string;
  facility_type: FacilityType;
  npi: string | null;
  time_zone: string;
  phone_number: string | null;
}

interface SettingsRow {
  practice_id: string;
  facility_id: string;
  or_desk_contacts: OrDeskContact[];
  posting_method: PostingMethod;
  block_schedules: BlockSchedule[];
  rules: Record<string, unknown>;
}

interface SurgeonRow {
  id: string;
  practice_id: string;
  npi: string;
  first_name: string;
  last_name: string;
  specialty: string;
  location_ids: string[];
  facility_privileges: { facilityId: string; status: FacilityPrivilege['status']; expiresOn: string | null }[];
}

const toOrganization = (row: OrganizationRow): Organization => ({ id: row.id as OrganizationId, name: row.name });

const toPractice = (row: PracticeRow): Practice => ({
  id: row.id as PracticeId,
  organizationId: row.organization_id as OrganizationId | null,
  name: row.name,
  isCoveredEntity: row.is_covered_entity,
  baaStatus: row.baa_status,
  baaSignedOn: row.baa_signed_on,
  availityCustomerId: row.availity_customer_id,
});

const toAddress = (row: AddressColumns): Address => ({
  line1: row.address_line1,
  line2: row.address_line2,
  city: row.city,
  state: row.state,
  postalCode: row.postal_code,
});

const toLocation = (row: LocationRow): Location => ({
  id: row.id as LocationId,
  practiceId: row.practice_id as PracticeId,
  name: row.name,
  address: toAddress(row),
  timeZone: row.time_zone,
  billingNpi: row.billing_npi,
  billingTin: row.billing_tin,
  phoneNumber: row.phone_number,
  smsNumber: row.sms_number,
  hours: row.hours,
  sourceEhrInstance: row.source_ehr_instance,
});

const toFacility = (row: FacilityRow): Facility => ({
  id: row.id as FacilityId,
  name: row.name,
  facilityType: row.facility_type,
  npi: row.npi,
  address: toAddress(row),
  timeZone: row.time_zone,
  phoneNumber: row.phone_number,
});

const toSettings = (row: SettingsRow): PracticeFacilitySettings => ({
  practiceId: row.practice_id as PracticeId,
  facilityId: row.facility_id as FacilityId,
  orDeskContacts: row.or_desk_contacts,
  postingMethod: row.posting_method,
  blockSchedules: row.block_schedules,
  rules: row.rules,
});

const toSurgeon = (row: SurgeonRow): Surgeon => ({
  id: row.id as SurgeonId,
  practiceId: row.practice_id as PracticeId,
  npi: row.npi,
  firstName: row.first_name,
  lastName: row.last_name,
  specialty: row.specialty,
  locationIds: row.location_ids as LocationId[],
  facilityPrivileges: row.facility_privileges.map((p) => ({
    facilityId: p.facilityId as FacilityId,
    status: p.status,
    expiresOn: p.expiresOn,
  })),
});

// Dates come back as ISO strings rather than JS Dates, so the model stays plain data.
const PRACTICE_COLUMNS = `id, organization_id, name, is_covered_entity, baa_status,
  to_char(baa_signed_on, 'YYYY-MM-DD') AS baa_signed_on, availity_customer_id`;

const LOCATION_COLUMNS = `id, practice_id, name, address_line1, address_line2, city, state, postal_code,
  time_zone, billing_npi, billing_tin, phone_number, sms_number, hours, source_ehr_instance`;

const FACILITY_COLUMNS = `id, name, facility_type, npi, address_line1, address_line2, city, state, postal_code,
  time_zone, phone_number`;

const SETTINGS_COLUMNS = 'practice_id, facility_id, or_desk_contacts, posting_method, block_schedules, rules';

const SURGEON_SELECT = `
  SELECT s.id, s.practice_id, s.npi, s.first_name, s.last_name, s.specialty,
    COALESCE((SELECT array_agg(sl.location_id::text ORDER BY sl.location_id)
              FROM surgeon_locations sl WHERE sl.surgeon_id = s.id AND sl.practice_id = s.practice_id),
             '{}') AS location_ids,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('facilityId', p.facility_id, 'status', p.status,
                                                  'expiresOn', to_char(p.expires_on, 'YYYY-MM-DD'))
                               ORDER BY p.facility_id)
              FROM surgeon_facility_privileges p WHERE p.surgeon_id = s.id AND p.practice_id = s.practice_id),
             '[]'::jsonb) AS facility_privileges
  FROM surgeons s`;

function first<T>(rows: T[]): T | null {
  return rows[0] ?? null;
}

function one<T>(rows: T[], what: string): T {
  const row = rows[0];
  if (!row) throw new Error(`Expected ${what} to be returned`);
  return row;
}

/** Builds a repository over any pg-style connection: a pool, a client, or a practice-scoped transaction. */
export function createPracticeRepository(db: Queryable): PracticeRepository {
  const repository: PracticeRepository = {
    async createOrganization(input) {
      const { rows } = await db.query<OrganizationRow>(
        'INSERT INTO organizations (id, name) VALUES (COALESCE($1::uuid, gen_random_uuid()), $2) RETURNING id, name',
        [input.id ?? null, input.name],
      );
      return toOrganization(one(rows, 'organization'));
    },

    async createPractice(input) {
      validatePractice(input);
      const { rows } = await db.query<PracticeRow>(
        `INSERT INTO practices (id, organization_id, name, is_covered_entity, baa_status, baa_signed_on,
                                availity_customer_id)
         VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7)
         RETURNING ${PRACTICE_COLUMNS}`,
        [
          input.id ?? null,
          input.organizationId,
          input.name,
          input.isCoveredEntity,
          input.baaStatus,
          input.baaSignedOn,
          input.availityCustomerId,
        ],
      );
      return toPractice(one(rows, 'practice'));
    },

    async createLocation(input) {
      validateLocation(input);
      const { rows } = await db.query<LocationRow>(
        `INSERT INTO locations (id, practice_id, name, address_line1, address_line2, city, state, postal_code,
                                time_zone, billing_npi, billing_tin, phone_number, sms_number, hours,
                                source_ehr_instance)
         VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                 $14, $15)
         RETURNING ${LOCATION_COLUMNS}`,
        [
          input.id ?? null,
          input.practiceId,
          input.name,
          input.address.line1,
          input.address.line2,
          input.address.city,
          input.address.state,
          input.address.postalCode,
          input.timeZone,
          input.billingNpi,
          input.billingTin,
          input.phoneNumber,
          input.smsNumber,
          JSON.stringify(input.hours),
          input.sourceEhrInstance,
        ],
      );
      return toLocation(one(rows, 'location'));
    },

    async createFacility(input) {
      validateFacility(input);
      const { rows } = await db.query<FacilityRow>(
        `INSERT INTO facilities (id, name, facility_type, npi, address_line1, address_line2, city, state,
                                 postal_code, time_zone, phone_number)
         VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING ${FACILITY_COLUMNS}`,
        [
          input.id ?? null,
          input.name,
          input.facilityType,
          input.npi,
          input.address.line1,
          input.address.line2,
          input.address.city,
          input.address.state,
          input.address.postalCode,
          input.timeZone,
          input.phoneNumber,
        ],
      );
      return toFacility(one(rows, 'facility'));
    },

    async savePracticeFacilitySettings(input) {
      validatePracticeFacilitySettings(input);
      const { rows } = await db.query<SettingsRow>(
        `INSERT INTO practice_facility_settings (practice_id, facility_id, or_desk_contacts, posting_method,
                                                 block_schedules, rules)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (practice_id, facility_id) DO UPDATE
           SET or_desk_contacts = EXCLUDED.or_desk_contacts,
               posting_method = EXCLUDED.posting_method,
               block_schedules = EXCLUDED.block_schedules,
               rules = EXCLUDED.rules,
               updated_at = now()
         RETURNING ${SETTINGS_COLUMNS}`,
        [
          input.practiceId,
          input.facilityId,
          JSON.stringify(input.orDeskContacts),
          input.postingMethod,
          JSON.stringify(input.blockSchedules),
          JSON.stringify(input.rules),
        ],
      );
      return toSettings(one(rows, 'facility settings'));
    },

    async createSurgeon(input) {
      validateSurgeon(input);
      const { rows } = await db.query<{ id: string }>(
        `WITH surgeon AS (
           INSERT INTO surgeons (id, practice_id, npi, first_name, last_name, specialty)
           VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6)
           RETURNING id, practice_id
         ), locs AS (
           INSERT INTO surgeon_locations (practice_id, surgeon_id, location_id)
           SELECT surgeon.practice_id, surgeon.id, location_id
           FROM surgeon, unnest($7::uuid[]) AS location_id
         ), privs AS (
           INSERT INTO surgeon_facility_privileges (practice_id, surgeon_id, facility_id, status, expires_on)
           SELECT surgeon.practice_id, surgeon.id, p.facility_id, p.status, p.expires_on
           FROM surgeon,
                jsonb_to_recordset($8::jsonb) AS p(facility_id uuid, status text, expires_on date)
         )
         SELECT id FROM surgeon`,
        [
          input.id ?? null,
          input.practiceId,
          input.npi,
          input.firstName,
          input.lastName,
          input.specialty,
          input.locationIds,
          JSON.stringify(
            input.facilityPrivileges.map((p) => ({
              facility_id: p.facilityId,
              status: p.status,
              expires_on: p.expiresOn,
            })),
          ),
        ],
      );
      const created = await repository.getSurgeon(input.practiceId, one(rows, 'surgeon').id as SurgeonId);
      if (!created) throw new Error('Expected surgeon to be returned');
      return created;
    },

    async getOrganization(id) {
      const { rows } = await db.query<OrganizationRow>('SELECT id, name FROM organizations WHERE id = $1', [id]);
      const row = first(rows);
      return row && toOrganization(row);
    },

    async getPractice(id) {
      const { rows } = await db.query<PracticeRow>(`SELECT ${PRACTICE_COLUMNS} FROM practices WHERE id = $1`, [id]);
      const row = first(rows);
      return row && toPractice(row);
    },

    async getLocation(practiceId, id) {
      const { rows } = await db.query<LocationRow>(
        `SELECT ${LOCATION_COLUMNS} FROM locations WHERE practice_id = $1 AND id = $2`,
        [practiceId, id],
      );
      const row = first(rows);
      return row && toLocation(row);
    },

    async listLocations(practiceId) {
      const { rows } = await db.query<LocationRow>(
        `SELECT ${LOCATION_COLUMNS} FROM locations WHERE practice_id = $1 ORDER BY name`,
        [practiceId],
      );
      return rows.map(toLocation);
    },

    async getFacility(id) {
      const { rows } = await db.query<FacilityRow>(`SELECT ${FACILITY_COLUMNS} FROM facilities WHERE id = $1`, [id]);
      const row = first(rows);
      return row && toFacility(row);
    },

    async getPracticeFacility(practiceId, facilityId) {
      const all = await listPracticeFacilities(practiceId, facilityId);
      return first(all);
    },

    listPracticeFacilities: (practiceId) => listPracticeFacilities(practiceId, null),

    async getSurgeon(practiceId, id) {
      const { rows } = await db.query<SurgeonRow>(`${SURGEON_SELECT} WHERE s.practice_id = $1 AND s.id = $2`, [
        practiceId,
        id,
      ]);
      const row = first(rows);
      return row && toSurgeon(row);
    },

    async listSurgeons(practiceId) {
      const { rows } = await db.query<SurgeonRow>(
        `${SURGEON_SELECT} WHERE s.practice_id = $1 ORDER BY s.last_name, s.first_name`,
        [practiceId],
      );
      return rows.map(toSurgeon);
    },
  };

  async function listPracticeFacilities(
    practiceId: PracticeId,
    facilityId: FacilityId | null,
  ): Promise<PracticeFacility[]> {
    const { rows } = await db.query<FacilityRow & { settings: SettingsRow }>(
      `SELECT f.id, f.name, f.facility_type, f.npi, f.address_line1, f.address_line2, f.city, f.state,
              f.postal_code, f.time_zone, f.phone_number, to_jsonb(pfs) AS settings
       FROM practice_facility_settings pfs
       JOIN facilities f ON f.id = pfs.facility_id
       WHERE pfs.practice_id = $1 AND ($2::uuid IS NULL OR pfs.facility_id = $2)
       ORDER BY f.name`,
      [practiceId, facilityId],
    );
    return rows.map((row) => ({ facility: toFacility(row), settings: toSettings(row.settings) }));
  }

  return repository;
}
