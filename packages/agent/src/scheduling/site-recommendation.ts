/**
 * Site recommendation: which office procedure room or ASC a case should go to, with reasons.
 *
 * Filters by payer network, payer site-of-service rules, surgeon privileges, anesthesia the site
 * can provide, and patient risk flags the site will not accept; then ranks by surgeon preference,
 * with anesthesia fit as the tie-break. Hospitals are never candidates. A patient with a
 * configured high-risk flag makes site choice human-only: options are listed with reasons and
 * nothing is recommended.
 */
import type { Coverage, NetworkStatus, Privilege, SiteOfServiceRule, SiteRecommendationPorts } from './ports.js';
import { toMs } from './time.js';
import { ANESTHESIA_LEVEL, type Reason, type SchedulingCase, type Site, type SiteKind } from './types.js';

export interface SiteOption {
  site: Site;
  /** 1-based rank among eligible sites. */
  rank: number;
  /** 1-based position in the surgeon's preferred sites, or null when not listed. */
  preferenceRank: number | null;
  networkStatus: NetworkStatus;
  /** Privilege expiry at this site; slots must end by then. */
  privilegeValidUntil?: string;
  reasons: Reason[];
}

export interface ExcludedSite {
  site: Site;
  reasons: Reason[];
}

export type SiteSelection = 'agent' | 'human_only';

export interface SiteRecommendation {
  practiceId: string;
  caseId: string;
  /** `human_only` when a configured high-risk flag is present; the scheduler picks the site. */
  selection: SiteSelection;
  /** The top option when the agent may select; always null when selection is human-only. */
  recommended: SiteOption | null;
  /** Eligible sites, best first. */
  options: SiteOption[];
  excluded: ExcludedSite[];
  /** Patient risk flags the practice treats as high risk. */
  highRiskFlags: string[];
  notes: Reason[];
}

const SITE_KIND_LABEL: Record<SiteKind, string> = {
  office_procedure_room: 'office procedure room',
  asc: 'ASC',
  hospital: 'hospital',
};

export async function recommendSite(
  schedulingCase: SchedulingCase,
  ports: SiteRecommendationPorts,
  now: string,
): Promise<SiteRecommendation> {
  const { practiceId, caseId, patientId, surgeonId, procedureCode } = schedulingCase;
  const nowMs = toMs(now);

  const [allSites, coverage, riskFlags, configuredHighRisk, preferences] = await Promise.all([
    ports.facilities.listSites({ practiceId }),
    ports.eligibility.getCoverage({ practiceId, caseId, patientId }),
    ports.patientRisk.getRiskFlags({ practiceId, caseId }),
    ports.settings.getHighRiskFlags({ practiceId }),
    ports.settings.resolveSurgeonPreferences({ practiceId, surgeonId, procedureCode }),
  ]);

  // Practice isolation: never consider another practice's sites, even if a port returns them.
  const sites = allSites.filter((s) => s.practiceId === practiceId).sort((a, b) => a.id.localeCompare(b.id));
  const highRiskFlags = riskFlags.filter((f) => configuredHighRisk.includes(f)).sort();

  const rule =
    coverage && coverage.active
      ? await ports.payerRules.getSiteOfServiceRule({
          practiceId,
          payerId: coverage.payerId,
          planId: coverage.planId,
          procedureCode,
        })
      : null;

  const eligible: Omit<SiteOption, 'rank'>[] = [];
  const excluded: ExcludedSite[] = [];

  for (const site of sites) {
    if (site.kind === 'hospital') {
      excluded.push({
        site,
        reasons: [{ code: 'hospital_out_of_scope', message: `${site.name} is a hospital; only office procedure rooms and ASCs are candidates` }],
      });
      continue;
    }
    const privilege = await ports.privileges.getPrivilege({ practiceId, surgeonId, facilityId: site.id, procedureCode });
    const evaluation = evaluateSite(site, schedulingCase, coverage, rule, privilege, riskFlags, nowMs);
    if (evaluation.blocking.length > 0) {
      excluded.push({ site, reasons: evaluation.blocking });
      continue;
    }
    const prefIndex = preferences.preferredSiteIds.indexOf(site.id);
    const preferenceRank = prefIndex >= 0 ? prefIndex + 1 : null;
    const reasons = [
      ...evaluation.supporting,
      preferenceRank === null
        ? { code: 'not_preferred', message: `${site.name} is not on the surgeon's preferred site list` }
        : { code: 'surgeon_preference', message: `Surgeon's #${preferenceRank} preferred site` },
    ];
    eligible.push({
      site,
      preferenceRank,
      networkStatus: 'in_network',
      ...(privilege?.validUntil !== undefined ? { privilegeValidUntil: privilege.validUntil } : {}),
      reasons,
    });
  }

  const needed = ANESTHESIA_LEVEL[schedulingCase.anesthesia];
  const headroom = (site: Site) => Math.max(...site.supportedAnesthesia.map((a) => ANESTHESIA_LEVEL[a])) - needed;
  eligible.sort(
    (a, b) =>
      (a.preferenceRank ?? Number.POSITIVE_INFINITY) - (b.preferenceRank ?? Number.POSITIVE_INFINITY) ||
      headroom(a.site) - headroom(b.site) ||
      a.site.id.localeCompare(b.site.id),
  );
  const options: SiteOption[] = eligible.map((o, i) => ({ ...o, rank: i + 1 }));

  const notes: Reason[] = [];
  const selection: SiteSelection = highRiskFlags.length > 0 ? 'human_only' : 'agent';
  if (selection === 'human_only') {
    notes.push({
      code: 'high_risk_human_only',
      message: `Patient is flagged high risk (${highRiskFlags.join(', ')}); the scheduler must choose the site`,
    });
  }
  if (options.length === 0) {
    notes.push({ code: 'no_eligible_site', message: 'No office procedure room or ASC meets network, payer, privilege, anesthesia and risk requirements' });
  }

  return {
    practiceId,
    caseId,
    selection,
    recommended: selection === 'agent' ? (options[0] ?? null) : null,
    options,
    excluded,
    highRiskFlags,
    notes,
  };
}

function evaluateSite(
  site: Site,
  schedulingCase: SchedulingCase,
  coverage: Coverage | null,
  rule: SiteOfServiceRule | null,
  privilege: Privilege | null,
  riskFlags: string[],
  nowMs: number,
): { blocking: Reason[]; supporting: Reason[] } {
  const blocking: Reason[] = [];
  const supporting: Reason[] = [];
  const kindLabel = SITE_KIND_LABEL[site.kind];

  // Payer network (from eligibility).
  if (!coverage || !coverage.active) {
    blocking.push({ code: 'coverage_not_active', message: 'No active coverage on file to confirm the payer network' });
  } else {
    const status = coverage.facilityNetwork[site.id] ?? 'unknown';
    if (status === 'in_network') {
      supporting.push({ code: 'in_network', message: `${site.name} is in network for the patient's plan` });
    } else if (status === 'out_of_network') {
      blocking.push({ code: 'out_of_network', message: `${site.name} is out of network for the patient's plan` });
    } else {
      blocking.push({ code: 'network_unknown', message: `Network status for ${site.name} is unknown` });
    }
  }

  // Payer site-of-service rule.
  if (rule) {
    if (rule.allowedSiteKinds === 'any') {
      supporting.push({ code: 'site_of_service_allowed', message: `Payer has no site-of-service restriction for ${schedulingCase.procedureName}` });
    } else if (rule.allowedSiteKinds.includes(site.kind)) {
      supporting.push({ code: 'site_of_service_allowed', message: `Payer allows ${kindLabel} for ${schedulingCase.procedureName} (${rule.source})` });
    } else {
      blocking.push({ code: 'site_of_service_not_allowed', message: `Payer does not cover ${kindLabel} for ${schedulingCase.procedureName} (${rule.source})` });
    }
  }

  // Surgeon privileges.
  if (!privilege || !privilege.granted) {
    blocking.push({ code: 'no_privileges', message: `Surgeon has no privileges at ${site.name} for ${schedulingCase.procedureName}` });
  } else if (privilege.validUntil !== undefined && toMs(privilege.validUntil) <= nowMs) {
    blocking.push({ code: 'privileges_expired', message: `Surgeon's privileges at ${site.name} expired ${privilege.validUntil.slice(0, 10)}` });
  } else {
    supporting.push({
      code: 'privileges',
      message:
        privilege.validUntil === undefined
          ? `Surgeon has privileges at ${site.name}`
          : `Surgeon has privileges at ${site.name} through ${privilege.validUntil.slice(0, 10)}`,
    });
  }

  // Anesthesia needs.
  if (!site.supportedAnesthesia.includes(schedulingCase.anesthesia)) {
    blocking.push({ code: 'anesthesia_not_supported', message: `${site.name} cannot provide ${schedulingCase.anesthesia} anesthesia` });
  } else {
    supporting.push({ code: 'anesthesia_supported', message: `${site.name} provides the ${schedulingCase.anesthesia} anesthesia this case needs` });
  }

  // Patient risk flags the site will not accept.
  const refused = riskFlags.filter((f) => site.excludedRiskFlags.includes(f)).sort();
  if (refused.length > 0) {
    blocking.push({ code: 'risk_flag_excluded', message: `${site.name} does not accept patients flagged ${refused.join(', ')}` });
  }

  return { blocking, supporting };
}
