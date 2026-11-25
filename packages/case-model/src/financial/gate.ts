import type { FlowState } from './flow.js';
import type { DepositTiming } from './types.js';

export interface GateInput {
  readonly timing: DepositTiming;
  readonly flow: FlowState;
  /** True when a surgeon's signed urgent order approves this add-on (ADR-0007). */
  readonly urgentAddOn?: boolean;
}

export type GateReason =
  | 'deposit_confirmed'
  | 'deposit_due_before_surgery'
  | 'urgent_add_on_not_held'
  | 'deposit_not_confirmed';

export interface GateDecision {
  readonly canBook: boolean;
  readonly reason: GateReason;
}

/** Guard consulted by the case state machine before a self-pay or mixed case moves to Booked. */
export function evaluateDepositGate(input: GateInput): GateDecision {
  if (input.flow.status === 'deposit_confirmed') return { canBook: true, reason: 'deposit_confirmed' };
  // ADR-0007: an urgent add-on is never held back by the deposit; the deposit stays tracked.
  if (input.urgentAddOn === true) return { canBook: true, reason: 'urgent_add_on_not_held' };
  if (input.timing === 'readiness_item') return { canBook: true, reason: 'deposit_due_before_surgery' };
  return { canBook: false, reason: 'deposit_not_confirmed' };
}

export interface DepositReadinessItem {
  readonly key: 'deposit';
  readonly dueBefore: 'surgery';
  readonly satisfied: boolean;
}

/** Readiness item for practices that set deposit timing to readiness_item; null under before_booked. */
export function depositReadinessItem(timing: DepositTiming, flow: FlowState): DepositReadinessItem | null {
  if (timing !== 'readiness_item') return null;
  return { key: 'deposit', dueBefore: 'surgery', satisfied: flow.status === 'deposit_confirmed' };
}
