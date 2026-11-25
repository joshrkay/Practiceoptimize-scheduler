/**
 * Block-time types per facility.
 *
 * The issue places these in `packages/tenancy/src/blocks.ts`; that package is owned elsewhere, so
 * they live here until integration. Block data is read through the `BlockTimeSource` port so a
 * direct ASC scheduling integration (RAH-77) can supply it later without changing slot finding.
 */
import type { PracticeId } from './types.js';

/**
 * - `surgeon_block`: time allocated to one surgeon.
 * - `released`: block time another surgeon released back to the facility.
 * - `open`: unblocked time the facility lets practices book.
 */
export type BlockWindowKind = 'surgeon_block' | 'released' | 'open';

export interface BlockWindow {
  id: string;
  practiceId: PracticeId;
  facilityId: string;
  roomId: string;
  kind: BlockWindowKind;
  /** Owning surgeon; set for `surgeon_block` windows only. */
  surgeonId?: string;
  start: string;
  end: string;
}

/** A case (or turnover) already occupying a room. Carries no patient data. */
export interface BookedInterval {
  practiceId: PracticeId;
  facilityId: string;
  roomId: string;
  start: string;
  end: string;
}

export interface FacilitySchedule {
  windows: BlockWindow[];
  booked: BookedInterval[];
}

export interface FacilityScheduleQuery {
  practiceId: PracticeId;
  facilityId: string;
  surgeonId: string;
  from: string;
  to: string;
}

/** Where block time comes from: manual entry today, an ASC connector (RAH-77) later. */
export interface BlockTimeSource {
  getFacilitySchedule(query: FacilityScheduleQuery): Promise<FacilitySchedule>;
}
