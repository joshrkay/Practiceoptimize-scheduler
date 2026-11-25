export { VendorService, VENDOR_RECONFIRM_HOURS } from './service.js';
export type { VendorServiceDeps } from './service.js';
export { toVendorRequestFields, needsVendor, initialsOf } from './phi.js';
export { renderVendorMessage } from './templates.js';
export { defaultVendorPolicy } from './ports.js';
export type {
  ApprovalMode,
  ApprovalQueuePort,
  ClockPort,
  CoordinationPort,
  FacilityInfo,
  FacilityRulesPort,
  SchedulerAlertPort,
  SurgeonPreferencesPort,
  VendorDirectoryPort,
  VendorPolicyPort,
  VendorRequestStore,
} from './ports.js';
export type {
  ConfirmationStatus,
  LeadTimeRisk,
  OutboundKind,
  PendingOutbound,
  SlotApprovedResult,
  VendorCaseInput,
  VendorMessage,
  VendorRep,
  VendorReply,
  VendorRequestFields,
  VendorRequestRecord,
} from './types.js';
