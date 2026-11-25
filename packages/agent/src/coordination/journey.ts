/**
 * The care team coordination journey: which party is contacted, for what, at which case stage.
 *
 * Facility postings and peer-to-peer requests are always approve-first. That is a hard rule in
 * `isApproveFirst`, not a journey setting: a journey definition cannot turn it off.
 */
import type { CoordinationRequestType, OutboundChannel, PartyRole } from './requests.js';

export type SiteOfService = 'asc' | 'office';

/** The slice of the case record the journey needs. */
export interface CaseSnapshot {
  practiceId: string;
  caseId: string;
  /** Current case stage, e.g. `scheduled`, `pre_op`, `authorization_denied`, `post_op`. */
  stage: string;
  /** Surgery date, YYYY-MM-DD. */
  surgeryDate: string;
  siteOfService: SiteOfService;
  /** Case facts that switch optional steps on, e.g. `implant`, `clearance_required`. */
  flags: readonly string[];
}

export type DueRule = { daysBeforeSurgery: number } | { hoursAfterSend: number };

export interface JourneyStep {
  id: string;
  stage: string;
  partyRole: PartyRole;
  type: CoordinationRequestType;
  /** Overrides the party's preferred channel from the directory. */
  channel?: OutboundChannel;
  /** Extra approve-first steps; facility postings and peer-to-peers are approve-first regardless. */
  approveFirst?: boolean;
  /** An overdue request from this step raises the case's risk in the Today view. */
  blocksReadiness: boolean;
  /** A surgery date change re-runs this step from the new date. */
  dateSensitive: boolean;
  due: DueRule;
  /** Only for these sites of service; every site when omitted. */
  siteOfService?: readonly SiteOfService[];
  /** Only when the case carries this flag. */
  requiresFlag?: string;
}

export interface JourneyDefinition {
  id: string;
  steps: readonly JourneyStep[];
}

const ALWAYS_APPROVE_FIRST: ReadonlySet<CoordinationRequestType> = new Set(['facility_posting', 'peer_to_peer']);

export function isApproveFirst(step: Pick<JourneyStep, 'type' | 'approveFirst'>): boolean {
  return ALWAYS_APPROVE_FIRST.has(step.type) || step.approveFirst === true;
}

export function stepApplies(step: JourneyStep, snapshot: CaseSnapshot): boolean {
  if (step.siteOfService && !step.siteOfService.includes(snapshot.siteOfService)) return false;
  if (step.requiresFlag !== undefined && !snapshot.flags.includes(step.requiresFlag)) return false;
  return true;
}

/** The steps to run when the case reaches `stage`. */
export function stepsForStage(journey: JourneyDefinition, stage: string, snapshot: CaseSnapshot): JourneyStep[] {
  return journey.steps.filter((step) => step.stage === stage && stepApplies(step, snapshot));
}

export function findStep(journey: JourneyDefinition, stepId: string): JourneyStep | undefined {
  return journey.steps.find((step) => step.id === stepId);
}

const HOUR_MS = 60 * 60 * 1000;

/** When a request from `step` is due back, given when it is created and the surgery date. */
export function computeDueAt(step: Pick<JourneyStep, 'due'>, surgeryDate: string, createdAt: Date): Date {
  if ('daysBeforeSurgery' in step.due) {
    const surgery = new Date(`${surgeryDate}T00:00:00.000Z`);
    return new Date(surgery.getTime() - step.due.daysBeforeSurgery * 24 * HOUR_MS);
  }
  return new Date(createdAt.getTime() + step.due.hoursAfterSend * HOUR_MS);
}

/** Podiatry pilot journey for office procedure rooms and ASCs. */
export const PODIATRY_JOURNEY: JourneyDefinition = {
  id: 'podiatry-v1',
  steps: [
    {
      id: 'facility-posting',
      stage: 'scheduled',
      partyRole: 'facility_or_desk',
      type: 'facility_posting',
      blocksReadiness: true,
      dateSensitive: true,
      due: { daysBeforeSurgery: 14 },
      siteOfService: ['asc'],
    },
    {
      id: 'vendor-rep',
      stage: 'scheduled',
      partyRole: 'vendor_rep',
      type: 'vendor_rep',
      blocksReadiness: true,
      dateSensitive: true,
      due: { daysBeforeSurgery: 7 },
      requiresFlag: 'implant',
    },
    {
      id: 'anesthesia-packet',
      stage: 'scheduled',
      partyRole: 'anesthesia',
      type: 'anesthesia_packet',
      blocksReadiness: true,
      dateSensitive: true,
      due: { daysBeforeSurgery: 3 },
      siteOfService: ['asc'],
    },
    {
      id: 'clearance-primary-care',
      stage: 'scheduled',
      partyRole: 'primary_care',
      type: 'clearance',
      blocksReadiness: true,
      dateSensitive: true,
      due: { daysBeforeSurgery: 7 },
      requiresFlag: 'clearance_required',
    },
    {
      id: 'clearance-cardiology',
      stage: 'scheduled',
      partyRole: 'cardiology',
      type: 'clearance',
      blocksReadiness: true,
      dateSensitive: true,
      due: { daysBeforeSurgery: 7 },
      requiresFlag: 'cardiac_clearance_required',
    },
    {
      id: 'pre-op-tests',
      stage: 'pre_op',
      partyRole: 'primary_care',
      type: 'pre_op_test',
      blocksReadiness: true,
      dateSensitive: true,
      due: { daysBeforeSurgery: 3 },
      requiresFlag: 'pre_op_labs',
    },
    {
      id: 'peer-to-peer',
      stage: 'authorization_denied',
      partyRole: 'surgeon',
      type: 'peer_to_peer',
      channel: 'in_basket',
      blocksReadiness: true,
      dateSensitive: false,
      due: { hoursAfterSend: 48 },
    },
    {
      id: 'post-op-service',
      stage: 'post_op',
      partyRole: 'post_op_service',
      type: 'post_op_service',
      blocksReadiness: false,
      dateSensitive: false,
      due: { hoursAfterSend: 72 },
      requiresFlag: 'post_op_service',
    },
  ],
};
