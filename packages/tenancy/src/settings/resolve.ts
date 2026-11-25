import { CATEGORY_PRECEDENCE, categoryOf } from './schema';
import type { CaseContext, ResolvedConfig, SettingsLevel } from './schema';

/**
 * Resolve effective settings for a case. Pure: no I/O. Each value carries the level and ID
 * of the record it came from. An `undefined` value means "not overridden" and falls through;
 * `null` is an explicit value and wins.
 */
export function resolveConfig(ctx: CaseContext): ResolvedConfig {
  const keys = new Set<string>();
  for (const level of ['practice', 'location', 'facility', 'surgeon'] as const) {
    for (const key of Object.keys(ctx[level]?.settings ?? {})) keys.add(key);
  }

  const out: ResolvedConfig = {};
  for (const key of [...keys].sort()) {
    const order: readonly SettingsLevel[] = CATEGORY_PRECEDENCE[categoryOf(key)];
    for (const level of order) {
      const layer = ctx[level];
      const value = layer?.settings[key];
      if (layer && value !== undefined) {
        out[key] = { value, source: level, sourceId: layer.id };
        break;
      }
    }
  }
  return out;
}
