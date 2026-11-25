/** Builds a coordinator wired to in-memory fakes from the synthetic podiatry fixture. Test support only. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CareTeamCoordinator } from './coordinator.js';
import type { CoordinationConfig } from './escalation.js';
import {
  FakeApprovalPolicy,
  FakeClock,
  InMemoryCaseReader,
  InMemoryCoordinationRequestStore,
  InMemoryDirectory,
  InMemoryReviewQueue,
  InMemoryTaskQueue,
  RecordingRiskSignal,
  RecordingSender,
  SequentialIds,
} from './fakes.js';
import type { CaseSnapshot } from './journey.js';
import { PODIATRY_JOURNEY } from './journey.js';
import type { PartyContact } from './ports.js';

export interface JourneyFixture {
  startAt: string;
  case: CaseSnapshot & { procedure: string };
  otherPracticeId: string;
  parties: (PartyContact & { name: string })[];
  expected: {
    scheduledStage: { steps: string[]; sentImmediately: string[]; heldForApproval: string[] };
    newSurgeryDate: string;
  };
}

export function loadJourneyFixture(): JourneyFixture {
  const path = fileURLToPath(
    new URL('../../../../tests/fixtures/coordination/journey-podiatry-asc.json', import.meta.url),
  );
  return JSON.parse(readFileSync(path, 'utf8')) as JourneyFixture;
}

export function buildHarness(options: { config?: Partial<CoordinationConfig>; policyApproveFirst?: string[] } = {}) {
  const fixture = loadJourneyFixture();
  const clock = new FakeClock(fixture.startAt);
  const cases = new InMemoryCaseReader();
  cases.put(fixture.case);
  const directory = new InMemoryDirectory();
  for (const party of fixture.parties) {
    directory.put(fixture.case.practiceId, fixture.case.caseId, {
      partyId: party.partyId,
      role: party.role,
      preferredChannel: party.preferredChannel,
    });
  }
  const sender = new RecordingSender();
  const policy = new FakeApprovalPolicy(new Set(options.policyApproveFirst ?? []));
  const reviewQueue = new InMemoryReviewQueue();
  const tasks = new InMemoryTaskQueue();
  const risk = new RecordingRiskSignal();
  const store = new InMemoryCoordinationRequestStore();
  const config: CoordinationConfig = { enabled: true, remind1Hours: 48, remind2Hours: 96, ...options.config };
  const coordinator = new CareTeamCoordinator({
    config,
    journey: PODIATRY_JOURNEY,
    clock,
    ids: new SequentialIds(),
    cases,
    directory,
    sender,
    policy,
    reviewQueue,
    tasks,
    risk,
    store,
  });
  return { fixture, clock, cases, directory, sender, policy, reviewQueue, tasks, risk, store, coordinator };
}
