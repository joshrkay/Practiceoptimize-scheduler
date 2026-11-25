import { describe, expect, it } from 'vitest';
import {
  addDays,
  bookPostOpVisit,
  cancelPostOpVisit,
  makeFakeDeps,
  reschedulePostOpVisit,
  type OpenSlot,
  type PostOpCase,
} from './index.js';

// Synthetic podiatry fixtures: Dr. Example (surgeon), office procedure room follow-up clinic.
const P = 'practice-podiatry-1';
const SURGEON = 'surgeon-bunionectomy-1';
const ASSISTANT = 'assistant-pa-1';
const CLINIC = 'loc-foot-clinic-east';

const slot = (id: string, date: string, providerId = SURGEON, locationId = CLINIC): OpenSlot => ({
  slotId: id,
  providerId,
  locationId,
  startsAt: `${date}T09:30:00-05:00`,
});

const baseCase = (over: Partial<PostOpCase> = {}): PostOpCase => ({
  practiceId: P,
  caseId: 'case-hallux-valgus-1',
  surgeonId: SURGEON,
  assistantId: ASSISTANT,
  followUpLocationId: CLINIC,
  surgeryDate: '2026-03-02',
  ...over,
});

describe('bookPostOpVisit', () => {
  it('books a slot 12 days out at the follow-up location (scenario 1)', async () => {
    const f = makeFakeDeps([slot('s9', '2026-03-09'), slot('s12', '2026-03-14'), slot('s20', '2026-03-22')]);
    const out = await bookPostOpVisit(f.deps, baseCase());
    expect(out.status).toBe('booked');
    if (out.status !== 'booked') return;
    expect(out.visit.startsAt.startsWith('2026-03-14')).toBe(true);
    expect(out.visit.offsetDays).toBe(12);
    expect(out.visit.locationId).toBe(CLINIC);
    expect(f.connector.appointments.size).toBe(1);
    expect(f.audit.events.map((e) => e.action)).toEqual(['post_op_booked']);
  });

  it('accepts the assistant and ignores other locations and providers', async () => {
    const f = makeFakeDeps([
      slot('wrong-loc', '2026-03-14', SURGEON, 'loc-other'),
      slot('other-doc', '2026-03-14', 'surgeon-other'),
      slot('pa', '2026-03-13', ASSISTANT),
    ]);
    const out = await bookPostOpVisit(f.deps, baseCase());
    expect(out.status === 'booked' && out.visit.providerId).toBe(ASSISTANT);
  });

  it('uses the resolved surgeon window instead of the default', async () => {
    const f = makeFakeDeps([slot('s12', '2026-03-14'), slot('s8', '2026-03-10')]);
    f.settings.window = { minDays: 7, maxDays: 9 };
    const out = await bookPostOpVisit(f.deps, baseCase());
    expect(out.status === 'booked' && out.visit.offsetDays).toBe(8);
  });

  it('creates a scheduler task and no appointment when no slot is in the window (scenario 2)', async () => {
    const f = makeFakeDeps([slot('early', '2026-03-05'), slot('late', '2026-03-25')]);
    const out = await bookPostOpVisit(f.deps, baseCase());
    expect(out).toEqual({ status: 'task_created', reason: 'no_slot' });
    expect(f.connector.appointments.size).toBe(0);
    expect(f.connector.bookCalls).toBe(0);
    expect(f.tasks.tasks).toHaveLength(1);
    expect(f.tasks.tasks[0]).toMatchObject({ target: 'scheduler', kind: 'post_op_no_slot' });
    expect(f.tasks.tasks[0]!.reason).toContain('10-14 days');
  });

  it('is idempotent: a second call returns the existing visit', async () => {
    const f = makeFakeDeps([slot('a', '2026-03-14'), slot('b', '2026-03-13')]);
    const first = await bookPostOpVisit(f.deps, baseCase());
    const second = await bookPostOpVisit(f.deps, baseCase());
    expect(second.status === 'booked' && second.existing).toBe(true);
    expect(second.status === 'booked' && first.status === 'booked' && second.visit).toEqual(
      first.status === 'booked' ? first.visit : undefined,
    );
    expect(f.connector.appointments.size).toBe(1);
  });

  it('does not double-book on concurrent calls', async () => {
    const f = makeFakeDeps([slot('a', '2026-03-14'), slot('b', '2026-03-13')]);
    await Promise.all([bookPostOpVisit(f.deps, baseCase()), bookPostOpVisit(f.deps, baseCase())]);
    expect(f.connector.appointments.size).toBe(1);
    expect(f.connector.bookCalls).toBe(1);
  });

  it('falls through to the next slot when one is taken between search and booking', async () => {
    const f = makeFakeDeps([slot('a', '2026-03-14'), slot('b', '2026-03-13')]);
    const realBook = f.connector.bookAppointment.bind(f.connector);
    let first = true;
    f.connector.bookAppointment = (req) => {
      if (first) {
        first = false;
        f.connector.openSlots = f.connector.openSlots.filter((s) => s.slotId !== req.slot.slotId);
      }
      return realBook(req);
    };
    const out = await bookPostOpVisit(f.deps, baseCase());
    expect(out.status === 'booked' && out.visit.startsAt.startsWith('2026-03-13')).toBe(true);
  });

  it('creates a scheduler task when every candidate is taken', async () => {
    const f = makeFakeDeps([slot('a', '2026-03-14')]);
    f.connector.bookAppointment = () => Promise.resolve({ kind: 'slot_taken' });
    const out = await bookPostOpVisit(f.deps, baseCase());
    expect(out).toEqual({ status: 'task_created', reason: 'no_slot' });
  });

  it('books urgent add-ons and each case in a series separately', async () => {
    const f = makeFakeDeps([slot('a', '2026-03-14'), slot('b', '2026-03-13'), slot('c', '2026-03-12')]);
    const a = await bookPostOpVisit(f.deps, baseCase({ caseId: 'series-1-left', urgent: true }));
    const b = await bookPostOpVisit(f.deps, baseCase({ caseId: 'series-1-right' }));
    expect(a.status).toBe('booked');
    expect(b.status).toBe('booked');
    expect(f.connector.appointments.size).toBe(2);
    if (a.status === 'booked' && b.status === 'booked') {
      expect(a.visit.appointmentId).not.toBe(b.visit.appointmentId);
    }
  });

  it('raises a workspace task when the EHR reports appointments unsupported', async () => {
    const f = makeFakeDeps([slot('a', '2026-03-14')]);
    f.connector.unsupported = true;
    const out = await bookPostOpVisit(f.deps, baseCase());
    expect(out).toEqual({ status: 'task_created', reason: 'unsupported' });
    expect(f.tasks.tasks[0]).toMatchObject({ target: 'workspace', kind: 'post_op_appointments_unsupported' });
  });

  it('raises a workspace task when booking itself reports unsupported', async () => {
    const f = makeFakeDeps([slot('a', '2026-03-14')]);
    f.connector.bookAppointment = () => Promise.resolve({ kind: 'unsupported', ehr: 'fake-ehr' });
    const out = await bookPostOpVisit(f.deps, baseCase());
    expect(out).toEqual({ status: 'task_created', reason: 'unsupported' });
    expect(f.tasks.tasks[0]!.target).toBe('workspace');
  });

  it('asks for approval instead of booking when policy is approve-first', async () => {
    const f = makeFakeDeps([slot('a', '2026-03-14')]);
    f.policy.decision = 'approve_first';
    const out = await bookPostOpVisit(f.deps, baseCase());
    expect(out.status).toBe('pending_approval');
    expect(f.connector.appointments.size).toBe(0);
    expect(f.tasks.tasks[0]).toMatchObject({ kind: 'post_op_approval', proposedSlot: { slotId: 'a' } });
  });

  it('does nothing when the feature flag is off', async () => {
    const f = makeFakeDeps([slot('a', '2026-03-14')]);
    f.deps.enabled = false;
    expect(await bookPostOpVisit(f.deps, baseCase())).toEqual({ status: 'disabled' });
    expect(await reschedulePostOpVisit(f.deps, baseCase())).toEqual({ status: 'disabled' });
    expect(await cancelPostOpVisit(f.deps, baseCase())).toEqual({ status: 'disabled' });
    expect(f.connector.appointments.size).toBe(0);
  });
});

describe('reschedulePostOpVisit', () => {
  it('moves the visit by the same offset from the new surgery date', async () => {
    const f = makeFakeDeps([slot('a', '2026-03-14'), slot('new', '2026-03-21'), slot('near', '2026-03-20')]);
    await bookPostOpVisit(f.deps, baseCase());
    const out = await reschedulePostOpVisit(f.deps, baseCase({ surgeryDate: '2026-03-09' }));
    expect(out.status).toBe('rescheduled');
    if (out.status !== 'rescheduled') return;
    expect(out.visit.startsAt.startsWith('2026-03-21')).toBe(true);
    expect(out.visit.offsetDays).toBe(12);
    expect(f.connector.appointments.size).toBe(1);
    // The old slot is released.
    expect(f.connector.openSlots.some((s) => s.slotId === 'a')).toBe(true);
  });

  it('picks the nearest in-window slot when the exact day is unavailable', async () => {
    const f = makeFakeDeps([slot('a', '2026-03-14'), slot('alt', '2026-03-22')]);
    await bookPostOpVisit(f.deps, baseCase());
    const out = await reschedulePostOpVisit(f.deps, baseCase({ surgeryDate: '2026-03-09' }));
    expect(out.status === 'rescheduled' && out.visit.startsAt.startsWith('2026-03-22')).toBe(true);
  });

  it('leaves the visit and raises a task when nothing fits the new window', async () => {
    const f = makeFakeDeps([slot('a', '2026-03-14')]);
    await bookPostOpVisit(f.deps, baseCase());
    const out = await reschedulePostOpVisit(f.deps, baseCase({ surgeryDate: '2026-04-20' }));
    expect(out).toEqual({ status: 'task_created', reason: 'move_failed' });
    expect(f.connector.appointments.size).toBe(1);
    expect(f.tasks.tasks[0]!.kind).toBe('post_op_move_failed');
    expect((await f.visits.get(P, 'case-hallux-valgus-1'))?.surgeryDate).toBe('2026-03-02');
  });

  it('is a no-op for an unchanged surgery date and books when no visit exists', async () => {
    const f = makeFakeDeps([slot('a', '2026-03-14')]);
    const booked = await reschedulePostOpVisit(f.deps, baseCase());
    expect(booked.status).toBe('booked');
    const same = await reschedulePostOpVisit(f.deps, baseCase());
    expect(same.status).toBe('rescheduled');
    expect(f.connector.appointments.size).toBe(1);
  });

  it('raises a workspace task when move is unsupported', async () => {
    const f = makeFakeDeps([slot('a', '2026-03-14'), slot('b', '2026-03-21')]);
    await bookPostOpVisit(f.deps, baseCase());
    f.connector.unsupported = true;
    const out = await reschedulePostOpVisit(f.deps, baseCase({ surgeryDate: '2026-03-09' }));
    expect(out).toEqual({ status: 'task_created', reason: 'unsupported' });
    expect(f.tasks.tasks[0]!.target).toBe('workspace');
  });

  it('raises a task when the move is rejected for another reason', async () => {
    const f = makeFakeDeps([slot('a', '2026-03-14'), slot('b', '2026-03-21')]);
    await bookPostOpVisit(f.deps, baseCase());
    f.connector.moveAppointment = () => Promise.resolve({ kind: 'not_found' });
    const out = await reschedulePostOpVisit(f.deps, baseCase({ surgeryDate: '2026-03-09' }));
    expect(out).toEqual({ status: 'task_created', reason: 'move_failed' });
  });
});

describe('cancelPostOpVisit', () => {
  it('cancels the visit and frees the slot; a later booking starts fresh', async () => {
    const f = makeFakeDeps([slot('a', '2026-03-14')]);
    await bookPostOpVisit(f.deps, baseCase());
    const out = await cancelPostOpVisit(f.deps, baseCase());
    expect(out.status).toBe('cancelled');
    expect(f.connector.appointments.size).toBe(0);
    expect(await cancelPostOpVisit(f.deps, baseCase())).toEqual({ status: 'no_visit' });
    const again = await bookPostOpVisit(f.deps, baseCase());
    expect(again.status === 'booked' && again.existing).toBe(false);
  });

  it('raises a workspace task when cancel is unsupported', async () => {
    const f = makeFakeDeps([slot('a', '2026-03-14')]);
    await bookPostOpVisit(f.deps, baseCase());
    f.connector.unsupported = true;
    const out = await cancelPostOpVisit(f.deps, baseCase());
    expect(out).toEqual({ status: 'task_created', reason: 'unsupported' });
    expect((await f.visits.get(P, 'case-hallux-valgus-1'))?.status).toBe('booked');
  });
});

describe('date helpers', () => {
  it('adds days across month boundaries', () => {
    expect(addDays('2026-02-25', 10)).toBe('2026-03-07');
  });
});
