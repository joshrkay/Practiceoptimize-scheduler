import { describe, expect, it } from 'vitest';
import { createFakeWorld } from './fakes.js';
import {
  isPastRetention,
  resolveRetentionDays,
  runPhiRetention,
  runPracticeRetention,
} from './phi-retention.js';
import type { CaseStatus, CaseSummary } from './ports.js';

const NOW = new Date('2026-11-25T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

function mk(
  caseId: string,
  status: CaseStatus,
  ageDays: number | null,
  seriesId: string | null = null,
  practiceId = 'practice-a',
): CaseSummary {
  return {
    caseId,
    practiceId,
    seriesId,
    status,
    endedAt: ageDays === null ? null : daysAgo(ageDays),
    phiDeleted: false,
  };
}

describe('resolveRetentionDays', () => {
  it('defaults to 90, parses a value, rejects invalid values', () => {
    expect(resolveRetentionDays(undefined)).toBe(90);
    expect(resolveRetentionDays('')).toBe(90);
    expect(resolveRetentionDays('30')).toBe(30);
    expect(() => resolveRetentionDays('0')).toThrow();
    expect(() => resolveRetentionDays('abc')).toThrow();
    expect(() => resolveRetentionDays('1.5')).toThrow();
  });
  it('reads the environment by default', () => {
    expect(resolveRetentionDays()).toBe(90);
  });
});

describe('isPastRetention', () => {
  it('is true at exactly 90 days, false at 89, false while open', () => {
    expect(isPastRetention(mk('c', 'closed', 90), NOW, 90)).toBe(true);
    expect(isPastRetention(mk('c', 'closed', 89), NOW, 90)).toBe(false);
    expect(isPastRetention(mk('c', 'open', null), NOW, 90)).toBe(false);
    expect(isPastRetention(mk('c', 'cancelled', 91), NOW, 90)).toBe(true);
  });
});

describe('runPracticeRetention', () => {
  it('scenario 1: deletes a case closed 91 days ago after snapshotting, with an audit event and no PHI in it', async () => {
    const w = createFakeWorld([mk('case-1', 'closed', 91)], NOW);
    const order: string[] = [];
    const snap = w.ports.snapshotter.snapshotCaseMetrics;
    const del = w.ports.deleter.deleteCasePhi;
    w.ports.snapshotter.snapshotCaseMetrics = async (...a) => {
      order.push('snapshot');
      return snap(...a);
    };
    w.ports.deleter.deleteCasePhi = async (...a) => {
      order.push('delete');
      return del(...a);
    };
    const r = await runPracticeRetention('practice-a', w.ports, 90);
    expect(order).toEqual(['snapshot', 'delete']);
    expect(w.snapshots).toEqual(['case-1']);
    expect(w.deletedCases).toEqual(['case-1']);
    expect(r.casesDeleted).toBe(1);
    expect(r.recordsDeleted).toBe(5);
    expect(w.auditEvents).toEqual([
      { action: 'retention.case_phi_deleted', caseId: 'case-1', seriesId: undefined },
    ]);
  });

  it('keeps cases closed fewer than 90 days and open cases', async () => {
    const w = createFakeWorld([mk('a', 'closed', 30), mk('b', 'open', null)], NOW);
    const r = await runPracticeRetention('practice-a', w.ports, 90);
    expect(w.deletedCases).toEqual([]);
    expect(r.casesDeleted).toBe(0);
  });

  it('deletes cancelled cases not reopened for 90 days, keeps reopened ones', async () => {
    const w = createFakeWorld([mk('cancelled-old', 'cancelled', 100), mk('reopened', 'open', null)], NOW);
    await runPracticeRetention('practice-a', w.ports, 90);
    expect(w.deletedCases).toEqual(['cancelled-old']);
  });

  it('scenario 2: deletes the left case own data but keeps shared series data while the right case is open', async () => {
    const w = createFakeWorld(
      [mk('left-foot', 'closed', 91, 'series-1'), mk('right-foot', 'open', null, 'series-1')],
      NOW,
    );
    const r = await runPracticeRetention('practice-a', w.ports, 90);
    expect(w.deletedCases).toEqual(['left-foot']);
    expect(w.deletedSeries).toEqual([]);
    expect(r.seriesKeptOpen).toBe(1);
    expect(r.seriesSharedDeleted).toBe(0);
  });

  it('deletes series data once every case is past retention, and each case follows its own clock', async () => {
    const w = createFakeWorld(
      [mk('left', 'closed', 200, 'series-1'), mk('right', 'closed', 91, 'series-1')],
      NOW,
    );
    const r = await runPracticeRetention('practice-a', w.ports, 90);
    expect(w.deletedCases.sort()).toEqual(['left', 'right']);
    expect(w.deletedSeries).toEqual(['series-1']);
    expect(r.seriesSharedDeleted).toBe(1);
    expect(r.recordsDeleted).toBe(13);
  });

  it('keeps series data until 90 days after the LAST case closes', async () => {
    const w = createFakeWorld(
      [mk('left', 'closed', 200, 'series-1'), mk('right', 'closed', 10, 'series-1')],
      NOW,
    );
    await runPracticeRetention('practice-a', w.ports, 90);
    expect(w.deletedCases).toEqual(['left']);
    expect(w.deletedSeries).toEqual([]);
  });

  it('does not report a series with no case past retention as kept open', async () => {
    const w = createFakeWorld([mk('a', 'closed', 5, 's'), mk('b', 'open', null, 's')], NOW);
    const r = await runPracticeRetention('practice-a', w.ports, 90);
    expect(r.seriesKeptOpen).toBe(0);
  });

  it('never deletes a case with pending write-back, flags it, and audits the block', async () => {
    const w = createFakeWorld([mk('held', 'closed', 120), mk('ok', 'closed', 120)], NOW);
    w.pendingWriteBack.add('held');
    const r = await runPracticeRetention('practice-a', w.ports, 90);
    expect(w.deletedCases).toEqual(['ok']);
    expect(w.snapshots).toEqual(['ok']);
    expect(w.flagged).toEqual([{ practiceId: 'practice-a', caseIds: ['held'] }]);
    expect(r.heldForPendingWriteBack).toBe(1);
    expect(w.auditEvents.map((e) => e.action)).toContain('retention.deletion_blocked_write_back');
  });

  it('holds series shared data when any series case has pending write-back', async () => {
    const w = createFakeWorld(
      [mk('left', 'closed', 120, 'series-1'), mk('right', 'closed', 120, 'series-1')],
      NOW,
    );
    w.pendingWriteBack.add('right');
    const r = await runPracticeRetention('practice-a', w.ports, 90);
    expect(w.deletedCases).toEqual(['left']);
    expect(w.deletedSeries).toEqual([]);
    expect(r.heldForPendingWriteBack).toBe(1);
    expect(w.flagged[0]?.caseIds).toEqual(['right']);
  });

  it('does not delete when the metrics snapshot fails', async () => {
    const w = createFakeWorld([mk('c', 'closed', 100)], NOW);
    w.failSnapshotFor.add('c');
    const r = await runPracticeRetention('practice-a', w.ports, 90);
    expect(w.deletedCases).toEqual([]);
    expect(r.failures).toBe(1);
    expect(w.auditEvents).toEqual([]);
  });

  it('counts a delete failure and keeps going', async () => {
    const w = createFakeWorld([mk('bad', 'closed', 100), mk('good', 'closed', 100)], NOW);
    w.failDeleteFor.add('bad');
    const r = await runPracticeRetention('practice-a', w.ports, 90);
    expect(w.deletedCases).toEqual(['good']);
    expect(r.failures).toBe(1);
    expect(r.casesDeleted).toBe(1);
  });

  it('counts a series delete failure', async () => {
    const w = createFakeWorld([mk('a', 'closed', 100, 's')], NOW);
    w.ports.deleter.deleteSeriesSharedPhi = async () => {
      throw new Error('boom');
    };
    const r = await runPracticeRetention('practice-a', w.ports, 90);
    expect(r.failures).toBe(1);
  });

  it('is idempotent: a second run deletes and audits nothing more', async () => {
    const w = createFakeWorld(
      [mk('l', 'closed', 100, 's'), mk('r', 'closed', 100, 's'), mk('solo', 'closed', 100)],
      NOW,
    );
    await runPracticeRetention('practice-a', w.ports, 90);
    const auditCount = w.auditEvents.length;
    const second = await runPracticeRetention('practice-a', w.ports, 90);
    expect(second.casesDeleted).toBe(0);
    expect(second.seriesSharedDeleted).toBe(0);
    expect(second.recordsDeleted).toBe(0);
    expect(w.auditEvents.length).toBe(auditCount);
    expect(w.snapshots.length).toBe(3);
  });
});

describe('runPhiRetention', () => {
  it('produces one counts-only report per practice, delivered to the notifier', async () => {
    const w = createFakeWorld(
      [mk('a1', 'closed', 100, null, 'practice-a'), mk('b1', 'closed', 100, null, 'practice-b')],
      NOW,
    );
    const reports = await runPhiRetention(w.ports, 90);
    expect(reports.map((r) => r.practiceId)).toEqual(['practice-a', 'practice-b']);
    expect(w.reports).toEqual(reports);
    for (const r of reports) {
      for (const v of Object.values(r)) expect(['string', 'number']).toContain(typeof v);
      expect(JSON.stringify(r)).not.toMatch(/a1|b1/);
      expect(r.casesDeleted).toBe(1);
    }
  });

  it('uses the configured default retention days', async () => {
    const w = createFakeWorld([mk('a', 'closed', 100)], NOW);
    const [r] = await runPhiRetention(w.ports);
    expect(r?.retentionDays).toBe(90);
  });
});
