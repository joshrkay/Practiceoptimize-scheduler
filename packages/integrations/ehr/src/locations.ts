import {
  applyOverrides,
  PILOT_CAPABILITY_MATRIX,
  type CapabilityMatrix,
  type CapabilityProfile,
  type CapabilitySupport,
  type EhrCapability,
} from './capabilities.js';
import type { EhrRequestContext, EhrSystem, LocationId, PracticeId } from './types.js';

/** Redox routing for one location's EHR connection. */
export interface RedoxSourceBinding {
  /** Redox destination ID for this EHR connection (outbound messages). */
  readonly destinationId: string;
  /** Identifier type used for patient IDs at this EHR (e.g. "MR", an EHR-specific type). */
  readonly patientIdType: string;
  /** Facility code Redox uses for this location, when the EHR needs one. */
  readonly facilityCode?: string;
}

/** Which EHR source serves one practice location. */
export interface LocationSourceBinding {
  readonly practiceId: PracticeId;
  readonly locationId: LocationId;
  readonly ehr: EhrSystem;
  readonly redox: RedoxSourceBinding;
  /** Per-connection corrections to the EHR's matrix row, once verified for this location. */
  readonly capabilityOverrides?: Partial<Record<EhrCapability, CapabilitySupport>>;
}

const key = (practiceId: PracticeId, locationId: LocationId) => `${practiceId}\u0000${locationId}`;

/**
 * Maps (practice, location) to its EHR source. One practice can have locations on different EHRs.
 * Lookups are always by practice and location together, so a location ID never resolves across practices.
 */
export class LocationSourceMap {
  readonly #bindings = new Map<string, LocationSourceBinding>();
  readonly #matrix: CapabilityMatrix;

  constructor(bindings: readonly LocationSourceBinding[] = [], matrix: CapabilityMatrix = PILOT_CAPABILITY_MATRIX) {
    this.#matrix = matrix;
    for (const b of bindings) this.register(b);
  }

  register(binding: LocationSourceBinding): void {
    const k = key(binding.practiceId, binding.locationId);
    if (this.#bindings.has(k)) {
      throw new Error(`Location ${binding.locationId} is already mapped for this practice.`);
    }
    this.#bindings.set(k, binding);
  }

  resolve(ctx: EhrRequestContext): LocationSourceBinding | undefined {
    return this.#bindings.get(key(ctx.practiceId, ctx.locationId));
  }

  /** The location's effective capability profile: matrix row plus per-location overrides. */
  profileFor(binding: LocationSourceBinding): CapabilityProfile {
    return applyOverrides(this.#matrix[binding.ehr], binding.capabilityOverrides);
  }

  /** Locations of one practice, e.g. to show which EHR each uses. */
  locationsOf(practiceId: PracticeId): readonly LocationSourceBinding[] {
    return [...this.#bindings.values()].filter((b) => b.practiceId === practiceId);
  }
}
