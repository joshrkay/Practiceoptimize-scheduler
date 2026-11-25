import { subtractBusinessDays } from './business-days.js';
import { renderCoverSheet } from './cover-sheet.js';
import type {
  CaseDataPort,
  CaseDocument,
  CaseInfo,
  ClockPort,
  DocumentType,
  FacilityPatRules,
  FacilityRulesPort,
  HolidayPort,
  OpenItemPort,
  PacketRecord,
  PacketStorePort,
  PatSendPort,
  SchedulerAlertPort,
  SendPolicyPort,
} from './ports.js';

export const DEFAULT_CUTOFF_BUSINESS_DAYS = 5;

export interface PatPacketDeps {
  cases: CaseDataPort;
  rules: FacilityRulesPort;
  clock: ClockPort;
  holidays: HolidayPort;
  sender: PatSendPort;
  alerts: SchedulerAlertPort;
  openItems: OpenItemPort;
  policy: SendPolicyPort;
  store: PacketStorePort;
  /** Defaults to FEATURE_COORD_PAT_PACKET === 'true'. */
  featureEnabled?: () => boolean;
}

export type PacketStepResult =
  | { status: 'disabled' }
  | {
      status: 'not_applicable';
      reason: 'office_procedure_room_local_anesthesia' | 'no_pat_rules' | 'case_not_found';
    }
  | { status: 'waiting'; cutoff: string; pendingTypes: DocumentType[] }
  | { status: 'awaiting_approval'; pendingTypes: DocumentType[] }
  | { status: 'sent'; packet: PacketRecord; alerted: boolean }
  | { status: 'already_sent'; packet: PacketRecord }
  | { status: 'nothing_new' };

export interface FacilityRequest {
  sourceRequestId: string;
  documentType: DocumentType;
  note: string;
}

const byLatest = (a: CaseDocument, b: CaseDocument) => b.receivedAt.localeCompare(a.receivedAt);

/** Packet contents in facility order: required types only, ready and unrestricted, newest per type. */
export function selectPacketDocuments(
  rules: FacilityPatRules,
  caseId: string,
  documents: CaseDocument[],
): { included: CaseDocument[]; pendingTypes: DocumentType[] } {
  const included: CaseDocument[] = [];
  const pendingTypes: DocumentType[] = [];
  for (const type of rules.requiredDocumentTypes) {
    const match = documents
      .filter((d) => d.caseId === caseId && d.type === type && d.ready && !d.restricted)
      .sort(byLatest)[0];
    if (match) included.push(match);
    else pendingTypes.push(type);
  }
  return { included, pendingTypes };
}

export function isPacketExempt(info: CaseInfo): boolean {
  return info.siteOfService === 'office_procedure_room' && info.anesthesia === 'local';
}

export function createPatPacketService(deps: PatPacketDeps) {
  const enabled = deps.featureEnabled ?? (() => process.env.FEATURE_COORD_PAT_PACKET === 'true');

  async function dispatch(args: {
    info: CaseInfo;
    rules: FacilityPatRules;
    docs: CaseDocument[];
    pendingTypes: DocumentType[];
    kind: 'original' | 'addendum';
    packetId: string;
    referencesPacketId?: string;
  }): Promise<PacketStepResult> {
    const { info, rules, docs, pendingTypes, kind, referencesPacketId } = args;
    const key = `${info.caseId}:${kind}:${docs
      .map((d) => d.id)
      .sort()
      .join(',')}`;
    const prior = await deps.store.findByKey(info.practiceId, key);
    if (prior) return { status: 'already_sent', packet: prior };

    const mode = await deps.policy.sendMode(info.practiceId, info.caseId);
    if (mode === 'approve_first') {
      await deps.policy.requestApproval(info.practiceId, info.caseId, key);
      return { status: 'awaiting_approval', pendingTypes };
    }

    const coverSheet = renderCoverSheet({ info, documents: docs, pendingTypes, referencesPacketId });
    const { transmissionId } = await deps.sender.send({
      practiceId: info.practiceId,
      caseId: info.caseId,
      facilityId: info.facilityId,
      channel: rules.channel,
      idempotencyKey: key,
      kind,
      coverSheet,
      documentIds: docs.map((d) => d.id),
      ...(referencesPacketId ? { referencesPacketId } : {}),
    });
    const packet: PacketRecord = {
      packetId: args.packetId,
      practiceId: info.practiceId,
      caseId: info.caseId,
      kind,
      idempotencyKey: key,
      sentDocumentIds: docs.map((d) => d.id),
      pendingTypes,
      transmissionId,
      sentOn: deps.clock.today(),
      ...(referencesPacketId ? { referencesPacketId } : {}),
    };
    await deps.store.save(packet);

    let alerted = false;
    if (kind === 'original' && pendingTypes.length > 0) {
      await deps.alerts.alertScheduler({
        practiceId: info.practiceId,
        caseId: info.caseId,
        reason: 'pat_cutoff_missing_items',
        pendingTypes,
      });
      alerted = true;
    }
    return { status: 'sent', packet, alerted };
  }

  async function runPacketStep(practiceId: string, caseId: string): Promise<PacketStepResult> {
    if (!enabled()) return { status: 'disabled' };
    const info = await deps.cases.getCase(practiceId, caseId);
    if (!info) return { status: 'not_applicable', reason: 'case_not_found' };
    if (isPacketExempt(info)) {
      return { status: 'not_applicable', reason: 'office_procedure_room_local_anesthesia' };
    }
    const rules = await deps.rules.resolvePatRules(practiceId, info.facilityId);
    if (!rules) return { status: 'not_applicable', reason: 'no_pat_rules' };

    const docs = await deps.cases.listDocuments(practiceId, caseId);
    const { included, pendingTypes } = selectPacketDocuments(rules, caseId, docs);
    const existing = await deps.store.listForCase(practiceId, caseId);
    const original = existing.find((p) => p.kind === 'original');

    const sentIds = new Set(existing.flatMap((p) => p.sentDocumentIds));
    const toSend = included.filter((d) => !sentIds.has(d.id));

    if (!original) {
      const cutoff = subtractBusinessDays(
        info.surgeryDate,
        rules.cutoffBusinessDays ?? DEFAULT_CUTOFF_BUSINESS_DAYS,
        deps.holidays.holidays(),
      );
      if (pendingTypes.length > 0 && deps.clock.today() < cutoff) {
        return { status: 'waiting', cutoff, pendingTypes };
      }
      if (toSend.length === 0) return { status: 'nothing_new' };
      return dispatch({
        info,
        rules,
        docs: toSend,
        pendingTypes,
        kind: 'original',
        packetId: `${caseId}:original`,
      });
    }

    if (toSend.length === 0) return { status: 'nothing_new' };
    const n = existing.filter((p) => p.kind === 'addendum').length + 1;
    return dispatch({
      info,
      rules,
      docs: toSend,
      pendingTypes,
      kind: 'addendum',
      packetId: `${caseId}:addendum:${n}`,
      referencesPacketId: original.packetId,
    });
  }

  /** The facility asked for more: becomes a new open item. Never widens what a packet may contain. */
  async function handleFacilityRequest(practiceId: string, caseId: string, req: FacilityRequest) {
    const info = await deps.cases.getCase(practiceId, caseId);
    if (!info) return undefined;
    const rules = await deps.rules.resolvePatRules(practiceId, info.facilityId);
    return deps.openItems.createOpenItem({
      practiceId,
      caseId,
      sourceRequestId: req.sourceRequestId,
      documentType: req.documentType,
      note: req.note,
      outsideRequiredList: !rules?.requiredDocumentTypes.includes(req.documentType),
    });
  }

  return { runPacketStep, handleFacilityRequest };
}

export type PatPacketService = ReturnType<typeof createPatPacketService>;
