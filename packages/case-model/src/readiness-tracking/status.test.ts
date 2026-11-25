import { describe, expect, it } from 'vitest';
import { computeCaseReadiness, daysUntil } from './status';
import type { TrackedCase, TrackedItem } from './ports';

const DAY = 86_400_000;
const NOW = new Date('2026-03-01T12:00:00Z');
const inDays = (n: number) => new Date(NOW.getTime() + n * DAY);

const item = (o: Partial<TrackedItem> = {}): TrackedItem => ({
  id: 'i1',
  label: 'Medical clearance',
  required: true,
  state: 'open',
  owner: 'coordination',
  ...o,
});
const kase = (days: number, items: TrackedItem[], urgentAddOn = false): TrackedCase => ({
  caseId: 'c1',
  practiceId: 'p1',
  surgeryDate: inDays(days),
  urgentAddOn,
  items,
});

describe('computeCaseReadiness', () => {
  it('is at risk 9 days out with a clearance open', () => {
    const r = computeCaseReadiness(kase(9, [item()]), NOW);
    expect(r.status).toBe('at_risk');
    expect(r.findings[0]?.reason).toBe('due_soon');
  });

  it('is blocked at the 7 day cutoff', () => {
    const r = computeCaseReadiness(kase(7, [item()]), NOW);
    expect(r.status).toBe('blocked');
    expect(r.findings[0]).toMatchObject({ label: 'Medical clearance', reason: 'past_cutoff' });
  });

  it('is on track when an item is open but far from its window', () => {
    expect(computeCaseReadiness(kase(30, [item()]), NOW).status).toBe('on_track');
  });

  it('is ready when all required items are done; optional items are ignored', () => {
    const items = [item({ state: 'done' }), item({ id: 'i2', required: false })];
    expect(computeCaseReadiness(kase(2, items), NOW).status).toBe('ready');
  });

  it('is at risk when overdue on an agent-owned request before the cutoff', () => {
    const r = computeCaseReadiness(kase(20, [item({ dueAt: inDays(-1) })]), NOW);
    expect(r.findings[0]?.reason).toBe('overdue');
    expect(r.status).toBe('at_risk');
  });

  it('honors a custom warning window and due date', () => {
    const early = item({ dueAt: inDays(12), warningWindowDays: 1 });
    expect(computeCaseReadiness(kase(30, [early]), NOW).status).toBe('on_track');
    const inside = item({ dueAt: inDays(12), warningWindowDays: 14 });
    expect(computeCaseReadiness(kase(30, [inside]), NOW).status).toBe('at_risk');
  });

  it('treats an expired done item as blocked', () => {
    const r = computeCaseReadiness(kase(20, [item({ state: 'done', expiresAt: inDays(-1) })]), NOW);
    expect(r.status).toBe('blocked');
    expect(r.findings[0]?.reason).toBe('expired');
  });

  it('keeps a done item with a future expiry valid', () => {
    const r = computeCaseReadiness(kase(2, [item({ state: 'done', expiresAt: inDays(5) })]), NOW);
    expect(r.status).toBe('ready');
  });

  it('flagged result is at risk awaiting the surgeon, never blocked or ready, even past cutoff', () => {
    for (const days of [20, 3]) {
      const r = computeCaseReadiness(kase(days, [item({ state: 'flagged', label: 'A1c' })]), NOW);
      expect(r.status).toBe('at_risk');
      expect(r.findings[0]?.reason).toBe('awaiting_surgeon_decision');
    }
  });

  it('does not track urgent add-ons', () => {
    const r = computeCaseReadiness(kase(1, [item()], true), NOW);
    expect(r).toMatchObject({ status: 'not_tracked', findings: [] });
  });

  it('uses a configurable cutoff', () => {
    expect(computeCaseReadiness(kase(9, [item()]), NOW, { cutoffDays: 10 }).status).toBe('blocked');
  });

  it('daysUntil floors whole days', () => {
    expect(daysUntil(new Date(NOW.getTime() + 7.5 * DAY), NOW)).toBe(7);
  });
});
