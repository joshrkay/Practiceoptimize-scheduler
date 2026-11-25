/**
 * Dry-run (shadow) mode. When on, write tools return the effect they would have had instead of acting;
 * read tools still run so the agent can plan against real data.
 */

export const TOOL_DRY_RUN_FLAG = 'FEATURE_TOOL_DRY_RUN';

/** Feature flags default to off: only the exact string `true` enables dry-run. */
export function isToolDryRunEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env[TOOL_DRY_RUN_FLAG] === 'true';
}

/** What a write tool would do. Returned to the caller in dry-run mode in place of executing. */
export interface IntendedEffect {
  /** One line, e.g. "Set case case-0001 status to scheduled". */
  readonly summary: string;
  readonly details?: Readonly<Record<string, unknown>>;
}
