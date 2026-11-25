/** Shared types for the self-pay and mixed-case financial flow. Money is integer US cents. */

export type Cents = number;

/** Who may price a quote. The agent is deliberately not part of this union. */
export type HumanActor =
  | { readonly kind: 'staff'; readonly userId: string }
  | { readonly kind: 'surgeon'; readonly userId: string };

export type AgentActor = { readonly kind: 'agent'; readonly agentId: string };
export type Actor = HumanActor | AgentActor;

export type ProcedureCoverage = 'insured' | 'self_pay';

export interface CaseProcedure {
  readonly procedureId: string;
  readonly description: string;
  readonly coverage: ProcedureCoverage;
}

/**
 * When the deposit is required.
 * - before_booked: the case cannot reach Booked until the deposit is confirmed (default for self-pay).
 * - readiness_item: the deposit is a readiness item due before surgery; booking is not held.
 */
export type DepositTiming = 'before_booked' | 'readiness_item';

export const DEFAULT_DEPOSIT_TIMING: DepositTiming = 'before_booked';
