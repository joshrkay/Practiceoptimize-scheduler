import { beforeEach, describe, expect, it } from 'vitest';
import {
  FakeClock,
  FakeNotifier,
  FakeSessions,
  InMemoryAudit,
  InMemoryGrantStore,
  SequentialIds,
} from './fakes.js';
import { createSupportAccessRoutes, type ApiRequest } from './routes.js';
import { readMaxGrantHours, SupportAccessService } from './service.js';
import type { SessionContext } from './types.js';

const PRACTICE = 'practice-podiatry-a';
const OTHER = 'practice-podiatry-b';

const engineer: SessionContext = { userId: 'eng-1', practiceId: null, roles: ['support_engineer'] };
const engineer2: SessionContext = { userId: 'eng-2', practiceId: null, roles: ['support_engineer'] };
const approverA: SessionContext = { userId: 'appr-1', practiceId: null, roles: ['internal_approver'] };
const approverB: SessionContext = { userId: 'appr-2', practiceId: null, roles: ['internal_approver'] };
const admin: SessionContext = { userId: 'admin-1', practiceId: PRACTICE, roles: ['practice_admin'] };
const otherAdmin: SessionContext = { userId: 'admin-2', practiceId: OTHER, roles: ['practice_admin'] };

function setup() {
  const clock = new FakeClock();
  const audit = new InMemoryAudit();
  const sessions = new FakeSessions();
  const notifier = new FakeNotifier();
  const service = new SupportAccessService({
    store: new InMemoryGrantStore(),
    audit,
    sessions,
    notifier,
    clock,
    ids: new SequentialIds(),
    maxGrantHours: 24,
  });
  return { clock, audit, sessions, notifier, service, routes: createSupportAccessRoutes(service) };
}

describe('standard grants', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });

  it('scenario 1: approved case-scoped grant allows only that case for 2 hours, every view in the access log', async () => {
    const g = await t.service.requestGrant(engineer, {
      practiceId: PRACTICE,
      caseId: 'case-1',
      reason: 'investigate sync error',
      durationHours: 2,
    });
    expect(g.status).toBe('pending');
    expect((await t.service.checkAccess(engineer, { practiceId: PRACTICE, caseId: 'case-1', action: 'case.view' })).allowed).toBe(false);

    const approved = await t.service.approveGrant(admin, g.id);
    expect(approved.expiresAt).toBe('2026-01-05T14:00:00.000Z');

    const ok = await t.service.checkAccess(engineer, { practiceId: PRACTICE, caseId: 'case-1', action: 'case.view' });
    expect(ok).toMatchObject({ allowed: true, grantId: g.id });
    const other = await t.service.checkAccess(engineer, { practiceId: PRACTICE, caseId: 'case-2', action: 'case.view' });
    expect(other).toMatchObject({ allowed: false, reason: 'outside grant scope' });
    const noCase = await t.service.checkAccess(engineer, { practiceId: PRACTICE, action: 'schedule.list' });
    expect(noCase.allowed).toBe(false);
    const wrongPractice = await t.service.checkAccess(engineer, { practiceId: OTHER, caseId: 'case-1', action: 'case.view' });
    expect(wrongPractice.allowed).toBe(false);
    const wrongUser = await t.service.checkAccess(engineer2, { practiceId: PRACTICE, caseId: 'case-1', action: 'case.view' });
    expect(wrongUser).toMatchObject({ allowed: false, reason: 'no active grant' });

    t.clock.advanceHours(1.99);
    expect((await t.service.checkAccess(engineer, { practiceId: PRACTICE, caseId: 'case-1', action: 'case.edit' })).allowed).toBe(true);
    t.clock.advanceHours(0.02);
    expect((await t.service.checkAccess(engineer, { practiceId: PRACTICE, caseId: 'case-1', action: 'case.view' })).reason).toBe('no active grant');

    const log = await t.service.accessLog(admin, { caseId: 'case-1' });
    expect(log.filter((e) => e.type === 'phi_access').map((e) => e.action)).toEqual(['case.view', 'case.edit']);
    expect(log.some((e) => e.type === 'phi_access_denied')).toBe(true);
    // Another practice's admin sees none of it.
    expect(await t.service.accessLog(otherAdmin)).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ practiceId: PRACTICE })]),
    );
  });

  it('practice-wide grant covers any case', async () => {
    const g = await t.service.requestGrant(engineer, { practiceId: PRACTICE, reason: 'outage', durationHours: 1 });
    await t.service.approveGrant(admin, g.id);
    expect((await t.service.checkAccess(engineer, { practiceId: PRACTICE, caseId: 'x', action: 'case.view' })).allowed).toBe(true);
    expect((await t.service.checkAccess(engineer, { practiceId: PRACTICE, action: 'schedule.list' })).allowed).toBe(true);
  });

  it('caps duration at 24 hours and validates input', async () => {
    await expect(t.service.requestGrant(engineer, { practiceId: PRACTICE, reason: 'r', durationHours: 24.5 })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(t.service.requestGrant(engineer, { practiceId: PRACTICE, reason: 'r', durationHours: 0 })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(t.service.requestGrant(engineer, { practiceId: PRACTICE, reason: '  ', durationHours: 1 })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(t.service.requestGrant(engineer, { practiceId: '', reason: 'r', durationHours: 1 })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(t.service.requestGrant(engineer, { practiceId: PRACTICE, reason: 'r', durationHours: 24 })).resolves.toBeTruthy();
  });

  it('reads the cap from SUPPORT_GRANT_MAX_HOURS', () => {
    expect(readMaxGrantHours({})).toBe(24);
    expect(readMaxGrantHours({ SUPPORT_GRANT_MAX_HOURS: '8' })).toBe(8);
    expect(readMaxGrantHours({ SUPPORT_GRANT_MAX_HOURS: 'abc' })).toBe(24);
  });

  it('only support engineers request; only practice admins decide, within their own practice', async () => {
    await expect(t.service.requestGrant(admin, { practiceId: PRACTICE, reason: 'r', durationHours: 1 })).rejects.toMatchObject({ code: 'forbidden' });
    const g = await t.service.requestGrant(engineer, { practiceId: PRACTICE, reason: 'r', durationHours: 1 });
    await expect(t.service.approveGrant(engineer, g.id)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(t.service.approveGrant({ userId: 'x', practiceId: null, roles: ['practice_admin'] }, g.id)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(t.service.approveGrant(otherAdmin, g.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(t.service.approveGrant(admin, 'nope')).rejects.toMatchObject({ code: 'not_found' });
    await t.service.approveGrant(admin, g.id);
    await expect(t.service.approveGrant(admin, g.id)).rejects.toMatchObject({ code: 'conflict' });
    await expect(t.service.denyGrant(admin, g.id)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('deny leaves no access and is audited', async () => {
    const g = await t.service.requestGrant(engineer, { practiceId: PRACTICE, reason: 'r', durationHours: 1 });
    const d = await t.service.denyGrant(admin, g.id, ' not now ');
    expect(d).toMatchObject({ status: 'denied', decisionReason: 'not now' });
    expect((await t.service.checkAccess(engineer, { practiceId: PRACTICE, action: 'a' })).allowed).toBe(false);
    expect(t.audit.events.map((e) => e.type)).toContain('grant_denied');
    await expect(t.service.revokeGrant(admin, g.id)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('scenario 2: revocation ends active sessions and denies access immediately', async () => {
    const g = await t.service.requestGrant(engineer, { practiceId: PRACTICE, caseId: 'case-1', reason: 'r', durationHours: 2 });
    await t.service.approveGrant(admin, g.id);
    await t.service.openSession(engineer, g.id);
    expect(t.sessions.live.size).toBe(1);
    await t.service.revokeGrant(admin, g.id, 'done');
    expect(t.sessions.live.size).toBe(0);
    expect((await t.service.checkAccess(engineer, { practiceId: PRACTICE, caseId: 'case-1', action: 'case.view' })).allowed).toBe(false);
    expect(t.audit.events.map((e) => e.type)).toEqual(expect.arrayContaining(['grant_revoked', 'session_ended']));
    await expect(t.service.revokeGrant(admin, g.id)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('retries ending sessions on sweep when the session store was down at revoke', async () => {
    const g = await t.service.requestGrant(engineer, { practiceId: PRACTICE, reason: 'r', durationHours: 2 });
    await t.service.approveGrant(admin, g.id);
    await t.service.openSession(engineer, g.id);
    t.sessions.failEnd = true;
    const revoked = await t.service.revokeGrant(admin, g.id);
    expect(revoked.sessionsEnded).toBe(false);
    expect(t.sessions.live.size).toBe(1);
    // Status already denies access even though the session lingers.
    expect((await t.service.checkAccess(engineer, { practiceId: PRACTICE, action: 'a' })).allowed).toBe(false);
    t.sessions.failEnd = false;
    t.clock.advanceMs(30_000);
    expect(await t.service.sweep()).toBe(1);
    expect(t.sessions.live.size).toBe(0);
    expect(await t.service.sweep()).toBe(0);
  });

  it('revokes a pending request', async () => {
    const g = await t.service.requestGrant(engineer, { practiceId: PRACTICE, reason: 'r', durationHours: 1 });
    expect((await t.service.revokeGrant(admin, g.id)).status).toBe('revoked');
  });

  it('expires automatically: sweep marks it expired, audits, and ends sessions', async () => {
    const g = await t.service.requestGrant(engineer, { practiceId: PRACTICE, reason: 'r', durationHours: 1 });
    await t.service.approveGrant(admin, g.id);
    await t.service.openSession(engineer, g.id);
    t.clock.advanceHours(1);
    expect((await t.service.listGrants(admin))[0]?.status).toBe('expired');
    await expect(t.service.openSession(engineer, g.id)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(t.service.revokeGrant(admin, g.id)).rejects.toMatchObject({ code: 'conflict' });
    expect(await t.service.sweep()).toBe(2);
    expect(t.sessions.live.size).toBe(0);
    expect(t.audit.events.map((e) => e.type)).toContain('grant_expired');
  });

  it('openSession requires own, active grant', async () => {
    const g = await t.service.requestGrant(engineer, { practiceId: PRACTICE, reason: 'r', durationHours: 1 });
    await expect(t.service.openSession(engineer, g.id)).rejects.toMatchObject({ code: 'forbidden' });
    await t.service.approveGrant(admin, g.id);
    await expect(t.service.openSession(engineer2, g.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(t.service.openSession(engineer, 'zzz')).rejects.toMatchObject({ code: 'not_found' });
    await expect(t.service.openSession(admin, g.id)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('fails closed when audit is unavailable', async () => {
    const g = await t.service.requestGrant(engineer, { practiceId: PRACTICE, reason: 'r', durationHours: 1 });
    t.audit.failNext = true;
    await expect(t.service.approveGrant(admin, g.id)).rejects.toThrow('audit unavailable');
    expect((await t.service.listGrants(admin))[0]?.status).toBe('pending');

    await t.service.approveGrant(admin, g.id);
    t.audit.failNext = true;
    expect(await t.service.checkAccess(engineer, { practiceId: PRACTICE, action: 'a' })).toMatchObject({ allowed: false, reason: 'audit unavailable' });
    // Denied-access audit failure still denies.
    t.audit.failNext = true;
    expect((await t.service.checkAccess(engineer2, { practiceId: PRACTICE, action: 'a' })).allowed).toBe(false);
  });

  it('lists grants newest first for own practice only', async () => {
    await t.service.requestGrant(engineer, { practiceId: PRACTICE, reason: 'first', durationHours: 1 });
    t.clock.advanceMs(1000);
    await t.service.requestGrant(engineer, { practiceId: PRACTICE, reason: 'second', durationHours: 1 });
    await t.service.requestGrant(engineer, { practiceId: OTHER, reason: 'elsewhere', durationHours: 1 });
    expect((await t.service.listGrants(admin)).map((g) => g.reason)).toEqual(['second', 'first']);
  });
});

describe('break-glass', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });

  it('needs two distinct internal approvers, notifies the practice immediately, practice-wide', async () => {
    const g = await t.service.requestBreakGlass(engineer, { practiceId: PRACTICE, reason: 'sev1 outage', durationHours: 4 });
    expect(g.caseId).toBeNull();
    expect((await t.service.checkAccess(engineer, { practiceId: PRACTICE, action: 'a' })).allowed).toBe(false);

    const one = await t.service.approveBreakGlass(approverA, g.id);
    expect(one.status).toBe('pending');
    expect(t.notifier.sent).toHaveLength(0);
    await expect(t.service.approveBreakGlass(approverA, g.id)).rejects.toMatchObject({ code: 'conflict' });
    await expect(t.service.approveBreakGlass(engineer, g.id)).rejects.toMatchObject({ code: 'forbidden' });

    const two = await t.service.approveBreakGlass(approverB, g.id);
    expect(two.status).toBe('approved');
    expect(t.notifier.sent).toEqual([
      expect.objectContaining({ kind: 'break_glass_activated', practiceId: PRACTICE, grantId: g.id, approverUserIds: ['appr-1', 'appr-2'] }),
    ]);
    expect((await t.service.checkAccess(engineer, { practiceId: PRACTICE, caseId: 'any', action: 'case.view' })).allowed).toBe(true);
    await expect(t.service.approveBreakGlass(approverB, g.id)).rejects.toMatchObject({ code: 'conflict' });

    const log = await t.service.accessLog(admin);
    expect(log.map((e) => e.type)).toEqual(
      expect.arrayContaining(['break_glass_requested', 'break_glass_approval_recorded', 'break_glass_activated', 'phi_access']),
    );
    t.clock.advanceHours(4);
    expect((await t.service.checkAccess(engineer, { practiceId: PRACTICE, action: 'a' })).allowed).toBe(false);
  });

  it('requester cannot approve their own request even with the approver role', async () => {
    const both: SessionContext = { userId: 'eng-9', practiceId: null, roles: ['support_engineer', 'internal_approver'] };
    const g = await t.service.requestBreakGlass(both, { practiceId: PRACTICE, reason: 'r', durationHours: 1 });
    await expect(t.service.approveBreakGlass(both, g.id)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('is capped at the same maximum', async () => {
    await expect(t.service.requestBreakGlass(engineer, { practiceId: PRACTICE, reason: 'r', durationHours: 25 })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(t.service.requestBreakGlass(admin, { practiceId: PRACTICE, reason: 'r', durationHours: 1 })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(t.service.requestBreakGlass(engineer, { practiceId: '', reason: 'r', durationHours: 1 })).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('does not activate when the practice cannot be notified', async () => {
    const g = await t.service.requestBreakGlass(engineer, { practiceId: PRACTICE, reason: 'r', durationHours: 1 });
    await t.service.approveBreakGlass(approverA, g.id);
    t.notifier.fail = true;
    await expect(t.service.approveBreakGlass(approverB, g.id)).rejects.toThrow('notifier down');
    expect((await t.service.checkAccess(engineer, { practiceId: PRACTICE, action: 'a' })).allowed).toBe(false);
    t.notifier.fail = false;
    expect((await t.service.approveBreakGlass(approverB, g.id)).status).toBe('approved');
  });

  it('practice admin can revoke break-glass; standard approve/deny reject it; unknown ids 404', async () => {
    const g = await t.service.requestBreakGlass(engineer, { practiceId: PRACTICE, reason: 'r', durationHours: 1 });
    await expect(t.service.approveGrant(admin, g.id)).rejects.toMatchObject({ code: 'conflict' });
    await expect(t.service.denyGrant(admin, g.id)).rejects.toMatchObject({ code: 'conflict' });
    await t.service.approveBreakGlass(approverA, g.id);
    await t.service.approveBreakGlass(approverB, g.id);
    await t.service.revokeGrant(admin, g.id);
    expect((await t.service.checkAccess(engineer, { practiceId: PRACTICE, action: 'a' })).allowed).toBe(false);
    await expect(t.service.approveBreakGlass(approverA, 'nope')).rejects.toMatchObject({ code: 'not_found' });
    const std = await t.service.requestGrant(engineer, { practiceId: PRACTICE, reason: 'r', durationHours: 1 });
    await expect(t.service.approveBreakGlass(approverA, std.id)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('route handlers', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });
  const req = (session: SessionContext | null, extra: Partial<ApiRequest> = {}): ApiRequest => ({ session, ...extra });

  it('runs the full flow over handlers', async () => {
    const created = await t.routes.requestGrant(
      req(engineer, { body: { practiceId: PRACTICE, caseId: 'case-1', reason: 'r', durationHours: 2 } }),
    );
    expect(created.status).toBe(201);
    const id = (created.body as { id: string }).id;
    expect((await t.routes.listGrants(req(admin))).status).toBe(200);
    expect((await t.routes.approveGrant(req(admin, { params: { grantId: id } }))).status).toBe(200);
    expect((await t.routes.openSession(req(engineer, { params: { grantId: id } }))).status).toBe(201);
    const view = await t.routes.recordAccess(req(engineer, { body: { practiceId: PRACTICE, caseId: 'case-1', action: 'case.view' } }));
    expect(view).toEqual({ status: 200, body: { grantId: id } });
    const denied = await t.routes.recordAccess(req(engineer, { body: { practiceId: PRACTICE, caseId: 'case-2', action: 'case.view' } }));
    expect(denied.status).toBe(403);
    const log = await t.routes.accessLog(req(admin, { query: { caseId: 'case-1', limit: '10', from: '2020-01-01T00:00:00Z', to: '2100-01-01T00:00:00Z', grantId: id } }));
    expect(log.status).toBe(200);
    expect((log.body as { events: unknown[] }).events.length).toBeGreaterThan(0);
    expect((await t.routes.revokeGrant(req(admin, { params: { grantId: id }, body: { reason: 'x' } }))).status).toBe(200);
  });

  it('deny route and break-glass routes', async () => {
    const g = await t.routes.requestGrant(req(engineer, { body: { practiceId: PRACTICE, reason: 'r', durationHours: 1 } }));
    const id = (g.body as { id: string }).id;
    expect((await t.routes.denyGrant(req(admin, { params: { grantId: id } }))).status).toBe(200);
    const bg = await t.routes.requestBreakGlass(req(engineer, { body: { practiceId: PRACTICE, reason: 'r', durationHours: 1 } }));
    expect(bg.status).toBe(201);
    const bid = (bg.body as { id: string }).id;
    expect((await t.routes.approveBreakGlass(req(approverA, { params: { grantId: bid } }))).status).toBe(200);
    expect((await t.routes.approveBreakGlass(req(approverB, { params: { grantId: bid } }))).status).toBe(200);
  });

  it('maps errors: 401, 400, 403, 404, 409, 500', async () => {
    expect((await t.routes.listGrants(req(null))).status).toBe(401);
    expect((await t.routes.requestGrant(req(engineer, { body: 'x' }))).status).toBe(400);
    expect((await t.routes.requestGrant(req(engineer, { body: [] }))).status).toBe(400);
    expect((await t.routes.requestGrant(req(engineer))).status).toBe(400);
    expect((await t.routes.requestGrant(req(engineer, { body: { reason: 'r', durationHours: 1 } }))).status).toBe(400);
    expect((await t.routes.requestGrant(req(engineer, { body: { practiceId: 1, reason: 'r', durationHours: 1 } }))).status).toBe(400);
    expect((await t.routes.requestGrant(req(engineer, { body: { practiceId: PRACTICE, reason: 'r', durationHours: '1' } }))).status).toBe(400);
    expect((await t.routes.approveGrant(req(admin))).status).toBe(400);
    expect((await t.routes.approveGrant(req(engineer, { params: { grantId: 'g' } }))).status).toBe(403);
    expect((await t.routes.approveGrant(req(admin, { params: { grantId: 'g' } }))).status).toBe(404);
    expect((await t.routes.accessLog(req(admin, { query: { limit: '0' } }))).status).toBe(400);
    const g = await t.routes.requestGrant(req(engineer, { body: { practiceId: PRACTICE, reason: 'r', durationHours: 1 } }));
    const id = (g.body as { id: string }).id;
    await t.routes.approveGrant(req(admin, { params: { grantId: id } }));
    expect((await t.routes.approveGrant(req(admin, { params: { grantId: id } }))).status).toBe(409);
    t.audit.failNext = true;
    expect((await t.routes.requestGrant(req(engineer, { body: { practiceId: PRACTICE, reason: 'r', durationHours: 1 } }))).status).toBe(500);
  });

  it('ignores identity fields in bodies: practice and user come from the session', async () => {
    const g = await t.routes.requestGrant(
      req(engineer, { body: { practiceId: PRACTICE, reason: 'r', durationHours: 1, requesterUserId: 'someone-else' } }),
    );
    expect(g.body).toMatchObject({ requesterUserId: 'eng-1' });
    const id = (g.body as { id: string }).id;
    const wrong = await t.routes.approveGrant(req(otherAdmin, { params: { grantId: id }, body: { practiceId: PRACTICE } }));
    expect(wrong.status).toBe(404);
  });
});
