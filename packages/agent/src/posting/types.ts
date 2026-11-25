export type PracticeId = string;
export type Laterality = 'left' | 'right' | 'bilateral' | 'not_applicable';
export type PostingFormat = 'sheet' | 'compact' | 'portal_form';
export type SiteType = 'asc' | 'office_procedure_room';

export type DeliveryChannel =
  | { kind: 'email'; address: string }
  | { kind: 'fax'; number: string }
  | { kind: 'portal_task'; portalName: string; assigneeRole: string };

export interface FacilityDirectoryEntry {
  facilityId: string;
  name: string;
  siteType: SiteType;
  channel: DeliveryChannel;
  postingFormat: PostingFormat;
  /** Set when a direct scheduling-system route (RAH-77) is available for this facility. */
  directScheduling?: { available: boolean; systemId: string };
}

export interface PostingCase {
  caseId: string;
  practiceId: PracticeId;
  facilityId: string;
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  /** Local start time, HH:MM (24h). */
  startTime: string;
  /** Facility UTC offset, for example -05:00. */
  utcOffset: string;
  procedure: string;
  cpt: string[];
  laterality: Laterality;
  durationMinutes: number;
  surgeon: string;
  assistant?: string;
  anesthesiaType: string;
  positioning: string;
  equipment: string[];
  implants: string[];
  rep?: string;
  /** True for an urgent add-on case. */
  urgentAddOn: boolean;
}

export interface SignedOrder {
  orderId: string;
  caseId: string;
  signed: boolean;
  date: string;
  laterality: Laterality;
  procedure: string;
  urgent: boolean;
}

export type CrossCheckField = 'date' | 'side' | 'procedure';
export interface Mismatch {
  field: CrossCheckField;
  posting: string;
  order: string;
}

export interface PostingDocument {
  format: PostingFormat;
  subject: string;
  body: string;
}

export type SubmissionKind = 'initial' | 'update' | 'cancellation' | 'reconfirmation';
export type SubmissionStatus =
  | 'pending_approval'
  | 'sent'
  | 'confirmed'
  | 'blocked'
  | 'rejected'
  | 'superseded';
export type ApprovalBasis = 'scheduler' | 'urgent_signed_order';
export type RouteUsed = 'directory_channel' | 'direct_scheduling';
export type BlockReason = 'mismatch' | 'incomplete' | 'order_not_signed';

export interface Submission {
  id: string;
  practiceId: PracticeId;
  caseId: string;
  facilityId: string;
  kind: SubmissionKind;
  /** For a reconfirmation: the posting it asks the facility to reconfirm. */
  parentId?: string;
  version: number;
  status: SubmissionStatus;
  document: PostingDocument;
  caseSnapshot: PostingCase;
  surgeryStartsAt: string;
  createdAt: string;
  approvedBy?: string;
  approvalBasis?: ApprovalBasis;
  sentAt?: string;
  route?: RouteUsed;
  messageId?: string;
  confirmationNumber?: string;
  confirmedAt?: string;
  reconfirmRequestedAt?: string;
  reconfirmedAt?: string;
  reconfirmationNumber?: string;
  blockReason?: BlockReason;
  mismatches?: Mismatch[];
}
