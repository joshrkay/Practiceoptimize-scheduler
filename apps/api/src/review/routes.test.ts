import { review } from '@scheduler/agent';
import { describe, expect, it } from 'vitest';
import fixtures from '../../../../tests/fixtures/review/proposed-actions.json';
import { createReviewHandlers, type Session } from './routes';

const session: Session = { practiceId: 'practice-a', userId: 'user-1', roles: ['scheduler'] };
const [authFx, reminderFx] = fixtures as unknown as review.NewReviewItem[];

function setup() {
  const executor = new review.FakeExecutor();
  const queue = new review.ReviewQueue({
    store: new review.InMemoryReviewStore(),
    executor,
    audit: new review.FakeAuditSink(),
    clock: new review.FakeClock(new Date('2026-12-01T12:00:00Z')),
    escalator: new review.FakeEscalator(),
    hardRuleCheck: async (a) =>
      a.inputs['diagnosisCode'] === 'WRONG' ? { ok: false, reason: 'bad code' } : { ok: true },
  });
  return { queue, executor, h: createReviewHandlers(queue) };
}

async function add(queue: review.ReviewQueue, item: review.NewReviewItem, practiceId = 'practice-a') {
  const r = await queue.enqueue(practiceId, item);
  if (!r.ok) throw new Error('enqueue');
  return r.item;
}

describe('authentication and authorization', () => {
  it('rejects missing sessions and wrong roles on every route', async () => {
    const { h } = setup();
    for (const handler of Object.values(h)) {
      expect((await handler({ session: undefined })).status).toBe(401);
      expect((await handler({ session: { ...session, roles: ['viewer'] } })).status).toBe(403);
    }
  });
});

describe('list', () => {
  it('lists only the session practice, never one named in the query or body', async () => {
    const { h, queue } = setup();
    await add(queue, authFx!);
    await add(queue, reminderFx!, 'practice-b');
    const res = await h.list({ session, query: { practiceId: 'practice-b' }, body: { practiceId: 'practice-b' } });
    expect(res.status).toBe(200);
    expect((res.body as { items: unknown[] }).items).toHaveLength(1);
    expect((await h.list({ session, query: { status: 'pending', caseId: authFx!.caseId } })).status).toBe(200);
    expect((await h.list({ session, query: { status: 'bogus' } })).status).toBe(400);
  });
});

describe('approve, edit, reject', () => {
  it('approves and maps conflicts and not-found', async () => {
    const { h, queue, executor } = setup();
    const item = await add(queue, authFx!);
    expect((await h.approve({ session, params: { itemId: item.id } })).status).toBe(200);
    expect(executor.executed).toHaveLength(1);
    expect((await h.approve({ session, params: { itemId: item.id } })).status).toBe(409);
    expect((await h.approve({ session, params: { itemId: 'nope' } })).status).toBe(404);
    expect((await h.approve({ session })).status).toBe(400);
  });

  it('cannot reach another practice item', async () => {
    const { h, queue } = setup();
    const other = await add(queue, authFx!, 'practice-b');
    expect((await h.approve({ session, params: { itemId: other.id } })).status).toBe(404);
  });

  it('edit-and-approve returns the diff, and 422 when hard rules fail', async () => {
    const { h, queue } = setup();
    const item = await add(queue, authFx!);
    const bad = await h.editAndApprove({
      session,
      params: { itemId: item.id },
      body: { inputs: { diagnosisCode: 'WRONG' } },
    });
    expect(bad.status).toBe(422);
    const ok = await h.editAndApprove({
      session,
      params: { itemId: item.id },
      body: { inputs: { ...authFx!.inputs, diagnosisCode: 'M20.11' } },
    });
    expect(ok.status).toBe(200);
    expect((ok.body as { item: { diff: unknown[] } }).item.diff).toHaveLength(1);
    expect((await h.editAndApprove({ session, params: { itemId: item.id }, body: {} })).status).toBe(400);
    expect((await h.editAndApprove({ session, body: { inputs: {} } })).status).toBe(400);
  });

  it('reject validates the reason', async () => {
    const { h, queue } = setup();
    const item = await add(queue, authFx!);
    expect((await h.reject({ session, params: { itemId: item.id }, body: {} })).status).toBe(400);
    expect((await h.reject({ session, body: { reason: 'x' } })).status).toBe(400);
    const res = await h.reject({ session, params: { itemId: item.id }, body: { reason: 'Wrong payer' } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ item: { status: 'rejected', rejectionReason: 'Wrong payer' } });
  });

  it('maps execution failure to 502', async () => {
    const { h, queue, executor } = setup();
    executor.failWith = 'down';
    const item = await add(queue, authFx!);
    expect((await h.approve({ session, params: { itemId: item.id } })).status).toBe(502);
  });
});

describe('bulk approve', () => {
  it('approves eligible items, reports drops, refuses ineligible types, validates body', async () => {
    const { h, queue } = setup();
    const a = await add(queue, reminderFx!);
    const res = await h.bulkApprove({ session, body: { actionType: 'reminder', itemIds: [a.id, 'missing'] } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ approved: [{ id: a.id }], dropped: [{ itemId: 'missing', code: 'not_found' }] });
    expect((await h.bulkApprove({ session, body: { actionType: 'auth_submission', itemIds: ['x'] } })).status).toBe(400);
    expect((await h.bulkApprove({ session, body: { itemIds: ['x'] } })).status).toBe(400);
    expect((await h.bulkApprove({ session, body: { actionType: 'reminder', itemIds: [] } })).status).toBe(400);
    expect((await h.bulkApprove({ session, body: { actionType: 'reminder', itemIds: [1] } })).status).toBe(400);
  });
});

describe('take over and release', () => {
  it('toggles takeover and reports conflicts', async () => {
    const { h, queue } = setup();
    const params = { caseId: 'case-podiatry-001' };
    expect((await h.takeOver({ session, params })).status).toBe(200);
    expect((await h.takeOver({ session, params })).status).toBe(409);
    expect(await queue.plannerMayAct('practice-a', params.caseId)).toBe(false);
    expect((await h.release({ session, params })).status).toBe(200);
    expect((await h.release({ session, params })).status).toBe(409);
    expect((await h.takeOver({ session })).status).toBe(400);
    expect((await h.release({ session })).status).toBe(400);
  });
});
