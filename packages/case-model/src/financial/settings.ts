import { DEFAULT_DEPOSIT_TIMING, type DepositTiming } from './types.js';

/** Practice setting for deposit timing. Fragment to be merged into the tenancy config schema at integration. */
export interface FinancialPracticeSettings {
  readonly depositTiming?: DepositTiming;
}

export function resolveDepositTiming(settings: FinancialPracticeSettings | undefined): DepositTiming {
  return settings?.depositTiming ?? DEFAULT_DEPOSIT_TIMING;
}
