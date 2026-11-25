/**
 * Slot finding: the top three slots for a case at its site, with reasons.
 *
 * Runs site recommendation first, so a slot is only ever proposed at a site that is in network,
 * allowed by the payer's site-of-service rule, and where the surgeon holds privileges. Searches
 * the surgeon's block time (and released or open time where the facility shares it) for windows
 * that fit the estimated duration, the authorization validity window, the readiness lead time,
 * the surgeon's privilege expiry, team free/busy, and, for later cases in a case series, the
 * surgeon's planned spacing. Ranks by the surgeon's case-order preference, then earliest day, then
 * the surgeon's own block over shared time on the same day, then earliest start.
 *
 * Nothing is booked here: every slot is a proposal that needs scheduler approval, and approval
 * triggers facility posting (RAH-39). Gated by `FEATURE_SLOT_FINDING` (default off).
 */
import type { BlockWindow, BlockWindowKind } from './blocks.js';
import { SLOT_FINDING_FLAG, type AuthorizationWindow, type CaseOrderPreference, type SchedulingPorts } from './ports.js';
import { recommendSite, type SiteOption, type SiteRecommendation } from './site-recommendation.js';
import { DAY_MS, MINUTE_MS, freeGaps, toDate, toIso, toLabel, toMs, type Interval } from './time.js';
import type { Reason, SchedulingCase } from './types.js';

export const MAX_SLOTS = 3;
export const DEFAULT_SEARCH_DAYS = 60;

export interface FindSlotsInput {
  schedulingCase: SchedulingCase;
  /** Current time; all lead times are measured from here. */
  now: string;
  /** End of the search horizon. Defaults to `now` plus 60 days. */
  searchTo?: string;
  /** Site the scheduler chose. Required when site choice is human-only; must be an eligible option. */
  chosenSiteId?: string;
}

export interface BookingGate {
  /** Booking always needs a scheduler's approval first. */
  approval: 'approve_first';
  /** What approval triggers. */
  onApproval: 'post_to_facility';
}

export interface SlotProposal {
  siteId: string;
  siteName: string;
  roomId: string;
  blockWindowId: string;
  windowKind: BlockWindowKind;
  start: string;
  end: string;
  reasons: Reason[];
  booking: BookingGate;
}

export type SlotFindingStatus =
  | 'disabled'
  | 'awaiting_site_choice'
  | 'no_eligible_site'
  | 'site_not_eligible'
  | 'authorization_denied'
  | 'missing_series_anchor'
  | 'no_slots'
  | 'slots_found';

export interface SlotFindingResult {
  status: SlotFindingStatus;
  /** Null only when the feature flag is off. */
  siteRecommendation: SiteRecommendation | null;
  /** The site slots were searched at. */
  site: SiteOption | null;
  /** Up to three slots, best first. */
  slots: SlotProposal[];
  notes: Reason[];
}

const BOOKING_GATE: BookingGate = { approval: 'approve_first', onApproval: 'post_to_facility' };

const KIND_PRIORITY: Record<BlockWindowKind, number> = { surgeon_block: 0, released: 1, open: 2 };

export async function findSlots(input: FindSlotsInput, ports: SchedulingPorts): Promise<SlotFindingResult> {
  if (!ports.flags.isEnabled(SLOT_FINDING_FLAG)) {
    return {
      status: 'disabled',
      siteRecommendation: null,
      site: null,
      slots: [],
      notes: [{ code: 'feature_disabled', message: `${SLOT_FINDING_FLAG} is off` }],
    };
  }

  const { schedulingCase: c, now } = input;
  const nowMs = toMs(now);
  const recommendation = await recommendSite(c, ports, now);
  const result = (status: SlotFindingStatus, site: SiteOption | null, notes: Reason[], slots: SlotProposal[] = []) => ({
    status,
    siteRecommendation: recommendation,
    site,
    slots,
    notes: [...recommendation.notes, ...notes],
  });

  // 1. Which site to search.
  let site: SiteOption | null;
  if (input.chosenSiteId !== undefined) {
    site = recommendation.options.find((o) => o.site.id === input.chosenSiteId) ?? null;
    if (!site) {
      return result('site_not_eligible', null, [
        { code: 'site_not_eligible', message: `Site ${input.chosenSiteId} is not an eligible option for this case` },
      ]);
    }
  } else if (recommendation.selection === 'human_only') {
    return result('awaiting_site_choice', null, []);
  } else {
    site = recommendation.recommended;
    if (!site) return result('no_eligible_site', null, []);
  }

  // 2. Time bounds from authorization, readiness, privileges, series spacing and horizon.
  const [auth, leadTimeDays, preferences] = await Promise.all([
    ports.authorizations.getAuthorization({ practiceId: c.practiceId, caseId: c.caseId }),
    ports.readiness.getLeadTimeDays({ practiceId: c.practiceId, caseId: c.caseId }),
    ports.settings.resolveSurgeonPreferences({ practiceId: c.practiceId, surgeonId: c.surgeonId, procedureCode: c.procedureCode }),
  ]);
  if (auth.status === 'denied') {
    return result('authorization_denied', site, [{ code: 'authorization_denied', message: 'Authorization was denied; no slots proposed' }]);
  }

  const readyMs = nowMs + leadTimeDays * DAY_MS;
  const lowers = [nowMs, readyMs];
  const uppers = [input.searchTo !== undefined ? toMs(input.searchTo) : nowMs + DEFAULT_SEARCH_DAYS * DAY_MS];
  if (auth.status === 'approved') {
    if (auth.validFrom !== undefined) lowers.push(toMs(auth.validFrom));
    if (auth.validTo !== undefined) uppers.push(toMs(auth.validTo));
  }
  if (site.privilegeValidUntil !== undefined) uppers.push(toMs(site.privilegeValidUntil));

  let seriesReason: ((startMs: number) => Reason) | null = null;
  const series = c.series;
  if (series && series.sequence > 1) {
    if (series.previousCaseStart === undefined) {
      return result('missing_series_anchor', site, [
        { code: 'missing_series_anchor', message: `Case ${series.sequence} of the series needs the previous case's date first` },
      ]);
    }
    const prevMs = toMs(series.previousCaseStart);
    const spacing = preferences.seriesSpacingDays ?? { min: 0 };
    lowers.push(prevMs + spacing.min * DAY_MS);
    if (spacing.max !== undefined) uppers.push(prevMs + spacing.max * DAY_MS);
    const range = spacing.max !== undefined ? `${spacing.min}-${spacing.max}` : `at least ${spacing.min}`;
    seriesReason = (startMs) => ({
      code: 'series_spacing',
      message: `${Math.floor((startMs - prevMs) / DAY_MS)} days after case ${series.sequence - 1} of the series, within the surgeon's planned spacing of ${range} days`,
    });
  }

  const lower = Math.max(...lowers);
  const upper = Math.min(...uppers);
  if (lower >= upper) {
    return result('no_slots', site, [
      { code: 'no_search_window', message: 'Authorization, readiness, privilege and series constraints leave no time to search' },
    ]);
  }

  // 3. Block time and calendars.
  const from = toIso(lower);
  const to = toIso(upper);
  const [schedule, teamBusy] = await Promise.all([
    ports.blockTime.getFacilitySchedule({ practiceId: c.practiceId, facilityId: site.site.id, surgeonId: c.surgeonId, from, to }),
    ports.teamAvailability.getBusy({ practiceId: c.practiceId, memberIds: [c.surgeonId, ...c.teamMemberIds], from, to }),
  ]);
  const teamIntervals: Interval[] = teamBusy.map((b) => ({ start: toMs(b.start), end: toMs(b.end) }));
  const durationMs = c.estimatedDurationMinutes * MINUTE_MS;
  const usable = (w: BlockWindow) =>
    w.practiceId === c.practiceId &&
    w.facilityId === site.site.id &&
    (w.kind === 'surgeon_block'
      ? w.surgeonId === c.surgeonId
      : w.kind === 'released'
        ? site.site.sharesReleasedTime
        : site.site.sharesOpenTime);

  const candidates: { proposal: SlotProposal; matchesOrder: boolean; startMs: number; kind: BlockWindowKind }[] = [];
  for (const window of schedule.windows.filter(usable)) {
    const win = { start: toMs(window.start), end: toMs(window.end) };
    const roomBusy = schedule.booked
      .filter((b) => b.practiceId === c.practiceId && b.facilityId === window.facilityId && b.roomId === window.roomId)
      .map((b) => ({ start: toMs(b.start), end: toMs(b.end) }));
    const gaps = freeGaps(win, [...roomBusy, ...teamIntervals]);
    const pick = pickInGaps(gaps, durationMs, lower, upper, preferences.caseOrder);
    if (!pick) continue;
    const isFirst = pick.start === win.start;
    const isLast = pick.end === win.end;
    const matchesOrder = preferences.caseOrder === 'first_case' ? isFirst : preferences.caseOrder === 'last_case' ? isLast : true;

    const reasons: Reason[] = [
      windowReason(window, site.site.name),
      {
        code: 'fits_duration',
        message: `Fits the ${c.estimatedDurationMinutes}-minute estimated duration in free time ${toLabel(pick.gap.start)}-${toLabel(pick.gap.end).slice(11)} UTC`,
      },
      caseOrderReason(preferences.caseOrder, isFirst, isLast),
      authReason(auth),
      {
        code: 'readiness_lead_time',
        message: `After the ${leadTimeDays}-day readiness lead time (ready from ${toDate(readyMs)})`,
      },
      {
        code: 'team_free',
        message: c.teamMemberIds.length > 0 ? `Surgeon and ${c.teamMemberIds.length} team member(s) are free` : 'Surgeon is free',
      },
    ].filter((r): r is Reason => r !== null);
    if (site.privilegeValidUntil !== undefined) {
      reasons.push({ code: 'within_privileges', message: `Ends before the surgeon's privileges expire on ${site.privilegeValidUntil.slice(0, 10)}` });
    }
    if (seriesReason) reasons.push(seriesReason(pick.start));

    candidates.push({
      matchesOrder,
      startMs: pick.start,
      kind: window.kind,
      proposal: {
        siteId: site.site.id,
        siteName: site.site.name,
        roomId: window.roomId,
        blockWindowId: window.id,
        windowKind: window.kind,
        start: toIso(pick.start),
        end: toIso(pick.end),
        reasons,
        booking: BOOKING_GATE,
      },
    });
  }

  candidates.sort(
    (a, b) =>
      Number(b.matchesOrder) - Number(a.matchesOrder) ||
      Math.floor(a.startMs / DAY_MS) - Math.floor(b.startMs / DAY_MS) ||
      KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind] ||
      a.startMs - b.startMs ||
      a.proposal.roomId.localeCompare(b.proposal.roomId) ||
      a.proposal.blockWindowId.localeCompare(b.proposal.blockWindowId),
  );
  const slots = candidates.slice(0, MAX_SLOTS).map((x) => x.proposal);
  if (slots.length === 0) {
    return result('no_slots', site, [{ code: 'no_slots', message: `No block, released or open time at ${site.site.name} fits this case` }]);
  }
  const notes: Reason[] =
    slots.length < MAX_SLOTS ? [{ code: 'fewer_slots', message: `Only ${slots.length} slot(s) fit within the constraints` }] : [];
  return result('slots_found', site, notes, slots);
}

/** One slot per block window: the earliest fit, or the latest fit when the surgeon prefers last case. */
function pickInGaps(
  gaps: Interval[],
  durationMs: number,
  lower: number,
  upper: number,
  caseOrder: CaseOrderPreference,
): { start: number; end: number; gap: Interval } | null {
  if (caseOrder === 'last_case') {
    for (const gap of [...gaps].reverse()) {
      const end = Math.min(gap.end, upper);
      const start = end - durationMs;
      if (start >= Math.max(gap.start, lower)) return { start, end, gap };
    }
    return null;
  }
  for (const gap of gaps) {
    const start = Math.max(gap.start, lower);
    const end = start + durationMs;
    if (end <= Math.min(gap.end, upper)) return { start, end, gap };
  }
  return null;
}

function windowReason(window: BlockWindow, siteName: string): Reason {
  switch (window.kind) {
    case 'surgeon_block':
      return { code: 'surgeon_block', message: `Surgeon's own block at ${siteName}, room ${window.roomId}` };
    case 'released':
      return { code: 'released_time', message: `Released block time ${siteName} shares, room ${window.roomId}` };
    case 'open':
      return { code: 'open_time', message: `Open time ${siteName} shares, room ${window.roomId}` };
  }
}

function caseOrderReason(pref: CaseOrderPreference, isFirst: boolean, isLast: boolean): Reason | null {
  if (pref === 'first_case') {
    return isFirst
      ? { code: 'case_order_match', message: 'First case of the block, as the surgeon prefers' }
      : { code: 'case_order_miss', message: 'Not the first case; the surgeon prefers first case' };
  }
  if (pref === 'last_case') {
    return isLast
      ? { code: 'case_order_match', message: 'Last case of the block, as the surgeon prefers' }
      : { code: 'case_order_miss', message: 'Not the last case; the surgeon prefers last case' };
  }
  return null;
}

/** Reason for an authorization that is not denied (denied cases never reach slot search). */
function authReason(auth: AuthorizationWindow): Reason {
  if (auth.status === 'approved') {
    return {
      code: 'within_authorization',
      message:
        auth.validFrom !== undefined && auth.validTo !== undefined
          ? `Within the authorization valid ${auth.validFrom.slice(0, 10)} to ${auth.validTo.slice(0, 10)}`
          : 'Authorization approved',
    };
  }
  if (auth.status === 'pending') {
    return { code: 'authorization_pending', message: 'Authorization is pending; confirm approval and its dates before booking' };
  }
  return { code: 'authorization_not_required', message: 'Payer requires no authorization for this procedure' };
}
