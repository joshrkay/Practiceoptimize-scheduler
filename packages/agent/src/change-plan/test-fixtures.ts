/** Loads the synthetic podiatry fixtures in `./fixtures` into a fresh fake world. Test use only. */
import { readFileSync } from 'node:fs';
import { FakeCascadeWorld } from './fakes.js';
import type { CaseSnapshot, ChangeRequest, Slot } from './model.js';

export type FixtureName =
  | 'date-move-outside-auth'
  | 'site-change'
  | 'surgeon-out-sick'
  | 'cancellation'
  | 'series-move';

export interface ChangeFixture {
  readonly description: string;
  readonly practiceId: string;
  readonly now: string;
  readonly cases: readonly CaseSnapshot[];
  readonly slots: readonly Slot[];
  readonly change: ChangeRequest;
}

export function loadFixture(name: FixtureName): { fixture: ChangeFixture; world: FakeCascadeWorld } {
  const raw = readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
  const fixture = JSON.parse(raw) as ChangeFixture;
  const world = new FakeCascadeWorld(fixture.cases, fixture.slots);
  world.nowIso = fixture.now;
  return { fixture, world };
}
