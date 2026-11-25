export const DEFAULT_URGENT_CONFIRM_TIMEOUT_MINUTES = 15;
export const DEFAULT_OFFERED_SLOT_COUNT = 3;

export interface UrgentAddOnConfig {
  /** `FEATURE_URGENT_ADD_ONS`; defaults to false. */
  readonly enabled: boolean;
  /** `URGENT_CONFIRM_TIMEOUT_MINUTES`; defaults to 15. */
  readonly confirmTimeoutMinutes: number;
  /** How many next open slots to offer when the procedure room is full. */
  readonly offeredSlotCount: number;
}

/** Reads the urgent add-on settings from environment-style values. Invalid timeouts fall back to 15. */
export function loadUrgentAddOnConfig(env: Readonly<Record<string, string | undefined>>): UrgentAddOnConfig {
  const raw = env['URGENT_CONFIRM_TIMEOUT_MINUTES'];
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  const confirmTimeoutMinutes =
    Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_URGENT_CONFIRM_TIMEOUT_MINUTES;
  return {
    enabled: env['FEATURE_URGENT_ADD_ONS'] === 'true',
    confirmTimeoutMinutes,
    offeredSlotCount: DEFAULT_OFFERED_SLOT_COUNT,
  };
}
