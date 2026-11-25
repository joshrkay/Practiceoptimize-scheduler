/** Loads the synthetic podiatry fixture as a fresh, mutable copy for each test. */
import raw from './fixtures/blocks-and-cases.json';
import type { SchedulingFixture } from './fakes.js';
import type { SchedulingCase } from './types.js';

export function loadFixture(): SchedulingFixture {
  return structuredClone(raw) as unknown as SchedulingFixture;
}

export function caseFrom(fixture: SchedulingFixture, caseId: string): SchedulingCase {
  const c = fixture.cases[caseId];
  if (!c) throw new Error(`No fixture case ${caseId}`);
  return c;
}
