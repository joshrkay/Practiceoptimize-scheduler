import type { OutboundKind, VendorMessage, VendorRep, VendorRequestRecord } from './types.js';

/** Coordination requests, reminder ladder and send tool (owned by another branch). */
export interface CoordinationPort {
  send(message: VendorMessage): Promise<{ coordinationRequestId: string }>;
}

/** Surgeon preferences, resolved (owned by another branch). */
export interface SurgeonPreferencesPort {
  preferredRep(
    practiceId: string,
    surgeonId: string,
    implantSystem: string,
  ): Promise<VendorRep | null>;
}

/** Vendor directory (owned by another branch). */
export interface VendorDirectoryPort {
  findRep(practiceId: string, implantSystem: string): Promise<VendorRep | null>;
}

export interface FacilityInfo {
  name: string;
  /** IANA time zone used to render the date and start time. */
  timezone: string;
  /** Days before surgery the facility needs trays delivered. */
  trayLeadTimeDays: number;
}

/** Facility rules (owned by another branch). */
export interface FacilityRulesPort {
  get(practiceId: string, facilityId: string): Promise<FacilityInfo>;
}

export type ApprovalMode = 'autonomous' | 'approve_first';

/** Autonomy policy. Vendor bookings are approve-first per the PRD; the default says so. */
export interface VendorPolicyPort {
  modeFor(practiceId: string, kind: OutboundKind): Promise<ApprovalMode>;
}

/** Review queue for approve-first items. */
export interface ApprovalQueuePort {
  enqueue(item: {
    practiceId: string;
    caseId: string;
    requestId: string;
    pendingId: string;
    kind: OutboundKind;
    summary: string;
  }): Promise<void>;
}

/** Surfaces a risk to the scheduler (Today view). */
export interface SchedulerAlertPort {
  flag(alert: {
    practiceId: string;
    caseId: string;
    code: 'vendor_lead_time_risk';
    message: string;
  }): Promise<void>;
}

export interface ClockPort {
  now(): Date;
}

export interface VendorRequestStore {
  save(record: VendorRequestRecord): Promise<void>;
  get(id: string): Promise<VendorRequestRecord | null>;
  findLiveByCase(practiceId: string, caseId: string): Promise<VendorRequestRecord | null>;
  listLive(practiceId: string): Promise<VendorRequestRecord[]>;
}

export const defaultVendorPolicy: VendorPolicyPort = {
  modeFor: () => Promise.resolve('approve_first'),
};
