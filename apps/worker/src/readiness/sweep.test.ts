import { describe, expect, it } from 'vitest';
import type { TrackedCase, TrackedItem } from '@scheduler/case-model';
import { FakeClock, FakeEscalations, FakeReminders, FakeStore } from './fakes';
import { readSweepConfig, runReadinessSweep, type SweepConfig } from './sweep';

const DAY = 86_400_000;
const NOW = new Date('2026-03-01T12:00:00Z');
const inDays = (n: number) => new Date(NOW.getTime() + n * DAY);
const config: SweepConfig = { enabled: true, cutoffDays: 7, reminderIntervalHours: 24 };

const clearance = (o: Partial<TrackedItem> = {}): TrackedItem => ({
  id: 'clearance',
  label: 'Medical clearance',
  required: true,
  state: 'open',
  owner: 'coordination',
  ...o,
});
const kase = (days: number, items: TrackedItem[], o: Partial<TrackedCase> = {}): TrackedCase => ({
  caseId: 'c1',
  practiceId: 'p1',
  surgeryDate: inDays(days),
  urgentAddOn: false,
  items,
  ...o,
});

function setup(cases: TrackedCase[]) {
  const store = new FakeStore(cases);
  const reminders = new FakeReminders();
  const escalations = new FakeEscalations();
  const clock = new FakeClock(NOW);
  const deps = { store, reminders, escalations, clock };
  return { store, reminders, escalations, clock, run: () => runReadinessSweep(deps, config) };
}

describe('runReadinessSweep', () => {
  it('scenario 1: 9 days out is at risk and coordination is asked to remind', async () => {
    const s = setup([kase(9, [clearance()])]);
    const summary = await s.run();
    expect(s.store.statuses.get('c1')?.status).toBe('at_risk');
    expect(s.reminders.requests).toHaveLength(1);
    expect(s.reminders.requests[0]).toMatchObject({ journey: 'coordination', itemId: 'clearance' });
    expect(s.escalations.items.size).toBe(0);
    expect(summary.remindersRequested).toBe(1);
  });

  it('scenario 2: at 7 days the case is blocked and Today names the clearance', async () => {
    const s = setup([kase(7, [clearance()])]);
    await s.run();
    expect(s.store.statuses.get('c1')?.status).toBe('blocked');
    const [esc] = [...s.escalations.items.values()];
    expect(esc?.title).toContain('Medical clearance');
    expect(esc?.kind).toBe('cutoff');
  });

  it('routes patient-owned items to outreach', async () => {
    const s = setup([kase(9, [clearance({ owner: 'outreach', label: 'Pre-op labs' })])]);
    await s.run();
    expect(s.reminders.requests[0]?.journey).toBe('outreach');
  });

  it('escalates scheduler-owned items at the cutoff and sends no reminder', async () => {
    const s = setup([kase(6, [clearance({ owner: 'scheduler' })])]);
    await s.run();
    expect(s.reminders.requests).toHaveLength(0);
    expect(s.escalations.items.size).toBe(1);
  });

  it('does not escalate scheduler-owned at-risk items before the cutoff', async () => {
    const s = setup([kase(9, [clearance({ owner: 'scheduler' })])]);
    await s.run();
    expect(s.store.statuses.get('c1')?.status).toBe('at_risk');
    expect(s.escalations.items.size).toBe(0);
  });

  it('throttles reminders and dedupes escalations across hourly sweeps', async () => {
    const s = setup([kase(7, [clearance()])]);
    await s.run();
    s.clock.advanceHours(1);
    await s.run();
    expect(s.reminders.requests).toHaveLength(1);
    expect(s.escalations.items.size).toBe(1);
    s.clock.advanceHours(24);
    await s.run();
    expect(s.reminders.requests).toHaveLength(2);
  });

  it('reopens expired items and reminds on them', async () => {
    const s = setup([
      kase(20, [clearance({ id: 'lab', label: '30-day lab', state: 'done', expiresAt: inDays(-1) })]),
    ]);
    const summary = await s.run();
    expect(s.store.reopened).toEqual(['c1:lab']);
    expect(summary.reopened).toBe(1);
    expect(s.store.statuses.get('c1')?.status).toBe('on_track');
  });

  it('reopened expired item past the cutoff is blocked and escalated', async () => {
    const s = setup([kase(5, [clearance({ state: 'done', expiresAt: inDays(-1) })])]);
    await s.run();
    expect(s.store.statuses.get('c1')?.status).toBe('blocked');
    expect(s.escalations.items.size).toBe(1);
  });

  it('sends a flagged result to the surgeon via Today without blocking or reminding', async () => {
    const s = setup([kase(3, [clearance({ state: 'flagged', label: 'A1c' })])]);
    await s.run();
    expect(s.store.statuses.get('c1')?.status).toBe('at_risk');
    expect(s.reminders.requests).toHaveLength(0);
    const [esc] = [...s.escalations.items.values()];
    expect(esc?.kind).toBe('surgeon_decision');
    expect(esc?.title).toContain('A1c');
  });

  it('skips urgent add-ons', async () => {
    const s = setup([kase(1, [clearance()], { urgentAddOn: true })]);
    const summary = await s.run();
    expect(summary.casesChecked).toBe(0);
    expect(s.store.statuses.size).toBe(0);
    expect(s.reminders.requests).toHaveLength(0);
  });

  it('does nothing when the feature is off', async () => {
    const s = setup([kase(7, [clearance()])]);
    const summary = await runReadinessSweep(
      { store: s.store, reminders: s.reminders, escalations: s.escalations, clock: s.clock },
      { ...config, enabled: false },
    );
    expect(summary.skipped).toBe(true);
    expect(s.store.statuses.size).toBe(0);
  });

  it('isolates a failing case and reports it', async () => {
    const bad = kase(20, [clearance({ state: 'done', expiresAt: inDays(-1) })], { caseId: 'bad' });
    const good = kase(7, [clearance()], { caseId: 'good' });
    const s = setup([bad, good]);
    s.store.failFor = 'bad';
    const summary = await s.run();
    expect(summary.errors).toEqual([{ caseId: 'bad', message: 'store down' }]);
    expect(s.store.statuses.get('good')?.status).toBe('blocked');
  });

  it('reports a non-Error failure', async () => {
    const s = setup([kase(7, [clearance()])]);
    s.reminders.requestReminder = () => Promise.reject('boom');
    const summary = await s.run();
    expect(summary.errors[0]?.message).toBe('boom');
  });

  it('ready case produces no reminders or escalations', async () => {
    const s = setup([kase(2, [clearance({ state: 'done' })])]);
    await s.run();
    expect(s.store.statuses.get('c1')?.status).toBe('ready');
    expect(s.reminders.requests).toHaveLength(0);
    expect(s.escalations.items.size).toBe(0);
  });
});

describe('readSweepConfig', () => {
  it('defaults to off with a 7 day cutoff', () => {
    expect(readSweepConfig({})).toMatchObject({ enabled: false, cutoffDays: 7 });
  });
  it('reads the environment', () => {
    expect(
      readSweepConfig({ FEATURE_READINESS_TRACKING: 'true', READINESS_CUTOFF_DAYS: '5' }),
    ).toMatchObject({ enabled: true, cutoffDays: 5 });
  });
  it('falls back on an invalid cutoff', () => {
    expect(readSweepConfig({ READINESS_CUTOFF_DAYS: 'abc' }).cutoffDays).toBe(7);
  });
});
