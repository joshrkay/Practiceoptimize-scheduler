import type { EhrRequestContext, EhrSystem, PracticeId, LocationId } from './types.js';

/** Everything a connector can be asked to do. Callers check the matrix before acting. */
export const EHR_CAPABILITIES = [
  'orders.read',
  'patient.read',
  'coverage.read',
  'documents.read',
  'appointments.read',
  'schedule.read',
  'appointments.book',
  'chart.write',
  'inbasket.send',
] as const;
export type EhrCapability = (typeof EHR_CAPABILITIES)[number];

export type CapabilitySupport = 'supported' | 'unsupported';

/** Support for every capability on one EHR. */
export type CapabilityProfile = Readonly<Record<EhrCapability, CapabilitySupport>>;

export type CapabilityMatrix = Readonly<Record<EhrSystem, CapabilityProfile>>;

const allSupportedExcept = (...unsupported: EhrCapability[]): CapabilityProfile =>
  Object.fromEntries(
    EHR_CAPABILITIES.map((c) => [c, unsupported.includes(c) ? 'unsupported' : 'supported']),
  ) as CapabilityProfile;

/**
 * Provisional pilot matrix: what each EHR's Redox connection is expected to support.
 *
 * PROVISIONAL. Not yet confirmed against Redox sandboxes for these EHRs. In-basket messages are marked
 * unsupported for every pilot EHR on purpose: until a connection is confirmed, the safe behavior is a
 * workspace task for the scheduler, not a message that may never arrive. A location binding can override
 * entries once a connection is verified (see `LocationSourceBinding.capabilityOverrides`).
 */
export const PILOT_CAPABILITY_MATRIX: CapabilityMatrix = {
  athenahealth: allSupportedExcept('inbasket.send'),
  eclinicalworks: allSupportedExcept('inbasket.send'),
  nextgen: allSupportedExcept('inbasket.send'),
};

export function supportedCapabilities(profile: CapabilityProfile): ReadonlySet<EhrCapability> {
  return new Set(EHR_CAPABILITIES.filter((c) => profile[c] === 'supported'));
}

export function applyOverrides(
  profile: CapabilityProfile,
  overrides: Partial<Record<EhrCapability, CapabilitySupport>> | undefined,
): CapabilityProfile {
  return overrides ? { ...profile, ...overrides } : profile;
}

/**
 * Why a capability is unavailable:
 * - `ehr_does_not_support`: the EHR's connection cannot do it (capability matrix).
 * - `connector_pending_verification`: the EHR can, but our implementation for this vendor is not yet
 *   verified (e.g. awaiting Redox sandbox access), so we refuse rather than guess.
 */
export type UnsupportedReason = 'ehr_does_not_support' | 'connector_pending_verification';

/** A workspace task the caller creates so a person does the step the EHR connection cannot. */
export interface WorkspaceTaskDraft {
  readonly kind: 'ehr_capability_gap';
  readonly practiceId: PracticeId;
  readonly locationId: LocationId;
  readonly capability: EhrCapability;
  readonly ehr: EhrSystem;
  readonly title: string;
  readonly instructions: string;
  /** References only (IDs), never clinical content. */
  readonly subject?: { readonly patientId?: string };
  readonly correlationId?: string;
}

const TASK_TITLES: Record<EhrCapability, string> = {
  'orders.read': 'Check the EHR for new surgical orders',
  'patient.read': 'Look up the patient in the EHR',
  'coverage.read': 'Copy the patient’s coverage from the EHR',
  'documents.read': 'Pull the needed documents from the chart',
  'appointments.read': 'Check the patient’s appointments in the EHR',
  'schedule.read': 'Check open slots in the EHR schedule',
  'appointments.book': 'Book the appointment in the EHR',
  'chart.write': 'File the document in the patient’s chart',
  'inbasket.send': 'Send the in-basket message in the EHR',
};

export interface UnsupportedResult {
  readonly status: 'unsupported';
  readonly capability: EhrCapability;
  readonly ehr: EhrSystem;
  readonly reason: UnsupportedReason;
  readonly workspaceTask: WorkspaceTaskDraft;
}

export function unsupported(
  ctx: EhrRequestContext,
  ehr: EhrSystem,
  capability: EhrCapability,
  reason: UnsupportedReason,
  subject?: { patientId?: string },
): UnsupportedResult {
  const why =
    reason === 'ehr_does_not_support'
      ? `This location's ${ehr} connection does not support "${capability}".`
      : `Automatic "${capability}" for ${ehr} is not yet verified, so it was not attempted.`;
  return {
    status: 'unsupported',
    capability,
    ehr,
    reason,
    workspaceTask: {
      kind: 'ehr_capability_gap',
      practiceId: ctx.practiceId,
      locationId: ctx.locationId,
      capability,
      ehr,
      title: TASK_TITLES[capability],
      instructions: `${why} Do this step in the EHR by hand, then mark the task done.`,
      ...(subject?.patientId !== undefined ? { subject: { patientId: subject.patientId } } : {}),
      ...(ctx.correlationId !== undefined ? { correlationId: ctx.correlationId } : {}),
    },
  };
}
