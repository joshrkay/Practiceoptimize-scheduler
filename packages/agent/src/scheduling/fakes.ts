/**
 * In-memory implementation of the scheduling ports, driven by a fixture. For tests and local
 * development only; real adapters replace it at integration. Every lookup is scoped to the
 * practice ID it is asked about.
 */
import type { BlockWindow, BookedInterval } from './blocks.js';
import type {
  AuthorizationWindow,
  BusyInterval,
  Coverage,
  ResolvedSurgeonPreferences,
  SchedulingPorts,
  SiteOfServiceRule,
} from './ports.js';
import type { PracticeId, SchedulingCase, Site } from './types.js';

export interface SchedulingFixture {
  practiceId: PracticeId;
  now: string;
  sites: Site[];
  /** Coverage by patient ID. */
  coverage: Record<string, Coverage | null>;
  siteOfServiceRules: { payerId: string; planId: string; procedureCode: string; rule: SiteOfServiceRule }[];
  privileges: { surgeonId: string; facilityId: string; procedureCodes: string[]; granted: boolean; validUntil?: string }[];
  /** Risk flags from the order, by case ID. */
  riskFlags: Record<string, string[]>;
  highRiskFlags: string[];
  surgeonPreferences: Record<string, ResolvedSurgeonPreferences>;
  blockWindows: BlockWindow[];
  booked: BookedInterval[];
  authorizations: Record<string, AuthorizationWindow>;
  readinessLeadTimeDays: Record<string, number>;
  teamBusy: BusyInterval[];
  cases: Record<string, SchedulingCase>;
}

const overlaps = (start: string, end: string, from: string, to: string) =>
  Date.parse(end) > Date.parse(from) && Date.parse(start) < Date.parse(to);

export function createInMemorySchedulingPorts(
  fixture: SchedulingFixture,
  options: { slotFindingEnabled?: boolean } = {},
): SchedulingPorts {
  const own = (practiceId: PracticeId) => practiceId === fixture.practiceId;
  return {
    facilities: {
      listSites: async ({ practiceId }) => (own(practiceId) ? fixture.sites : []),
    },
    eligibility: {
      getCoverage: async ({ practiceId, patientId }) => (own(practiceId) ? (fixture.coverage[patientId] ?? null) : null),
    },
    payerRules: {
      getSiteOfServiceRule: async ({ practiceId, payerId, planId, procedureCode }) =>
        (own(practiceId)
          ? fixture.siteOfServiceRules.find(
              (r) => r.payerId === payerId && r.planId === planId && r.procedureCode === procedureCode,
            )?.rule
          : undefined) ?? { allowedSiteKinds: 'any', source: 'no payer rule on file' },
    },
    privileges: {
      getPrivilege: async ({ practiceId, surgeonId, facilityId, procedureCode }) => {
        if (!own(practiceId)) return null;
        const p = fixture.privileges.find(
          (x) => x.surgeonId === surgeonId && x.facilityId === facilityId && x.procedureCodes.includes(procedureCode),
        );
        if (!p) return null;
        return p.validUntil !== undefined ? { granted: p.granted, validUntil: p.validUntil } : { granted: p.granted };
      },
    },
    patientRisk: {
      getRiskFlags: async ({ practiceId, caseId }) => (own(practiceId) ? (fixture.riskFlags[caseId] ?? []) : []),
    },
    settings: {
      getHighRiskFlags: async ({ practiceId }) => (own(practiceId) ? fixture.highRiskFlags : []),
      resolveSurgeonPreferences: async ({ practiceId, surgeonId }) =>
        (own(practiceId) ? fixture.surgeonPreferences[surgeonId] : undefined) ?? { preferredSiteIds: [], caseOrder: 'any' },
    },
    blockTime: {
      getFacilitySchedule: async ({ practiceId, facilityId, from, to }) => ({
        windows: fixture.blockWindows.filter(
          (w) => w.practiceId === practiceId && w.facilityId === facilityId && overlaps(w.start, w.end, from, to),
        ),
        booked: fixture.booked.filter(
          (b) => b.practiceId === practiceId && b.facilityId === facilityId && overlaps(b.start, b.end, from, to),
        ),
      }),
    },
    authorizations: {
      getAuthorization: async ({ practiceId, caseId }) =>
        (own(practiceId) ? fixture.authorizations[caseId] : undefined) ?? { status: 'not_required' },
    },
    readiness: {
      getLeadTimeDays: async ({ practiceId, caseId }) => (own(practiceId) ? (fixture.readinessLeadTimeDays[caseId] ?? 0) : 0),
    },
    teamAvailability: {
      getBusy: async ({ practiceId, memberIds, from, to }) =>
        own(practiceId)
          ? fixture.teamBusy.filter((b) => memberIds.includes(b.memberId) && overlaps(b.start, b.end, from, to))
          : [],
    },
    flags: { isEnabled: () => options.slotFindingEnabled ?? false },
  };
}
