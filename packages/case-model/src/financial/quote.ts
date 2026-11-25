import { splitCaseByCoverage } from './mixed-case.js';
import type { CaseProcedure, Cents, HumanActor } from './types.js';

export interface QuoteLine {
  readonly procedureId: string;
  readonly description: string;
  readonly amountCents: Cents;
}

/** A quote as priced by staff or the surgeon. */
export interface Quote {
  readonly quoteId: string;
  readonly practiceId: string;
  readonly caseId: string;
  readonly lines: readonly QuoteLine[];
  readonly totalCents: Cents;
  readonly depositCents: Cents;
  readonly expiresAt: Date;
  readonly enteredBy: HumanActor;
  readonly enteredAt: Date;
}

/**
 * Input to create a quote. `actor` is typed as HumanActor, so the agent cannot price:
 * passing an agent actor is a compile error, and createQuote also rejects it at runtime.
 * The total is derived from the lines; the deposit amount is always supplied by the human.
 */
export interface CreateQuoteInput {
  readonly quoteId: string;
  readonly practiceId: string;
  readonly caseId: string;
  readonly actor: HumanActor;
  readonly procedures: readonly CaseProcedure[];
  readonly lines: readonly QuoteLine[];
  readonly depositCents: Cents;
  readonly expiresAt: Date;
  readonly now: Date;
}

export class QuoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuoteError';
  }
}

const isCents = (n: number) => Number.isInteger(n) && n >= 0;

export function createQuote(input: CreateQuoteInput): Quote {
  // Runtime guard for untyped callers; the type already forbids the agent.
  const kind: string = input.actor.kind;
  if (kind !== 'staff' && kind !== 'surgeon') {
    throw new QuoteError('Only staff or the surgeon may enter a quote');
  }
  if (input.lines.length === 0) throw new QuoteError('A quote needs at least one line');
  const selfPay = new Set(splitCaseByCoverage(input.procedures).quoteProcedureIds);
  const seen = new Set<string>();
  for (const line of input.lines) {
    if (!isCents(line.amountCents)) throw new QuoteError(`Line ${line.procedureId} has an invalid amount`);
    if (!selfPay.has(line.procedureId)) {
      throw new QuoteError(`Line ${line.procedureId} is not a self-pay procedure on this case`);
    }
    if (seen.has(line.procedureId)) throw new QuoteError(`Duplicate quote line for ${line.procedureId}`);
    seen.add(line.procedureId);
  }
  const totalCents = input.lines.reduce((sum, l) => sum + l.amountCents, 0);
  if (!isCents(input.depositCents) || input.depositCents > totalCents) {
    throw new QuoteError('Deposit must be between 0 and the quote total');
  }
  if (input.expiresAt.getTime() <= input.now.getTime()) throw new QuoteError('Quote expiry must be in the future');
  return {
    quoteId: input.quoteId,
    practiceId: input.practiceId,
    caseId: input.caseId,
    lines: input.lines.map((l) => ({ ...l })),
    totalCents,
    depositCents: input.depositCents,
    expiresAt: input.expiresAt,
    enteredBy: input.actor,
    enteredAt: input.now,
  };
}

export function isQuoteExpired(quote: Quote, now: Date): boolean {
  return now.getTime() >= quote.expiresAt.getTime();
}
