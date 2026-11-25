import { describe, expect, it } from 'vitest';
import fixture from '../../../../tests/fixtures/cases/bunionectomy-podiatry.json';
import {
  FakeAudit,
  FakeCaseRead,
  FakeChangePlans,
  FakeClock,
  FakeContacts,
  FakeFinancialLinks,
  FakeIdentity,
  FakeLinkDelivery,
  FakeNotifier,
  FakeSlots,
  InMemoryLinkStore,
  InMemorySessionStore,
} from './fakes.js';
import type { CaseSource } from './ports.js';
import { configFromEnv, DEFAULT_CONFIG, PatientPageService } from './service.js';
import { generateToken, parseToken, safeEqual } from './tokens.js';
import { toPatientCaseView } from './view-model.js';

const source = fixture as unknown as CaseSource;
const DOB = '1971-08-19';

function setup(overrides: Partial<CaseSource> = {}) {
  const clock = new FakeClock();
  const links = new InMemoryLinkStore();
  const sessions = new InMemorySessionStore();
  const audit = new FakeAudit();
  const scheduler = new FakeNotifier();
  const delivery = new FakeLinkDelivery();
  const changePlans = new FakeChangePlans();
  const contacts = new FakeContacts([
    { id: 'c1', displayName: 'Sam (spouse)', relationship: 'spouse', enabledMessageTypes: ['appointment_reminders'] },
  ]);
  const slots = new FakeSlots(
    [1, 2, 3, 4].map((n) => ({ id: `s${n}`, startsAt: `2026-04-0${n}T07:00:00Z`, timeZone: 'America/Chicago', facilityName: 'Lakeside' })),
  );
  const financial = new FakeFinancialLinks({
    quoteUrl: 'https://pay.example.com/quote/1',
    financialConsentUrl: 'https://sign.example.com/c/1',
    depositUrl: 'http://insecure.example.com/dep',
  });
  const service = new PatientPageService(
    {
      links,
      sessions,
      identity: new FakeIdentity({ [source.caseId]: DOB }),
      cases: new FakeCaseRead({ [source.caseId]: { ...source, ...overrides } }),
      contacts,
      slots,
      changePlans,
      financial,
      audit,
      scheduler,
      delivery,
      clock,
    },
    { ...DEFAULT_CONFIG, baseUrl: 'https://care.example.com' },
  );
  const issue = () => service.issueLink({ practiceId: source.practiceId, caseId: source.caseId });
  return { service, clock, links, sessions, audit, scheduler, delivery, changePlans, contacts, issue };
}

async function verified(ctx: ReturnType<typeof setup>) {
  const { token } = await ctx.issue();
  const result = await ctx.service.verify(token, DOB);
  if (result.status !== 'verified') throw new Error('expected verified');
  return result.sessionToken;
}

describe('tokens', () => {
  it('generates unique 256-bit tokens and stores only a hash', async () => {
    const a = generateToken();
    const b = generateToken();
    expect(a.token).not.toBe(b.token);
    expect(a.token).not.toContain(a.secretHash);
    expect(parseToken(a.token)?.id).toBe(a.id);
    const ctx = setup();
    const { token } = await ctx.issue();
    const stored = [...ctx.links.links.values()][0]!;
    expect(JSON.stringify(stored)).not.toContain(parseToken(token)!.secret);
  });

  it('rejects malformed tokens and compares in constant time form', () => {
    expect(parseToken('nodot')).toBeNull();
    expect(parseToken('.x')).toBeNull();
    expect(parseToken('x.')).toBeNull();
    expect(parseToken(`a.${'b'.repeat(300)}`)).toBeNull();
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('config', () => {
  it('reads PATIENT_LINK_TTL_HOURS with a 72 hour default', () => {
    expect(configFromEnv({}, 'https://x').linkTtlHours).toBe(72);
    expect(configFromEnv({ PATIENT_LINK_TTL_HOURS: '24' }, 'https://x').linkTtlHours).toBe(24);
    expect(configFromEnv({ PATIENT_LINK_TTL_HOURS: 'bad' }, 'https://x').linkTtlHours).toBe(72);
  });
});

describe('access: verified patient sees their case (scenario 1)', () => {
  it('verifies, opens the page and audits the view', async () => {
    const ctx = setup();
    const session = await verified(ctx);
    const result = await ctx.service.viewCase(session);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data.view.procedureDate).toBe('2026-03-24');
    expect(result.data.view.arrivalTime).toBe('06:30');
    expect(result.data.view.checklist.length).toBe(3);
    expect(ctx.audit.events.map((e) => e.action)).toContain('patient_page.viewed');
    expect(ctx.audit.events.map((e) => e.action)).toContain('patient_link.verified');
  });

  it('keeps date of birth out of audit events', async () => {
    const ctx = setup();
    await ctx.service.verify((await ctx.issue()).token, '2000-01-01');
    expect(JSON.stringify(ctx.audit.events)).not.toContain('2000-01-01');
    expect(JSON.stringify(ctx.audit.events)).not.toContain(DOB);
  });

  it('fails closed when the view cannot be audited', async () => {
    const ctx = setup();
    const session = await verified(ctx);
    ctx.audit.failNext = true;
    await expect(ctx.service.viewCase(session)).rejects.toThrow('audit unavailable');
  });

  it('expires the page session after its short life', async () => {
    const ctx = setup();
    const session = await verified(ctx);
    ctx.clock.advanceMinutes(31);
    expect(await ctx.service.viewCase(session)).toEqual({ status: 'session_expired' });
  });

  it('rejects forged or malformed session tokens', async () => {
    const ctx = setup();
    const session = await verified(ctx);
    const id = parseToken(session)!.id;
    expect(await ctx.service.viewCase(`${id}.forged`)).toEqual({ status: 'session_expired' });
    expect(await ctx.service.viewCase('garbage')).toEqual({ status: 'session_expired' });
    expect(await ctx.service.viewCase('unknown.secret')).toEqual({ status: 'session_expired' });
  });

  it('does not accept a link token as a session token', async () => {
    const ctx = setup();
    const { token } = await ctx.issue();
    expect(await ctx.service.viewCase(token)).toEqual({ status: 'session_expired' });
  });

  it('returns session_expired when the case is gone', async () => {
    const ctx = setup();
    const session = await verified(ctx);
    ctx.sessions.sessions.forEach((s) => (s.caseId = 'missing'));
    expect(await ctx.service.viewCase(session)).toEqual({ status: 'session_expired' });
  });
});

describe('access: expired or misused links (scenario 2)', () => {
  it('rejects an expired link and shows nothing', async () => {
    const ctx = setup();
    const { token } = await ctx.issue();
    ctx.clock.advanceMinutes(72 * 60 + 1);
    expect(await ctx.service.inspectLink(token)).toEqual({ status: 'unavailable', reason: 'expired' });
    expect(await ctx.service.verify(token, DOB)).toEqual({ status: 'unavailable', reason: 'expired' });
    expect(ctx.sessions.sessions.size).toBe(0);
  });

  it('is single use: a second verification is refused', async () => {
    const ctx = setup();
    const { token } = await ctx.issue();
    expect((await ctx.service.verify(token, DOB)).status).toBe('verified');
    expect(await ctx.service.verify(token, DOB)).toEqual({ status: 'unavailable', reason: 'used' });
    expect(await ctx.service.inspectLink(token)).toEqual({ status: 'unavailable', reason: 'used' });
  });

  it('lets only one of two concurrent correct verifications win', async () => {
    const ctx = setup();
    const { token } = await ctx.issue();
    const results = await Promise.all([ctx.service.verify(token, DOB), ctx.service.verify(token, DOB)]);
    expect(results.filter((r) => r.status === 'verified')).toHaveLength(1);
  });

  it('reports a consume race lost after DOB check as used', async () => {
    const ctx = setup();
    const { token } = await ctx.issue();
    const link = [...ctx.links.links.values()][0]!;
    ctx.links.consume = () => Promise.resolve(false);
    expect(link.usedAt).toBeNull();
    expect(await ctx.service.verify(token, DOB)).toEqual({ status: 'unavailable', reason: 'used' });
  });

  it('counts wrong attempts, then locks on the fifth and notifies the scheduler', async () => {
    const ctx = setup();
    const { token } = await ctx.issue();
    for (let i = 1; i <= 4; i += 1) {
      expect(await ctx.service.verify(token, '1999-01-01')).toEqual({
        status: 'wrong_dob',
        attemptsRemaining: 5 - i,
      });
    }
    expect(ctx.scheduler.sent).toHaveLength(0);
    expect(await ctx.service.verify(token, '1999-01-01')).toEqual({ status: 'unavailable', reason: 'locked' });
    expect(ctx.scheduler.sent).toEqual([{ caseId: source.caseId, kind: 'patient_link_locked' }]);
    // Even the right date of birth no longer works.
    expect(await ctx.service.verify(token, DOB)).toEqual({ status: 'unavailable', reason: 'locked' });
    expect(ctx.sessions.sessions.size).toBe(0);
    expect(ctx.scheduler.sent).toHaveLength(1);
    expect(ctx.audit.events.map((e) => e.action)).toContain('patient_link.locked');
  });

  it('treats a badly formatted date of birth as a failed attempt', async () => {
    const ctx = setup();
    const { token } = await ctx.issue();
    expect((await ctx.service.verify(token, '08/19/1971')).status).toBe('wrong_dob');
  });

  it('treats unknown date of birth on file as failure', async () => {
    const ctx = setup();
    const { token } = await ctx.issue();
    [...ctx.links.links.values()][0]!.caseId = 'no-dob';
    expect((await ctx.service.verify(token, DOB)).status).toBe('wrong_dob');
  });

  it('treats a wrong secret or unknown link as invalid without auditing a case', async () => {
    const ctx = setup();
    const { token } = await ctx.issue();
    const id = parseToken(token)!.id;
    const before = ctx.audit.events.length;
    expect(await ctx.service.verify(`${id}.wrong`, DOB)).toEqual({ status: 'unavailable', reason: 'invalid' });
    expect(await ctx.service.verify('nope', DOB)).toEqual({ status: 'unavailable', reason: 'invalid' });
    expect(await ctx.service.inspectLink('nope')).toEqual({ status: 'unavailable', reason: 'invalid' });
    expect(ctx.audit.events.length).toBe(before);
  });

  it('inspects a good link as needing verification', async () => {
    const ctx = setup();
    const { token } = await ctx.issue();
    expect(await ctx.service.inspectLink(token)).toEqual({ status: 'needs_verification' });
  });
});

describe('request a new link', () => {
  it('sends a fresh link to the contact on file for an expired link, and retires the old one', async () => {
    const ctx = setup();
    const { token } = await ctx.issue();
    ctx.clock.advanceMinutes(72 * 60 + 1);
    expect(await ctx.service.requestNewLink(token)).toEqual({ status: 'accepted' });
    expect(ctx.delivery.sent).toHaveLength(1);
    const newToken = ctx.delivery.sent[0]!.url.split('/p/')[1]!;
    expect(await ctx.service.inspectLink(newToken)).toEqual({ status: 'needs_verification' });
    expect(await ctx.service.inspectLink(token)).toEqual({ status: 'unavailable', reason: 'used' });
  });

  it('gives the same answer for unknown links and sends nothing', async () => {
    const ctx = setup();
    expect(await ctx.service.requestNewLink('nope.nope')).toEqual({ status: 'accepted' });
    expect(ctx.delivery.sent).toHaveLength(0);
  });

  it('routes locked links to the scheduler instead of sending a link', async () => {
    const ctx = setup();
    const { token } = await ctx.issue();
    for (let i = 0; i < 5; i += 1) await ctx.service.verify(token, '1999-01-01');
    await ctx.service.requestNewLink(token);
    expect(ctx.delivery.sent).toHaveLength(0);
    expect(ctx.scheduler.sent.map((s) => s.kind)).toEqual([
      'patient_link_locked',
      'patient_link_reissue_requested',
    ]);
  });

  it('throttles repeated requests within the cooldown', async () => {
    const ctx = setup();
    const { token } = await ctx.issue();
    await ctx.service.requestNewLink(token);
    expect(ctx.delivery.sent).toHaveLength(0);
    ctx.clock.advanceMinutes(11);
    await ctx.service.requestNewLink(token);
    expect(ctx.delivery.sent).toHaveLength(1);
  });
});

describe('contacts, reschedule and financial links', () => {
  it('saves message types for an authorized contact and rejects the rest', async () => {
    const ctx = setup();
    const session = await verified(ctx);
    expect(await ctx.service.saveContactPreferences(session, 'c1', ['billing', 'billing'])).toEqual({ status: 'ok' });
    expect(ctx.contacts.contacts[0]!.enabledMessageTypes).toEqual(['billing']);
    expect(await ctx.service.saveContactPreferences(session, 'c1', ['marketing'])).toEqual({ status: 'rejected' });
    expect(await ctx.service.saveContactPreferences(session, 'stranger', ['billing'])).toEqual({ status: 'rejected' });
    expect(await ctx.service.saveContactPreferences('bad', 'c1', [])).toEqual({ status: 'session_expired' });
  });

  it('offers at most three slots and a choice only creates a change plan for approval', async () => {
    const ctx = setup();
    const session = await verified(ctx);
    const view = await ctx.service.viewCase(session, { includeSlots: true });
    if (view.status !== 'ok') throw new Error('expected ok');
    expect(view.data.proposedSlots).toHaveLength(3);
    expect(await ctx.service.chooseSlot(session, 's2')).toEqual({ status: 'requested', changePlanId: 'plan-1' });
    expect(ctx.changePlans.created).toEqual([{ caseId: source.caseId, slot: expect.objectContaining({ id: 's2' }) }]);
    // The fourth slot was never offered.
    expect(await ctx.service.chooseSlot(session, 's4')).toEqual({ status: 'rejected' });
    expect(await ctx.service.chooseSlot(session, 'nope')).toEqual({ status: 'rejected' });
    expect(await ctx.service.chooseSlot('bad', 's1')).toEqual({ status: 'session_expired' });
    expect(ctx.changePlans.created).toHaveLength(1);
  });

  it('shows no slots unless asked for', async () => {
    const ctx = setup();
    const view = await ctx.service.viewCase(await verified(ctx));
    if (view.status !== 'ok') throw new Error('expected ok');
    expect(view.data.proposedSlots).toBeNull();
  });

  it('returns https financial links only for self-pay and mixed cases', async () => {
    const mixed = setup();
    const view = await mixed.service.viewCase(await verified(mixed));
    if (view.status !== 'ok') throw new Error('expected ok');
    expect(view.data.financial).toEqual({
      quoteUrl: 'https://pay.example.com/quote/1',
      financialConsentUrl: 'https://sign.example.com/c/1',
      depositUrl: null,
    });
    const insured = setup({ paymentClass: 'insured' });
    const v2 = await insured.service.viewCase(await verified(insured));
    if (v2.status !== 'ok') throw new Error('expected ok');
    expect(v2.data.financial).toBeNull();
  });
});

describe('view model allowlist', () => {
  it('never exposes insurance, diagnosis codes, other cases or internal fields', () => {
    const view = toPatientCaseView(source);
    const json = JSON.stringify(view);
    for (const secret of [
      'SYN-889-4471',
      'GRP-5521',
      'Synthetic Health Plan',
      'M20.12',
      '28296',
      'case-pod-0002',
      'hammertoe',
      'anxious',
      'AUTH-77120',
      '1971-08-19',
      'Synthetic Patient',
      'bunionectomy',
      '1111111111',
      '555-0100',
      '555-0143',
      'contractRate',
      'Implant on order',
    ]) {
      expect(json).not.toContain(secret);
    }
    expect(Object.keys(view).sort()).toEqual(
      [
        'arrivalTime',
        'checklist',
        'facility',
        'locale',
        'locationPhone',
        'openItems',
        'paymentClass',
        'procedureDate',
        'surgeon',
      ].sort(),
    );
    expect(Object.keys(view.facility).sort()).toEqual(['address', 'name', 'parking']);
  });

  it('maps statuses, patient-owned open items and localizes labels with fallback', () => {
    const en = toPatientCaseView(source);
    expect(en.openItems.map((i) => i.id)).toEqual(['ri-forms', 'ri-ride']);
    expect(en.checklist.find((i) => i.id === 'ri-auth')?.status).toBe('done');
    const es = toPatientCaseView(source, 'es');
    expect(es.checklist[0]?.label).toBe('Firme sus formularios de consentimiento');
    expect(es.checklist.find((i) => i.id === 'ri-auth')?.label).toBe('Insurance approval');
    expect(es.surgeon).toBe('Dr. Alex Rivera');
    expect(es.locationPhone).toBe('555-0142');
  });

  it('treats waived items as done', () => {
    const view = toPatientCaseView({
      ...source,
      readinessItems: [
        { id: 'w', patientLabel: { en: 'W' }, status: 'waived', owner: 'patient', patientVisible: true },
      ],
    });
    expect(view.openItems).toEqual([]);
  });
});
