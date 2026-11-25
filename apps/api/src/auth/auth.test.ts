import { describe, expect, it } from 'vitest';
import fixture from '../../../../tests/fixtures/auth/users-and-scopes.json';
import {
  AuthService,
  FakeIdentityProvider,
  InMemoryUserDirectory,
  InvalidScopeError,
  ROLES,
  SessionManager,
  filterByScope,
  isInScope,
  isRole,
  loadAuthConfig,
  mfaRequiredFor,
  normalizeScope,
  scopeSqlClause,
  systemClock,
  type Role,
  type Scope,
} from './index';

const P = fixture.practiceId;
const T0 = new Date('2026-01-05T09:00:00Z');
const COLS = { practice: 'c.practice_id', location: 'c.location_id', surgeon: 'c.surgeon_id' };

function clock() {
  let t = T0.getTime();
  return {
    now: () => new Date(t),
    advance: (min: number) => {
      t += min * 60_000;
    },
  };
}

function setup() {
  const c = clock();
  const idp = new FakeIdentityProvider();
  const dir = new InMemoryUserDirectory();
  for (const u of fixture.users) {
    dir.add(P, u.subject, { userId: u.userId, role: u.role as Role, scope: u.scope as Scope });
  }
  const sessions = new SessionManager({ sessionTtlMinutes: 60, idleLogoffMinutes: 10 }, c);
  const svc = new AuthService(idp, dir, sessions, c);
  const login = async (subject: string, mfa = true) => {
    const { state } = await idp.beginLogin(P);
    idp.setOutcome(`code-${subject}`, { subject, mfaCompleted: mfa, authenticatedAt: c.now() });
    return svc.completeSignIn({ state, code: `code-${subject}` });
  };
  const session = async (subject: string) => {
    const r = await login(subject);
    if (!r.ok) throw new Error(`sign-in failed: ${r.reason}`);
    return r.session;
  };
  return { c, idp, dir, sessions, svc, login, session };
}

describe('scope filtering', () => {
  it('location-scoped scheduler sees only North cases', async () => {
    const { session } = setup();
    const s = await session('sub-north');
    expect(filterByScope(s, fixture.cases).map((x) => x.id)).toEqual(['case-1', 'case-3']);
  });

  it('surgeon panel and practice scopes; other practices always excluded', async () => {
    const { session } = setup();
    const panel = await session('sub-panel');
    const admin = await session('sub-admin');
    expect(filterByScope(panel, fixture.cases).map((x) => x.id)).toEqual(['case-1', 'case-2']);
    expect(filterByScope(admin, fixture.cases).map((x) => x.id)).toEqual(['case-1', 'case-2', 'case-3']);
  });

  it('rows missing the scoped dimension are excluded', () => {
    expect(isInScope({ practiceId: P, scope: { kind: 'locations', locationIds: ['a'] } }, { practiceId: P })).toBe(false);
    expect(
      isInScope({ practiceId: P, scope: { kind: 'surgeons', surgeonIds: ['a'] } }, { practiceId: P, surgeonId: null }),
    ).toBe(false);
  });

  it('unknown scope kind fails closed', () => {
    const bad = { practiceId: P, scope: { kind: 'bogus' } as unknown as Scope };
    expect(isInScope(bad, { practiceId: P, locationId: 'a' })).toBe(false);
    expect(scopeSqlClause(bad, COLS).sql).toBe('false');
  });

  it('builds parameterised SQL clauses', () => {
    expect(scopeSqlClause({ practiceId: P, scope: { kind: 'practice' } }, COLS)).toEqual({
      sql: 'c.practice_id = $1',
      params: [P],
    });
    expect(scopeSqlClause({ practiceId: P, scope: { kind: 'locations', locationIds: ['l1'] } }, COLS, 3)).toEqual({
      sql: 'c.practice_id = $3 AND c.location_id = ANY($4)',
      params: [P, ['l1']],
    });
    expect(scopeSqlClause({ practiceId: P, scope: { kind: 'surgeons', surgeonIds: ['s1'] } }, COLS).sql).toContain(
      'c.surgeon_id = ANY($2)',
    );
    expect(() =>
      scopeSqlClause({ practiceId: P, scope: { kind: 'practice' } }, { ...COLS, practice: 'x; drop' }),
    ).toThrow();
  });
});

describe('sign-in and MFA', () => {
  it('denies access until MFA is completed', async () => {
    const { login } = setup();
    expect(await login('sub-north', false)).toEqual({ ok: false, reason: 'mfa_required' });
    expect((await login('sub-north', true)).ok).toBe(true);
  });

  it('requires MFA for every role', () => {
    for (const r of ROLES) expect(mfaRequiredFor(r)).toBe(true);
  });

  it('rejects bad callbacks and users without a grant', async () => {
    const { svc, login } = setup();
    expect(await svc.completeSignIn({ state: 'nope', code: 'nope' })).toEqual({ ok: false, reason: 'idp_failed' });
    expect(await login('sub-stranger')).toEqual({ ok: false, reason: 'no_access' });
  });

  it('grants are looked up only in the practice asserted by the IdP connection', async () => {
    const { idp, dir, svc, c } = setup();
    dir.add('practice-other-002', 'sub-x', { userId: 'u-x', role: 'scheduler', scope: { kind: 'practice' } });
    const { state } = await idp.beginLogin(P);
    idp.setOutcome('cx', { subject: 'sub-x', mfaCompleted: true, authenticatedAt: c.now() });
    expect(await svc.completeSignIn({ state, code: 'cx' })).toEqual({ ok: false, reason: 'no_access' });
  });

  it('denies a grant with an empty scope', async () => {
    const { dir, login } = setup();
    dir.add(P, 'sub-empty', { userId: 'u-e', role: 'scheduler', scope: { kind: 'locations', locationIds: [] } });
    expect(await login('sub-empty')).toEqual({ ok: false, reason: 'no_access' });
  });
});

describe('vendor support grants', () => {
  it('needs an expiry, is capped by it, and fails once expired', async () => {
    const { dir, login, c, sessions } = setup();
    dir.add(P, 'sub-v1', { userId: 'u-v1', role: 'vendor_support', scope: { kind: 'practice' } });
    expect(await login('sub-v1')).toEqual({ ok: false, reason: 'no_access' });

    dir.add(P, 'sub-v2', {
      userId: 'u-v2',
      role: 'vendor_support',
      scope: { kind: 'practice' },
      expiresAt: new Date(T0.getTime() + 20 * 60_000),
    });
    const r = await login('sub-v2');
    if (!r.ok) throw new Error('expected ok');
    expect(r.session.expiresAt.getTime()).toBe(T0.getTime() + 20 * 60_000);
    c.advance(9);
    expect(sessions.validate(r.session.id).ok).toBe(true);
    c.advance(9);
    expect(sessions.validate(r.session.id).ok).toBe(true);
    c.advance(5);
    expect(sessions.validate(r.session.id)).toEqual({ ok: false, reason: 'expired' });

    dir.add(P, 'sub-v3', {
      userId: 'u-v3',
      role: 'vendor_support',
      scope: { kind: 'practice' },
      expiresAt: T0,
    });
    expect(await login('sub-v3')).toEqual({ ok: false, reason: 'grant_expired' });
  });
});

describe('sessions', () => {
  it('logs off when idle and expires at the TTL even when active', async () => {
    const { session, c, sessions } = setup();
    const s = await session('sub-admin');
    c.advance(9);
    expect(sessions.validate(s.id).ok).toBe(true);
    c.advance(10);
    expect(sessions.validate(s.id)).toEqual({ ok: false, reason: 'idle' });
    expect(sessions.validate(s.id)).toEqual({ ok: false, reason: 'unknown' });

    const s2 = await session('sub-admin');
    for (let i = 0; i < 6; i++) {
      c.advance(9);
      expect(sessions.validate(s2.id).ok).toBe(true);
    }
    c.advance(9);
    expect(sessions.validate(s2.id)).toEqual({ ok: false, reason: 'expired' });
  });

  it('session is immutable and revocable', async () => {
    const { session, sessions } = setup();
    const s = await session('sub-admin');
    expect(() => {
      (s as { practiceId: string }).practiceId = 'other';
    }).toThrow();
    sessions.revoke(s.id);
    expect(sessions.validate(s.id).ok).toBe(false);
  });
});

describe('config and roles', () => {
  it('reads env with defaults and rejects bad values', () => {
    expect(loadAuthConfig({})).toEqual({ sessionTtlMinutes: 480, idleLogoffMinutes: 15 });
    expect(loadAuthConfig({ AUTH_SESSION_TTL_MINUTES: '30', AUTH_IDLE_LOGOFF_MINUTES: '5' })).toEqual({
      sessionTtlMinutes: 30,
      idleLogoffMinutes: 5,
    });
    expect(() => loadAuthConfig({ AUTH_SESSION_TTL_MINUTES: '0' })).toThrow();
    expect(() => loadAuthConfig({ AUTH_IDLE_LOGOFF_MINUTES: 'abc' })).toThrow();
  });

  it('role guard, scope normalisation, default clock', () => {
    expect(isRole('scheduler')).toBe(true);
    expect(isRole('surgeon')).toBe(false);
    expect(normalizeScope({ kind: 'practice' })).toEqual({ kind: 'practice' });
    expect(normalizeScope({ kind: 'locations', locationIds: ['a', 'a'] })).toEqual({
      kind: 'locations',
      locationIds: ['a'],
    });
    expect(normalizeScope({ kind: 'surgeons', surgeonIds: ['s'] })).toEqual({ kind: 'surgeons', surgeonIds: ['s'] });
    expect(() => normalizeScope({ kind: 'surgeons', surgeonIds: [] })).toThrow(InvalidScopeError);
    expect(() => normalizeScope({ kind: 'x' } as unknown as Scope)).toThrow(InvalidScopeError);
    expect(systemClock.now()).toBeInstanceOf(Date);
  });
});
