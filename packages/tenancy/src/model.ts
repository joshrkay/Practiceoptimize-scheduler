/**
 * Practice data model (RAH-9). The practice is the customer and the isolation boundary: every
 * practice-owned record carries `practiceId`. Facilities are shared across practices; a practice's own
 * settings for a facility live in `PracticeFacilitySettings`.
 */

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type OrganizationId = Brand<string, 'OrganizationId'>;
export type PracticeId = Brand<string, 'PracticeId'>;
export type LocationId = Brand<string, 'LocationId'>;
export type FacilityId = Brand<string, 'FacilityId'>;
export type SurgeonId = Brand<string, 'SurgeonId'>;

/** Optional parent of one or more practices (for example a management group). */
export interface Organization {
  readonly id: OrganizationId;
  readonly name: string;
}

export const BAA_STATUSES = ['not_started', 'sent', 'signed', 'terminated'] as const;
export type BaaStatus = (typeof BAA_STATUSES)[number];

/** The customer: a HIPAA covered entity with its own BAA and Availity account. */
export interface Practice {
  readonly id: PracticeId;
  readonly organizationId: OrganizationId | null;
  readonly name: string;
  readonly isCoveredEntity: boolean;
  readonly baaStatus: BaaStatus;
  /** ISO date (YYYY-MM-DD); required when `baaStatus` is `signed`. */
  readonly baaSignedOn: string | null;
  readonly availityCustomerId: string | null;
}

export interface Address {
  readonly line1: string;
  readonly line2: string | null;
  readonly city: string;
  /** Two-letter USPS state code. */
  readonly state: string;
  readonly postalCode: string;
}

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** Local opening hours, `HH:MM` in the location's time zone. A missing day means closed. */
export type OpeningHours = Partial<Record<Weekday, { readonly open: string; readonly close: string }>>;

/** A practice office. Billing identity, phone numbers and time zone are per location, not per practice. */
export interface Location {
  readonly id: LocationId;
  readonly practiceId: PracticeId;
  readonly name: string;
  readonly address: Address;
  /** IANA time zone, for example `America/Denver`. */
  readonly timeZone: string;
  readonly billingNpi: string;
  readonly billingTin: string;
  readonly phoneNumber: string;
  readonly smsNumber: string | null;
  readonly hours: OpeningHours;
  /** Identifier of the EHR instance (through Redox) this location's orders come from. */
  readonly sourceEhrInstance: string | null;
}

export const FACILITY_TYPES = ['asc', 'office_procedure_room'] as const;
export type FacilityType = (typeof FACILITY_TYPES)[number];

/** A place surgery happens. Global: shared by every practice that operates there. */
export interface Facility {
  readonly id: FacilityId;
  readonly name: string;
  readonly facilityType: FacilityType;
  readonly npi: string | null;
  readonly address: Address;
  readonly timeZone: string;
  readonly phoneNumber: string | null;
}

export const POSTING_METHODS = ['portal', 'fax', 'email', 'phone'] as const;
export type PostingMethod = (typeof POSTING_METHODS)[number];

export interface OrDeskContact {
  readonly name: string;
  readonly role: string;
  readonly phone: string | null;
  readonly fax: string | null;
  readonly email: string | null;
}

export interface BlockSchedule {
  readonly surgeonId: SurgeonId | null;
  readonly weekday: Weekday;
  /** `HH:MM` in the facility's time zone. */
  readonly start: string;
  readonly end: string;
}

/** One practice's settings at one shared facility. Other practices never see these. */
export interface PracticeFacilitySettings {
  readonly practiceId: PracticeId;
  readonly facilityId: FacilityId;
  readonly orDeskContacts: readonly OrDeskContact[];
  readonly postingMethod: PostingMethod;
  readonly blockSchedules: readonly BlockSchedule[];
  readonly rules: Readonly<Record<string, unknown>>;
}

export const PRIVILEGE_STATUSES = ['pending', 'active', 'expired'] as const;
export type PrivilegeStatus = (typeof PRIVILEGE_STATUSES)[number];

export interface FacilityPrivilege {
  readonly facilityId: FacilityId;
  readonly status: PrivilegeStatus;
  readonly expiresOn: string | null;
}

/** A surgeon belongs to one practice, works at many of its locations, and holds facility privileges. */
export interface Surgeon {
  readonly id: SurgeonId;
  readonly practiceId: PracticeId;
  readonly npi: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly specialty: string;
  readonly locationIds: readonly LocationId[];
  readonly facilityPrivileges: readonly FacilityPrivilege[];
}

/** A facility as one practice sees it: the shared record plus that practice's own settings. */
export interface PracticeFacility {
  readonly facility: Facility;
  readonly settings: PracticeFacilitySettings;
}
