/**
 * Domain types for site recommendation and slot finding.
 *
 * All instants are ISO-8601 UTC strings (`2026-12-08T13:00:00.000Z`). All logic in this
 * directory is pure and deterministic: the caller passes `now`, and everything external
 * comes through the ports in `ports.ts`.
 */

export type PracticeId = string;

/**
 * Kind of site of service. Hospitals are listed so that facility data containing them can be
 * passed through unchanged, but a hospital is never a candidate (podiatry pilot, ADR-0001).
 */
export type SiteKind = 'office_procedure_room' | 'asc' | 'hospital';

/** Anesthesia a case needs, from least to most involved. */
export type AnesthesiaType = 'local' | 'sedation' | 'general';

export const ANESTHESIA_LEVEL: Readonly<Record<AnesthesiaType, number>> = {
  local: 0,
  sedation: 1,
  general: 2,
};

/** A place a case can be done: the practice's own office procedure room or an ASC. */
export interface Site {
  id: string;
  practiceId: PracticeId;
  name: string;
  kind: SiteKind;
  /** Anesthesia types this site can provide. */
  supportedAnesthesia: AnesthesiaType[];
  /** Patient risk flags this site will not accept (e.g. an ASC that excludes BMI over 40). */
  excludedRiskFlags: string[];
  /** Whether the site lets the practice book into time released from other surgeons' blocks. */
  sharesReleasedTime: boolean;
  /** Whether the site lets the practice book into unblocked open time. */
  sharesOpenTime: boolean;
}

/** A case in a case series (e.g. staged left then right bunionectomy). */
export interface CaseSeriesPosition {
  seriesId: string;
  /** 1-based position of this case in the series. */
  sequence: number;
  /** Scheduled start of the previous case in the series; required when `sequence > 1`. */
  previousCaseStart?: string;
}

/** The case being scheduled. Synthetic identifiers only. */
export interface SchedulingCase {
  practiceId: PracticeId;
  caseId: string;
  patientId: string;
  surgeonId: string;
  /** CPT code of the primary procedure. */
  procedureCode: string;
  procedureName: string;
  anesthesia: AnesthesiaType;
  estimatedDurationMinutes: number;
  /** Team members besides the surgeon whose calendars must be free (assistant, anesthesia). */
  teamMemberIds: string[];
  series?: CaseSeriesPosition;
}

/** Why a site was excluded or how it fits; shown to the scheduler. */
export interface Reason {
  code: string;
  message: string;
}
