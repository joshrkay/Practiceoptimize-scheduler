/**
 * Ports for the pre-admission testing (PAT) packet. Each is implemented elsewhere (readiness items,
 * coordination requests, directory and send tool, inbound matching, resolved facility rules, Today view,
 * clock) and wired at integration. In-memory fakes live in `fakes.ts`.
 */

export type IsoDate = string; // YYYY-MM-DD

export type DocumentType = string; // e.g. 'h_and_p', 'clearance', 'labs', 'consent'

export type SiteOfService = 'asc' | 'office_procedure_room';
export type AnesthesiaType = 'general' | 'mac' | 'regional' | 'local' | 'none';

export interface CaseInfo {
  caseId: string;
  practiceId: string;
  facilityId: string;
  surgeryDate: IsoDate;
  siteOfService: SiteOfService;
  anesthesia: AnesthesiaType;
  /** Synthetic display label for the cover sheet. */
  patientLabel: string;
  procedureLabel: string;
}

export interface CaseDocument {
  id: string;
  caseId: string;
  type: DocumentType;
  title: string;
  /** Restricted documents are never packeted. */
  restricted: boolean;
  /** True when the readiness item for this document is satisfied. */
  ready: boolean;
  receivedAt: string; // ISO timestamp
}

export interface CaseDataPort {
  getCase(practiceId: string, caseId: string): Promise<CaseInfo | undefined>;
  listDocuments(practiceId: string, caseId: string): Promise<CaseDocument[]>;
}

export interface PatChannel {
  kind: 'fax' | 'portal' | 'email';
  destinationId: string;
}

export interface FacilityPatRules {
  facilityId: string;
  /** Required document types, in the order the facility wants them. */
  requiredDocumentTypes: DocumentType[];
  /** Business days before surgery. Defaults to 5 when absent. */
  cutoffBusinessDays?: number;
  channel: PatChannel;
}

export interface FacilityRulesPort {
  resolvePatRules(practiceId: string, facilityId: string): Promise<FacilityPatRules | undefined>;
}

export interface ClockPort {
  today(): IsoDate;
}

export interface HolidayPort {
  holidays(): ReadonlySet<IsoDate>;
}

export interface OutboundPacket {
  practiceId: string;
  caseId: string;
  facilityId: string;
  channel: PatChannel;
  idempotencyKey: string;
  kind: 'original' | 'addendum';
  coverSheet: string;
  documentIds: string[];
  referencesPacketId?: string;
}

export interface PatSendPort {
  /** Must be idempotent on `idempotencyKey`. */
  send(packet: OutboundPacket): Promise<{ transmissionId: string }>;
}

export interface SchedulerAlert {
  practiceId: string;
  caseId: string;
  reason: 'pat_cutoff_missing_items';
  pendingTypes: DocumentType[];
}

export interface SchedulerAlertPort {
  alertScheduler(alert: SchedulerAlert): Promise<void>;
}

export interface OpenItemRequest {
  practiceId: string;
  caseId: string;
  /** Id of the inbound request from the facility (from inbound matching); dedupe key. */
  sourceRequestId: string;
  documentType: DocumentType;
  note: string;
  /** True when the requested type is not on the facility's required list. */
  outsideRequiredList: boolean;
}

export interface OpenItemPort {
  /** Must be idempotent on `sourceRequestId`. */
  createOpenItem(item: OpenItemRequest): Promise<{ itemId: string }>;
}

export type SendMode = 'autonomous' | 'approve_first';

export interface SendPolicyPort {
  sendMode(practiceId: string, caseId: string): Promise<SendMode>;
  requestApproval(practiceId: string, caseId: string, packetKey: string): Promise<void>;
}

export interface PacketRecord {
  packetId: string;
  practiceId: string;
  caseId: string;
  kind: 'original' | 'addendum';
  idempotencyKey: string;
  sentDocumentIds: string[];
  pendingTypes: DocumentType[];
  referencesPacketId?: string;
  transmissionId: string;
  sentOn: IsoDate;
}

export interface PacketStorePort {
  findByKey(practiceId: string, key: string): Promise<PacketRecord | undefined>;
  listForCase(practiceId: string, caseId: string): Promise<PacketRecord[]>;
  save(record: PacketRecord): Promise<void>;
}
