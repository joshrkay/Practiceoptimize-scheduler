/** Test helpers: load the synthetic podiatry fixtures and build a transition context. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Actor, Authorization, Case, CaseSeries, IsoDateTime } from './case.js';
import { InMemoryAuditSink } from './fakes.js';
import type { NewCaseInput, TransitionContext, TransitionResult } from './state-machine.js';

export interface CaseFixture {
  description: string;
  practiceId: string;
  series?: CaseSeries;
  cases: NewCaseInput[];
  authorizations: Authorization[];
}

export type CaseFixtureName =
  | 'bunionectomy-staged-series'
  | 'urgent-foot-infection-office'
  | 'bunion-denied-to-self-pay'
  | 'mixed-insured-cosmetic'
  | 'cancelled-then-reopened';

export function loadCaseFixture(name: CaseFixtureName): CaseFixture {
  const path = fileURLToPath(new URL(`../fixtures/cases/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as CaseFixture;
}

export const scheduler: Actor = { kind: 'human', userId: 'user-synthetic-scheduler-01', role: 'scheduler' };
export const agent: Actor = { kind: 'agent', agentId: 'scheduling-agent' };

export function context(now: IsoDateTime, actor: Actor = scheduler) {
  const audit = new InMemoryAuditSink();
  const ctx: TransitionContext = { now, actor, audit };
  return { ctx, audit };
}

/** Unwrap a successful result or throw with the guard's message. */
export function expectOk(result: TransitionResult): Case {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.case;
}

export function firstCase(fixture: CaseFixture, index = 0): NewCaseInput {
  const input = fixture.cases[index];
  if (input === undefined) throw new Error(`Fixture has no case at ${index}`);
  return input;
}

export function firstAuthorization(fixture: CaseFixture): Authorization {
  const auth = fixture.authorizations[0];
  if (auth === undefined) throw new Error('Fixture has no authorization');
  return auth;
}
