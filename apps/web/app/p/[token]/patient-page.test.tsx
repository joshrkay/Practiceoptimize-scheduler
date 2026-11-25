import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from '../../../../../tests/fixtures/cases/bunionectomy-podiatry.json';
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
} from '../../../../api/src/patient-page/fakes';
import type { CaseSource } from '../../../../api/src/patient-page/ports';
import { DEFAULT_CONFIG, PatientPageService } from '../../../../api/src/patient-page/service';
import { handlePatientAction } from './actions';
import { CasePage } from './case-page';
import { featureFlagEnabled, getPatientPageDeps, SESSION_COOKIE, setPatientPageDeps } from './deps';
import { formatDate, formatTime, messages, parseLocale } from './messages';

let cookieValue: string | undefined;
vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ get: () => (cookieValue ? { value: cookieValue } : undefined) }),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

const { default: PatientPage } = await import('./page');
const { POST } = await import('./[action]/route');

const source = fixture as unknown as CaseSource;
const DOB = '1971-08-19';

let enabled = true;
let service: PatientPageService;
let delivery: FakeLinkDelivery;
let audit: FakeAudit;
let changePlans: FakeChangePlans;
let contacts: FakeContacts;

beforeEach(() => {
  cookieValue = undefined;
  enabled = true;
  delivery = new FakeLinkDelivery();
  audit = new FakeAudit();
  changePlans = new FakeChangePlans();
  contacts = new FakeContacts([
    { id: 'c1', displayName: 'Sam (spouse)', relationship: 'spouse', enabledMessageTypes: ['billing'] },
  ]);
  service = new PatientPageService(
    {
      links: new InMemoryLinkStore(),
      sessions: new InMemorySessionStore(),
      identity: new FakeIdentity({ [source.caseId]: DOB }),
      cases: new FakeCaseRead({ [source.caseId]: source }),
      contacts,
      slots: new FakeSlots(
        [1, 2, 3].map((n) => ({
          id: `s${n}`,
          startsAt: `2026-04-0${n}T13:00:00Z`,
          timeZone: 'America/Chicago',
          facilityName: 'Lakeside',
        })),
      ),
      changePlans,
      financial: new FakeFinancialLinks({
        quoteUrl: 'https://pay.example.com/quote/1',
        financialConsentUrl: 'https://sign.example.com/c/1',
        depositUrl: 'https://pay.example.com/deposit/1',
      }),
      audit,
      scheduler: new FakeNotifier(),
      delivery,
      clock: new FakeClock(),
    },
    { ...DEFAULT_CONFIG, baseUrl: 'https://care.example.com' },
  );
  setPatientPageDeps({ service, isEnabled: () => enabled });
});

const issue = () => service.issueLink({ practiceId: source.practiceId, caseId: source.caseId });

async function render(token: string, query: Record<string, string> = {}) {
  const element = await PatientPage({
    params: Promise.resolve({ token }),
    searchParams: Promise.resolve(query),
  });
  return renderToStaticMarkup(element);
}

function post(token: string, action: string, fields: [string, string][], cookie?: string) {
  const body = new URLSearchParams(fields);
  return POST(
    new Request(`https://care.example.com/p/${token}/${action}`, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
    }),
    { params: Promise.resolve({ token, action }) },
  );
}

async function sessionFor(token: string): Promise<string> {
  const res = await post(token, 'verify', [['dob', DOB]]);
  return /patient_page_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')![1]!;
}

describe('messages', () => {
  it('has the same keys in English and Spanish', () => {
    expect(Object.keys(messages.es).sort()).toEqual(Object.keys(messages.en).sort());
    expect(Object.keys(messages.es.messageTypes).sort()).toEqual(Object.keys(messages.en.messageTypes).sort());
    expect(messages.en.wrongDob(1)).toContain('1 try');
    expect(messages.en.wrongDob(3)).toContain('3 tries');
    expect(messages.es.wrongDob(1)).toContain('1 intento ');
    expect(messages.es.wrongDob(3)).toContain('3 intentos');
  });

  it('parses locales and formats dates in each language', () => {
    expect(parseLocale('es')).toBe('es');
    expect(parseLocale('fr')).toBeNull();
    expect(formatDate('2026-03-24', 'en')).toContain('March');
    expect(formatDate('2026-03-24', 'es')).toContain('marzo');
    expect(formatTime('06:30', 'en')).toMatch(/6:30/);
  });
});

describe('feature flag and registry', () => {
  it('defaults the flag to off', () => {
    expect(featureFlagEnabled({})).toBe(false);
    expect(featureFlagEnabled({ FEATURE_PATIENT_CASE_PAGE: 'true' })).toBe(true);
  });

  it('returns not found when the flag is off or nothing is wired', async () => {
    enabled = false;
    await expect(render('x.y')).rejects.toThrow('NEXT_NOT_FOUND');
    setPatientPageDeps(null);
    expect(getPatientPageDeps()).toBeNull();
    await expect(render('x.y')).rejects.toThrow('NEXT_NOT_FOUND');
    expect((await post('x.y', 'verify', [])).status).toBe(404);
  });
});

describe('page rendering', () => {
  it('asks for date of birth first and shows no case details', async () => {
    const { token } = await issue();
    const html = await render(token);
    expect(html).toContain('Confirm it is you');
    expect(html).toContain('type="date"');
    expect(html).toContain('<label for="dob">');
    expect(html).not.toContain('Lakeside');
    expect(html).not.toContain('Rivera');
  });

  it('shows remaining attempts after a wrong date of birth', async () => {
    const { token } = await issue();
    const res = await post(token, 'verify', [['dob', '1999-01-01']]);
    expect(res.headers.get('location')).toContain('e=dob&r=4');
    const html = await render(token, { e: 'dob', r: '4' });
    expect(html).toContain('role="alert"');
    expect(html).toContain('4 tries left');
  });

  it('shows how to request a new link for an expired or unknown link', async () => {
    const html = await render('unknown.token');
    expect(html).toContain('We could not find this link');
    expect(html).toContain('Request a new link');
    expect(html).not.toContain('Lakeside');
    const sent = await render('unknown.token', { sent: '1' });
    expect(sent).toContain('is on its way');
  });

  it('shows the case after verification, in English, with the view audited', async () => {
    const { token } = await issue();
    const cookie = await sessionFor(token);
    cookieValue = cookie;
    const html = await render(token);
    expect(html).toContain('lang="en"');
    expect(html).toContain('Lakeside Foot and Ankle Surgery Center');
    expect(html).toContain('Free lot behind the building');
    expect(html).toContain('Dr. Alex Rivera');
    expect(html).toContain('tel:555');
    expect(html).toContain('Sign your consent forms');
    expect(html).toContain('Done');
    expect(html).toContain('To do');
    expect(html).toContain('Arrange a ride home');
    expect(html).toContain('href="https://pay.example.com/deposit/1"');
    expect(html).toContain('Sam (spouse)');
    expect(html).toContain('Skip to main content');
    expect(audit.events.map((e) => e.action)).toContain('patient_page.viewed');
    for (const secret of ['SYN-889-4471', 'M20.12', 'case-pod-0002', 'AUTH-77120', '1971']) {
      expect(html).not.toContain(secret);
    }
  });

  it('renders in Spanish on request and links back to English', async () => {
    const { token } = await issue();
    cookieValue = await sessionFor(token);
    const html = await render(token, { lang: 'es' });
    expect(html).toContain('lang="es"');
    expect(html).toContain('Firme sus formularios de consentimiento');
    expect(html).toContain('Su cirugía');
    expect(html).toContain('English');
  });

  it('shows three slots when rescheduling and thanks the patient after a request', async () => {
    const { token } = await issue();
    const cookie = await sessionFor(token);
    cookieValue = cookie;
    const html = await render(token, { reschedule: '1', requested: '1', saved: '1' });
    expect(html.match(/name="slotId"/g)).toHaveLength(3);
    expect(html).toContain('approves any change');
    expect(html).toContain('sent to your care team for approval');
    expect(html).toContain('Your choices were saved');
  });

  it('shows the end-of-session message when the cookie is stale', async () => {
    const { token } = await issue();
    cookieValue = await sessionFor(token);
    const html = await render(token);
    expect(html).toContain('Lakeside');
    cookieValue = 'bad.cookie';
    const stale = await render(token);
    expect(stale).toContain('your session ended');
    expect(stale).not.toContain('Lakeside');
  });
});

describe('case page component states', () => {
  const base = { token: 't', locale: 'en' as const };
  it('renders empty and locked states', () => {
    const html = renderToStaticMarkup(
      <CasePage {...base} state={{ kind: 'unavailable', reason: 'locked', requested: false }} />,
    );
    expect(html).toContain('locked');
    const view = {
      locale: 'en' as const,
      paymentClass: 'insured' as const,
      procedureDate: '2026-03-24',
      arrivalTime: '06:30',
      facility: { name: 'F', address: 'A', parking: 'P' },
      surgeon: 'S',
      locationPhone: '555-0100',
      checklist: [],
      openItems: [],
    };
    const caseHtml = renderToStaticMarkup(
      <CasePage
        {...base}
        state={{
          kind: 'case',
          saved: false,
          slotRequested: false,
          data: { view, contacts: [], proposedSlots: [], financial: null },
        }}
      />,
    );
    expect(caseHtml).toContain('Nothing is needed from you right now');
    expect(caseHtml).toContain('No other dates are available');
    expect(caseHtml).not.toContain('Cost and payment');
    expect(caseHtml).not.toContain('Who gets which messages');
  });
});

describe('form actions', () => {
  it('verifies and sets a separate, locked-down page cookie', async () => {
    const { token } = await issue();
    const res = await post(token, 'verify', [['dob', DOB]]);
    expect(res.status).toBe(303);
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain(`Path=/p/${token}`);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('redirects without a cookie when the link is unusable and tolerates a missing dob', async () => {
    const res = await post('nope.nope', 'verify', []);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('location')).toBe('/p/nope.nope');
  });

  it('requests a new link', async () => {
    const { token } = await issue();
    const res = await post(token, 'request-link', [['lang', 'es']]);
    expect(res.headers.get('location')).toBe(`/p/${token}?sent=1&lang=es`);
  });

  it('saves contact choices and rejects without a session', async () => {
    const { token } = await issue();
    const cookie = `other=1; ${SESSION_COOKIE}=${await sessionFor(token)}`;
    const res = await post(token, 'contacts', [['contactId', 'c1'], ['types', 'forms_and_consents'], ['types', 'billing']], cookie);
    expect(res.headers.get('location')).toBe(`/p/${token}?saved=1`);
    expect(contacts.contacts[0]!.enabledMessageTypes).toEqual(['forms_and_consents', 'billing']);
    const none = await post(token, 'contacts', [['contactId', 'c1']]);
    expect(none.headers.get('location')).toBe(`/p/${token}`);
  });

  it('turns a slot choice into a change plan only', async () => {
    const { token } = await issue();
    const cookie = `${SESSION_COOKIE}=${await sessionFor(token)}`;
    const ok = await post(token, 'choose-slot', [['slotId', 's2']], cookie);
    expect(ok.headers.get('location')).toBe(`/p/${token}?requested=1`);
    expect(changePlans.created).toHaveLength(1);
    const bad = await post(token, 'choose-slot', [['slotId', 'nope']], cookie);
    expect(bad.headers.get('location')).toBe(`/p/${token}`);
    const none = await post(token, 'choose-slot', [['slotId', 's1']]);
    expect(none.headers.get('location')).toBe(`/p/${token}`);
    expect(changePlans.created).toHaveLength(1);
  });

  it('returns 404 for unknown actions and never reflects raw tokens into headers', async () => {
    const { token } = await issue();
    expect((await post(token, 'delete', [])).status).toBe(404);
    const res = await handlePatientAction(
      new Request('https://x/p', { method: 'POST', body: new URLSearchParams() }),
      'a\r\nSet-Cookie: x=1',
      'request-link',
    );
    expect(res.headers.get('location')).not.toContain('\r');
    expect(delivery.sent).toHaveLength(0);
  });
});
