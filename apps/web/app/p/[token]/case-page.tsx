import type { PatientPageData, LinkUnavailableReason } from '../../../../api/src/patient-page/service';
import {
  formatDate,
  formatDateTime,
  formatTime,
  messages,
  type Locale,
  type Messages,
} from './messages';

export type PageState =
  | { kind: 'verify'; attemptsRemaining: number | null }
  | { kind: 'unavailable'; reason: LinkUnavailableReason | 'session_ended'; requested: boolean }
  | { kind: 'case'; data: PatientPageData; saved: boolean; slotRequested: boolean };

export interface CasePageProps {
  token: string;
  locale: Locale;
  state: PageState;
}

const styles = `
.pp{--fg:#14213d;--muted:#46536b;--bg:#f7f8fb;--card:#fff;--line:#c9d0dc;--accent:#0b57d0;--ok:#146c2e;--todo:#8a4b00;
  font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--fg);background:var(--bg);line-height:1.5;
  min-height:100vh;padding:16px}
.pp *{box-sizing:border-box}
.pp main{max-width:40rem;margin:0 auto}
.pp section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:16px 0}
.pp h1{font-size:1.5rem;margin:8px 0}.pp h2{font-size:1.2rem;margin:0 0 8px}
.pp dl{margin:0}.pp dt{font-weight:600;color:var(--muted);margin-top:12px}.pp dd{margin:0;font-size:1.1rem}
.pp ul{list-style:none;padding:0;margin:0}.pp li{padding:10px 0;border-top:1px solid var(--line);display:flex;gap:12px;justify-content:space-between}
.pp li:first-child{border-top:0}
.pp .done{color:var(--ok);font-weight:600}.pp .todo{color:var(--todo);font-weight:600}
.pp label{display:block;font-weight:600;margin:12px 0 4px}
.pp input[type=date]{font:inherit;min-height:48px;padding:8px;border:2px solid var(--muted);border-radius:8px;width:100%}
.pp .check{display:flex;align-items:center;gap:12px;min-height:44px;font-weight:400;margin:0}
.pp input[type=checkbox]{width:24px;height:24px}
.pp button,.pp a.btn{display:inline-block;min-height:48px;padding:12px 20px;margin-top:12px;font:inherit;font-weight:600;color:#fff;
  background:var(--accent);border:0;border-radius:8px;text-decoration:none;cursor:pointer}
.pp a{color:var(--accent)}
.pp a.btn{color:#fff}
.pp :focus-visible{outline:3px solid #000;outline-offset:2px}
.pp .skip{position:absolute;left:-999px}.pp .skip:focus{left:8px;top:8px;background:#fff;padding:8px;z-index:1}
.pp .note{color:var(--muted)}.pp .alert{border-left:4px solid var(--todo)}
`;

function RequestLink({ token, t }: { token: string; t: Messages }) {
  return (
    <section aria-labelledby="req-h">
      <h2 id="req-h">{t.requestLinkHeading}</h2>
      <p>{t.requestLinkBody}</p>
      <form method="post" action={`/p/${token}/request-link`}>
        <button type="submit">{t.requestLinkButton}</button>
      </form>
    </section>
  );
}

function Verify({ token, t, remaining }: { token: string; t: Messages; remaining: number | null }) {
  return (
    <section aria-labelledby="verify-h">
      <h1 id="verify-h">{t.verifyHeading}</h1>
      <p>{t.verifyIntro}</p>
      {remaining !== null && (
        <p role="alert" className="alert">
          {t.wrongDob(remaining)}
        </p>
      )}
      <form method="post" action={`/p/${token}/verify`}>
        <label htmlFor="dob">{t.dobLabel}</label>
        <input id="dob" name="dob" type="date" required autoComplete="bday" aria-describedby="dob-hint" />
        <p id="dob-hint" className="note">
          {t.dobHint}
        </p>
        <button type="submit">{t.verifyButton}</button>
      </form>
    </section>
  );
}

function Unavailable({
  token,
  t,
  reason,
  requested,
}: {
  token: string;
  t: Messages;
  reason: LinkUnavailableReason | 'session_ended';
  requested: boolean;
}) {
  const text = {
    expired: t.unavailableExpired,
    used: t.unavailableUsed,
    locked: t.unavailableLocked,
    invalid: t.unavailableInvalid,
    session_ended: t.sessionEndedNote,
  }[reason];
  return (
    <>
      <section aria-labelledby="unavail-h">
        <h1 id="unavail-h">{t.unavailableHeading}</h1>
        <p role="alert">{text}</p>
      </section>
      {requested ? (
        <section aria-live="polite">
          <p>{t.requestLinkSent}</p>
        </section>
      ) : (
        <RequestLink token={token} t={t} />
      )}
    </>
  );
}

function Checkmark({ done, t }: { done: boolean; t: Messages }) {
  return (
    <span className={done ? 'done' : 'todo'}>
      <span aria-hidden="true">{done ? '✓ ' : '○ '}</span>
      {done ? t.statusDone : t.statusTodo}
    </span>
  );
}

function CaseDetails({ token, locale, t, state }: { token: string; locale: Locale; t: Messages; state: Extract<PageState, { kind: 'case' }> }) {
  const { view, contacts, proposedSlots, financial } = state.data;
  return (
    <>
      <section aria-labelledby="case-h">
        <h1 id="case-h">{t.caseHeading}</h1>
        <dl>
          <dt>{t.dateLabel}</dt>
          <dd>{formatDate(view.procedureDate, locale)}</dd>
          <dt>{t.arrivalLabel}</dt>
          <dd>{formatTime(view.arrivalTime, locale)}</dd>
          <dt>{t.locationLabel}</dt>
          <dd>
            {view.facility.name}
            <br />
            {view.facility.address}
          </dd>
          <dt>{t.parkingLabel}</dt>
          <dd>{view.facility.parking}</dd>
          <dt>{t.surgeonLabel}</dt>
          <dd>{view.surgeon}</dd>
          <dt>{t.phoneLabel}</dt>
          <dd>
            <a href={`tel:${view.locationPhone.replace(/[^+\d]/g, '')}`}>{view.locationPhone}</a>
          </dd>
        </dl>
      </section>

      <section aria-labelledby="open-h">
        <h2 id="open-h">{t.openItemsHeading}</h2>
        {view.openItems.length === 0 ? (
          <p>{t.noOpenItems}</p>
        ) : (
          <ul>
            {view.openItems.map((item) => (
              <li key={item.id}>{item.label}</li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="check-h">
        <h2 id="check-h">{t.checklistHeading}</h2>
        <ul>
          {view.checklist.map((item) => (
            <li key={item.id}>
              <span>{item.label}</span>
              <Checkmark done={item.status === 'done'} t={t} />
            </li>
          ))}
        </ul>
      </section>

      {financial && (
        <section aria-labelledby="fin-h">
          <h2 id="fin-h">{t.financialHeading}</h2>
          <p className="note">{t.externalLinkNote}</p>
          {financial.quoteUrl && (
            <p>
              <a className="btn" href={financial.quoteUrl} rel="noopener noreferrer">
                {t.viewQuote}
              </a>
            </p>
          )}
          {financial.financialConsentUrl && (
            <p>
              <a className="btn" href={financial.financialConsentUrl} rel="noopener noreferrer">
                {t.signConsent}
              </a>
            </p>
          )}
          {financial.depositUrl && (
            <p>
              <a className="btn" href={financial.depositUrl} rel="noopener noreferrer">
                {t.payDeposit}
              </a>
            </p>
          )}
        </section>
      )}

      <section aria-labelledby="resched-h">
        <h2 id="resched-h">{t.rescheduleHeading}</h2>
        <p>{t.rescheduleIntro}</p>
        {state.slotRequested && <p role="status">{t.rescheduleRequested}</p>}
        {proposedSlots === null ? (
          <p>
            <a className="btn" href={`/p/${token}?reschedule=1&lang=${locale}`}>
              {t.rescheduleStart}
            </a>
          </p>
        ) : proposedSlots.length === 0 ? (
          <p>{t.noSlots}</p>
        ) : (
          <>
            <ul>
              {proposedSlots.map((slot) => (
                <li key={slot.id}>
                  <span>{formatDateTime(slot.startsAt, slot.timeZone, locale)}</span>
                  <form method="post" action={`/p/${token}/choose-slot`}>
                    <input type="hidden" name="slotId" value={slot.id} />
                    <input type="hidden" name="lang" value={locale} />
                    <button type="submit" style={{ marginTop: 0 }}>
                      {t.rescheduleChoose}
                    </button>
                  </form>
                </li>
              ))}
            </ul>
            <p className="note">{t.rescheduleNote}</p>
          </>
        )}
      </section>

      {contacts.length > 0 && (
        <section aria-labelledby="contacts-h">
          <h2 id="contacts-h">{t.contactsHeading}</h2>
          <p>{t.contactsIntro}</p>
          {state.saved && <p role="status">{t.saved}</p>}
          {contacts.map((contact) => (
            <form key={contact.id} method="post" action={`/p/${token}/contacts`}>
              <fieldset style={{ border: 0, padding: 0, margin: '12px 0 0' }}>
                <legend style={{ fontWeight: 600 }}>
                  {contact.displayName}
                </legend>
                <input type="hidden" name="contactId" value={contact.id} />
                <input type="hidden" name="lang" value={locale} />
                {Object.entries(t.messageTypes).map(([type, text]) => (
                  <label key={type} className="check">
                    <input
                      type="checkbox"
                      name="types"
                      value={type}
                      defaultChecked={(contact.enabledMessageTypes as string[]).includes(type)}
                    />
                    {text}
                  </label>
                ))}
              </fieldset>
              <button type="submit">{t.saveContact}</button>
            </form>
          ))}
        </section>
      )}
    </>
  );
}

/** Server-rendered, no client JavaScript required. */
export function CasePage({ token, locale, state }: CasePageProps) {
  const t = messages[locale];
  const other = locale === 'en' ? 'es' : 'en';
  return (
    <div className="pp" lang={locale}>
      <style>{styles}</style>
      <a className="skip" href="#content">
        {t.skipToContent}
      </a>
      <header style={{ maxWidth: '40rem', margin: '0 auto' }}>
        <p className="note">
          {t.pageTitle} ·{' '}
          <a href={`/p/${token}?lang=${other}`} lang={other} hrefLang={other}>
            {t.languageSwitch}
          </a>
        </p>
      </header>
      <main id="content">
        {state.kind === 'verify' && <Verify token={token} t={t} remaining={state.attemptsRemaining} />}
        {state.kind === 'unavailable' && (
          <Unavailable token={token} t={t} reason={state.reason} requested={state.requested} />
        )}
        {state.kind === 'case' && <CaseDetails token={token} locale={locale} t={t} state={state} />}
      </main>
    </div>
  );
}
