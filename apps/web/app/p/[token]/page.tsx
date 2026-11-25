import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { CasePage, type PageState } from './case-page';
import { getPatientPageDeps, SESSION_COOKIE } from './deps';
import { parseLocale, type Locale } from './messages';

/** The token is in the URL: keep it out of referrers and search engines. */
export const metadata = {
  title: 'Your surgery details',
  referrer: 'no-referrer' as const,
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function PatientPage({ params, searchParams }: PageProps) {
  const deps = getPatientPageDeps();
  if (!deps || !deps.isEnabled()) notFound();

  const { token } = await params;
  const query = await searchParams;
  const requestedLocale = parseLocale(first(query['lang']));
  const sessionToken = (await cookies()).get(SESSION_COOKIE)?.value;

  let state: PageState | null = null;
  let locale: Locale = requestedLocale ?? 'en';

  if (sessionToken) {
    const result = await deps.service.viewCase(
      sessionToken,
      { ...(requestedLocale ? { locale: requestedLocale } : {}), includeSlots: first(query['reschedule']) === '1' },
    );
    if (result.status === 'ok') {
      locale = result.data.view.locale;
      state = {
        kind: 'case',
        data: result.data,
        saved: first(query['saved']) === '1',
        slotRequested: first(query['requested']) === '1',
      };
    }
  }

  if (!state) {
    const link = await deps.service.inspectLink(token);
    if (link.status === 'needs_verification') {
      const remaining = Number(first(query['r']));
      state = {
        kind: 'verify',
        attemptsRemaining: first(query['e']) === 'dob' && Number.isInteger(remaining) ? remaining : null,
      };
    } else {
      state = {
        kind: 'unavailable',
        reason: sessionToken && link.reason === 'used' ? 'session_ended' : link.reason,
        requested: first(query['sent']) === '1',
      };
    }
  }

  return <CasePage token={token} locale={locale} state={state} />;
}
