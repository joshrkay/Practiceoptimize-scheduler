/** Full case input as the scheduler holds it. Contains PHI; never sent to vendors as-is. */
export interface VendorCaseInput {
  practiceId: string;
  caseId: string;
  /** Short case reference safe to share with vendors. */
  caseRef: string;
  surgeonId: string;
  facilityId: string;
  /** ISO 8601 instant of the scheduled start. */
  surgeryStart: string;
  procedure: string;
  patient: {
    firstName: string;
    lastName: string;
    dateOfBirth: string;
  };
  /** PHI: must never reach a vendor. */
  diagnosis: string;
  implantSystem: string | null;
  trayNeeds: string[];
  specialEquipment: string[];
}

export type ConfirmationStatus = 'pending' | 'confirmed' | 'declined';

export type OutboundKind = 'request' | 'update' | 'reconfirm' | 'cancel';

/** The only fields that may leave the practice toward a vendor rep (explicit allowlist). */
export interface VendorRequestFields {
  caseRef: string;
  patientInitials: string;
  date: string;
  startTime: string;
  facilityName: string;
  procedure: string;
  /** Implant system, or "None (equipment only)". */
  implantSystem: string;
  trayNeeds: string[];
  specialEquipment: string[];
}

export interface VendorRep {
  vendorId: string;
  repName: string;
  contact: string;
}

export interface VendorMessage {
  practiceId: string;
  caseId: string;
  kind: OutboundKind;
  to: VendorRep;
  subject: string;
  body: string;
  /** Stable key so the coordination layer can de-duplicate retries. */
  dedupeKey: string;
}

export interface PendingOutbound {
  id: string;
  kind: OutboundKind;
  message: VendorMessage;
  /** Fields to adopt as "last sent" once this message goes out; null for cancel/reconfirm. */
  fields: VendorRequestFields | null;
  surgeryStart: string | null;
}

export interface LeadTimeRisk {
  requiredDays: number;
  actualDays: number;
  message: string;
}

export interface VendorRequestRecord {
  id: string;
  practiceId: string;
  caseId: string;
  rep: VendorRep;
  surgeryStart: string;
  /** Fields as last sent (or queued for first send). */
  fields: VendorRequestFields;
  status: 'awaiting_approval' | 'active' | 'cancelled';
  attendance: ConfirmationStatus;
  trayDelivery: ConfirmationStatus;
  leadTimeRisk: LeadTimeRisk | null;
  reconfirmSentAt: string | null;
  sentAt: string | null;
  coordinationRequestIds: string[];
  pending: PendingOutbound[];
}

export type SlotApprovedResult =
  | { status: 'no_request' }
  | { status: 'no_rep' }
  | { status: 'duplicate'; requestId: string }
  | { status: 'sent' | 'awaiting_approval'; requestId: string; leadTimeRisk: LeadTimeRisk | null };

export interface VendorReply {
  attendance?: ConfirmationStatus;
  trayDelivery?: ConfirmationStatus;
}
