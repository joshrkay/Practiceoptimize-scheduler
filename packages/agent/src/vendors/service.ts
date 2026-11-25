import { needsVendor, toVendorRequestFields } from './phi.js';
import type {
  ApprovalQueuePort,
  ClockPort,
  CoordinationPort,
  FacilityRulesPort,
  SchedulerAlertPort,
  SurgeonPreferencesPort,
  VendorDirectoryPort,
  VendorPolicyPort,
  VendorRequestStore,
} from './ports.js';
import { defaultVendorPolicy } from './ports.js';
import { renderVendorMessage } from './templates.js';
import type {
  LeadTimeRisk,
  OutboundKind,
  PendingOutbound,
  SlotApprovedResult,
  VendorCaseInput,
  VendorReply,
  VendorRequestFields,
  VendorRequestRecord,
} from './types.js';

export const VENDOR_RECONFIRM_HOURS = 48;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export interface VendorServiceDeps {
  coordination: CoordinationPort;
  preferences: SurgeonPreferencesPort;
  directory: VendorDirectoryPort;
  facilities: FacilityRulesPort;
  approvals: ApprovalQueuePort;
  alerts: SchedulerAlertPort;
  clock: ClockPort;
  store: VendorRequestStore;
  /** Defaults to approve-first. */
  policy?: VendorPolicyPort;
  /** FEATURE_COORD_VENDOR. When false nothing is created or sent. */
  enabled?: boolean;
  /** VENDOR_RECONFIRM_HOURS, default 48. */
  reconfirmHours?: number;
  newId?: () => string;
}

const FIELD_LABELS: [keyof VendorRequestFields, string][] = [
  ['date', 'date'],
  ['startTime', 'start time'],
  ['facilityName', 'facility'],
  ['procedure', 'procedure'],
  ['implantSystem', 'implant system'],
  ['trayNeeds', 'tray needs'],
  ['specialEquipment', 'special equipment'],
];

function changedLabels(a: VendorRequestFields, b: VendorRequestFields): string[] {
  return FIELD_LABELS.filter(([k]) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).map(
    ([, label]) => label,
  );
}

export class VendorService {
  private readonly policy: VendorPolicyPort;
  private readonly reconfirmHours: number;
  private readonly newId: () => string;
  private seq = 0;

  constructor(private readonly deps: VendorServiceDeps) {
    this.policy = deps.policy ?? defaultVendorPolicy;
    this.reconfirmHours = deps.reconfirmHours ?? VENDOR_RECONFIRM_HOURS;
    this.newId = deps.newId ?? (() => `vr-${String(++this.seq)}`);
  }

  /** Slot approved for a case. Creates a request only for cases with implants or special equipment. */
  async onSlotApproved(c: VendorCaseInput): Promise<SlotApprovedResult> {
    if (this.deps.enabled === false || !needsVendor(c)) return { status: 'no_request' };
    const existing = await this.deps.store.findLiveByCase(c.practiceId, c.caseId);
    if (existing) return { status: 'duplicate', requestId: existing.id };

    const system = c.implantSystem?.trim() ?? '';
    const rep =
      (await this.deps.preferences.preferredRep(c.practiceId, c.surgeonId, system)) ??
      (await this.deps.directory.findRep(c.practiceId, system));
    if (!rep) return { status: 'no_rep' };

    const facility = await this.deps.facilities.get(c.practiceId, c.facilityId);
    const fields = toVendorRequestFields(c, facility);
    const now = this.deps.clock.now();
    const leadTimeRisk = this.leadTimeRisk(now, c.surgeryStart, facility.trayLeadTimeDays);

    const record: VendorRequestRecord = {
      id: this.newId(),
      practiceId: c.practiceId,
      caseId: c.caseId,
      rep,
      surgeryStart: c.surgeryStart,
      fields,
      status: 'awaiting_approval',
      attendance: 'pending',
      trayDelivery: 'pending',
      leadTimeRisk,
      reconfirmSentAt: null,
      sentAt: null,
      coordinationRequestIds: [],
      pending: [],
    };
    if (leadTimeRisk) {
      // Flag for the scheduler, but still send the request.
      await this.deps.alerts.flag({
        practiceId: c.practiceId,
        caseId: c.caseId,
        code: 'vendor_lead_time_risk',
        message: leadTimeRisk.message,
      });
    }
    const status = await this.dispatch(record, 'request', fields, c.surgeryStart);
    return { status, requestId: record.id, leadTimeRisk };
  }

  /** Approver released a queued outbound message. */
  async approve(requestId: string, pendingId: string): Promise<boolean> {
    const record = await this.deps.store.get(requestId);
    const item = record?.pending.find((p) => p.id === pendingId);
    if (!record || !item) return false;
    record.pending = record.pending.filter((p) => p.id !== pendingId);
    await this.send(record, item);
    return true;
  }

  /** Vendor reply, already matched to the request by the inbound layer. */
  async recordReply(requestId: string, reply: VendorReply): Promise<VendorRequestRecord | null> {
    const record = await this.deps.store.get(requestId);
    if (record?.status !== 'active') return null;
    if (reply.attendance) record.attendance = reply.attendance;
    if (reply.trayDelivery) record.trayDelivery = reply.trayDelivery;
    await this.deps.store.save(record);
    return record;
  }

  /** Case changed (date, time, facility, procedure, implants). Sends an update or a cancel. */
  async onCaseChanged(c: VendorCaseInput): Promise<'updated' | 'cancelled' | 'unchanged' | 'created'> {
    const record = await this.deps.store.findLiveByCase(c.practiceId, c.caseId);
    if (!record) {
      const r = await this.onSlotApproved(c);
      return r.status === 'sent' || r.status === 'awaiting_approval' ? 'created' : 'unchanged';
    }
    if (!needsVendor(c)) {
      await this.onCaseCancelled(c.practiceId, c.caseId);
      return 'cancelled';
    }
    const facility = await this.deps.facilities.get(c.practiceId, c.facilityId);
    const next = toVendorRequestFields(c, facility);
    const changes = changedLabels(record.fields, next);
    if (changes.length === 0) return 'unchanged';
    await this.dispatch(record, 'update', next, c.surgeryStart, changes);
    return 'updated';
  }

  async onCaseCancelled(practiceId: string, caseId: string): Promise<boolean> {
    const record = await this.deps.store.findLiveByCase(practiceId, caseId);
    if (!record) return false;
    if (record.status === 'awaiting_approval' && record.sentAt === null) {
      // Nothing ever went out; just drop it.
      record.status = 'cancelled';
      record.pending = [];
      await this.deps.store.save(record);
      return true;
    }
    await this.dispatch(record, 'cancel', null, null);
    return true;
  }

  /** Scheduled tick: sends re-confirmations that have come due. Returns the request ids reconfirmed. */
  async runReconfirmations(practiceId: string): Promise<string[]> {
    const now = this.deps.clock.now().getTime();
    const sent: string[] = [];
    for (const record of await this.deps.store.listLive(practiceId)) {
      if (record.status !== 'active' || record.reconfirmSentAt !== null) continue;
      if (record.pending.some((p) => p.kind === 'reconfirm')) continue;
      const start = new Date(record.surgeryStart).getTime();
      if (start <= now || now < start - this.reconfirmHours * HOUR_MS) continue;
      await this.dispatch(record, 'reconfirm', null, null);
      sent.push(record.id);
    }
    return sent;
  }

  private leadTimeRisk(now: Date, start: string, requiredDays: number): LeadTimeRisk | null {
    const actualDays = (new Date(start).getTime() - now.getTime()) / DAY_MS;
    if (actualDays >= requiredDays) return null;
    const shown = Math.max(0, Math.floor(actualDays * 10) / 10);
    return {
      requiredDays,
      actualDays: shown,
      message: `Facility needs trays ${String(requiredDays)} days ahead; surgery is ${String(shown)} days out. Request sent late.`,
    };
  }

  /** Builds the outbound message and either sends it or queues it per policy. */
  private async dispatch(
    record: VendorRequestRecord,
    kind: OutboundKind,
    fields: VendorRequestFields | null,
    surgeryStart: string | null,
    changes: string[] = [],
  ): Promise<'sent' | 'awaiting_approval'> {
    const content = renderVendorMessage(kind, fields ?? record.fields, changes);
    const pendingId = `${record.id}-p${String(record.pending.length + record.coordinationRequestIds.length + 1)}`;
    const item: PendingOutbound = {
      id: pendingId,
      kind,
      message: {
        practiceId: record.practiceId,
        caseId: record.caseId,
        kind,
        to: record.rep,
        subject: content.subject,
        body: content.body,
        dedupeKey: `${record.id}:${kind}:${pendingId}`,
      },
      fields,
      surgeryStart,
    };
    const mode = await this.policy.modeFor(record.practiceId, kind);
    if (mode === 'approve_first') {
      record.pending.push(item);
      await this.deps.store.save(record);
      await this.deps.approvals.enqueue({
        practiceId: record.practiceId,
        caseId: record.caseId,
        requestId: record.id,
        pendingId,
        kind,
        summary: content.subject,
      });
      return 'awaiting_approval';
    }
    await this.send(record, item);
    return 'sent';
  }

  private async send(record: VendorRequestRecord, item: PendingOutbound): Promise<void> {
    const { coordinationRequestId } = await this.deps.coordination.send(item.message);
    const now = this.deps.clock.now();
    record.coordinationRequestIds.push(coordinationRequestId);
    if (item.kind === 'request' || item.kind === 'update') {
      record.status = 'active';
      record.sentAt ??= now.toISOString();
      if (item.fields) record.fields = item.fields;
      if (item.surgeryStart) record.surgeryStart = item.surgeryStart;
      // New details need fresh confirmation.
      record.attendance = 'pending';
      record.trayDelivery = 'pending';
      record.reconfirmSentAt = null;
      // Sent inside the re-confirm window already: the request itself is the reconfirmation.
      const start = new Date(record.surgeryStart).getTime();
      if (start - now.getTime() <= this.reconfirmHours * HOUR_MS) {
        record.reconfirmSentAt = now.toISOString();
      }
    } else if (item.kind === 'reconfirm') {
      record.reconfirmSentAt = now.toISOString();
    } else {
      record.status = 'cancelled';
      record.pending = [];
    }
    await this.deps.store.save(record);
  }
}
