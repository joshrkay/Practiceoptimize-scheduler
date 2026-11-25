import { describe, expect, it } from 'vitest';
import { DuplicateActiveRequestError } from './ports.js';
import { InMemoryCoordinationRequestStore } from './fakes.js';
import type { CoordinationRequest } from './requests.js';
import {
  InvalidTransitionError,
  canTransition,
  idempotencyKey,
  isActive,
  markAnswered,
  markCancelled,
  markOverdue,
} from './requests.js';

const at = new Date('2027-01-04T15:00:00.000Z');

function request(overrides: Partial<CoordinationRequest> = {}): CoordinationRequest {
  return {
    id: 'req-1',
    practiceId: 'practice-a',
    caseId: 'case-1',
    partyId: 'party-pcp',
    partyRole: 'primary_care',
    type: 'clearance',
    stepId: 'clearance-primary-care',
    stage: 'scheduled',
    channel: 'fax',
    status: 'open',
    approval: { status: 'not_required' },
    surgeryDate: '2027-02-10',
    dueAt: '2027-02-03T00:00:00.000Z',
    createdAt: at.toISOString(),
    sentAt: at.toISOString(),
    answeredAt: null,
    cancelledAt: null,
    cancelReason: null,
    remindersSent: 0,
    phoneTaskId: null,
    supersedesId: null,
    blocksReadiness: true,
    history: [],
    ...overrides,
  };
}

describe('CoordinationRequest lifecycle', () => {
  it('allows open -> answered, overdue, cancelled and overdue -> answered, cancelled', () => {
    expect(canTransition('open', 'answered')).toBe(true);
    expect(canTransition('open', 'overdue')).toBe(true);
    expect(canTransition('open', 'cancelled')).toBe(true);
    expect(canTransition('overdue', 'answered')).toBe(true);
    expect(canTransition('overdue', 'cancelled')).toBe(true);
    expect(canTransition('overdue', 'open')).toBe(false);
    expect(canTransition('answered', 'cancelled')).toBe(false);
    expect(canTransition('cancelled', 'open')).toBe(false);
  });

  it('records timestamps and history on each transition', () => {
    const overdue = markOverdue(request(), at);
    expect(overdue.status).toBe('overdue');
    const answered = markAnswered(overdue, at, 'cleared');
    expect(answered).toMatchObject({ status: 'answered', answeredAt: at.toISOString() });
    expect(answered.history).toEqual([
      { at: at.toISOString(), event: 'overdue' },
      { at: at.toISOString(), event: 'answered', detail: 'cleared' },
    ]);
    const cancelled = markCancelled(request(), at, 'change plan cp-1');
    expect(cancelled).toMatchObject({ status: 'cancelled', cancelledAt: at.toISOString(), cancelReason: 'change plan cp-1' });
  });

  it('rejects transitions out of terminal states', () => {
    const answered = markAnswered(request(), at);
    expect(() => markCancelled(answered, at, 'x')).toThrow(InvalidTransitionError);
    expect(() => markOverdue(markCancelled(request(), at, 'x'), at)).toThrow(/cannot move from cancelled to overdue/);
  });

  it('treats open and overdue as active and keys idempotency on practice, case, party and type', () => {
    expect(isActive(request())).toBe(true);
    expect(isActive(request({ status: 'overdue' }))).toBe(true);
    expect(isActive(request({ status: 'answered' }))).toBe(false);
    expect(idempotencyKey(request())).toBe('practice-a|case-1|party-pcp|clearance');
  });
});

describe('InMemoryCoordinationRequestStore', () => {
  it('enforces one active request per practice, case, party and type', async () => {
    const store = new InMemoryCoordinationRequestStore();
    await store.insert(request());
    await expect(store.insert(request({ id: 'req-2' }))).rejects.toBeInstanceOf(DuplicateActiveRequestError);
    await store.insert(request({ id: 'req-3', practiceId: 'practice-b' }));
    await store.update(markCancelled(request(), at, 'x'));
    await store.insert(request({ id: 'req-4' }));
    await store.insert(request({ id: 'req-5', status: 'answered' }));
    expect((await store.listByCase('practice-a', 'case-1')).map((row) => row.id)).toEqual(['req-1', 'req-4', 'req-5']);
  });

  it('refuses updates to unknown requests or across practices', async () => {
    const store = new InMemoryCoordinationRequestStore();
    await expect(store.update(request())).rejects.toThrow(/not found/);
    await store.insert(request());
    await expect(store.update(request({ practiceId: 'practice-b' }))).rejects.toThrow(/not found/);
    expect(await store.get('practice-b', 'req-1')).toBeNull();
  });
});
