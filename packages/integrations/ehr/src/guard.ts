import { EHR_CAPABILITIES, unsupported, type EhrCapability } from './capabilities.js';
import type { LocationCapabilities } from './connector.js';
import type { LocationSourceBinding, LocationSourceMap } from './locations.js';
import { ehrError, ok, type EhrResult } from './result.js';
import type { EhrRequestContext } from './types.js';

export interface GuardOptions {
  /**
   * Capabilities this implementation has built and verified. A capability the EHR supports but the
   * implementation lacks is reported as `connector_pending_verification`. Omit when all are built.
   */
  readonly implemented?: ReadonlySet<EhrCapability>;
  readonly subject?: { readonly patientId?: string };
}

/**
 * Shared front door for every connector call: resolve the location for this practice, check the
 * capability, then run. Unexpected exceptions become a generic, PHI-free `upstream_error`.
 */
export async function withCapability<T>(
  sources: LocationSourceMap,
  ctx: EhrRequestContext,
  capability: EhrCapability,
  run: (binding: LocationSourceBinding) => Promise<EhrResult<T>>,
  options: GuardOptions = {},
): Promise<EhrResult<T>> {
  const binding = sources.resolve(ctx);
  if (!binding) return ehrError('location_not_mapped', 'No EHR source is mapped for this location.');
  if (sources.profileFor(binding)[capability] !== 'supported') {
    return unsupported(ctx, binding.ehr, capability, 'ehr_does_not_support', options.subject);
  }
  if (options.implemented && !options.implemented.has(capability)) {
    return unsupported(ctx, binding.ehr, capability, 'connector_pending_verification', options.subject);
  }
  try {
    return await run(binding);
  } catch {
    return ehrError('upstream_error', `The EHR call for "${capability}" failed unexpectedly.`, true);
  }
}

export function locationCapabilities(
  sources: LocationSourceMap,
  ctx: EhrRequestContext,
  implemented?: ReadonlySet<EhrCapability>,
): EhrResult<LocationCapabilities> {
  const binding = sources.resolve(ctx);
  if (!binding) return ehrError('location_not_mapped', 'No EHR source is mapped for this location.');
  const profile = sources.profileFor(binding);
  const supported = new Set(
    EHR_CAPABILITIES.filter((c) => profile[c] === 'supported' && (!implemented || implemented.has(c))),
  );
  return ok({ ehr: binding.ehr, supported });
}
