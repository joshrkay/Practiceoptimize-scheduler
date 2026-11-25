import { getPatientPageDeps, SESSION_COOKIE } from './deps';
import { parseLocale } from './messages';

function redirect(path: string, extraHeaders: Record<string, string> = {}): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: path, 'Cache-Control': 'no-store', ...extraHeaders },
  });
}

function sessionCookie(request: Request): string | undefined {
  const header = request.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return rest.join('=');
  }
  return undefined;
}

/**
 * Page cookie: HttpOnly, Secure, SameSite=Strict, scoped to this link's path and lived for the
 * session only. Entirely separate from staff authentication.
 */
function buildSessionCookie(token: string, value: string, expiresAt: Date): string {
  return [
    `${SESSION_COOKIE}=${value}`,
    `Path=/p/${encodeURIComponent(token)}`,
    `Expires=${expiresAt.toUTCString()}`,
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
  ].join('; ');
}

export async function handlePatientAction(
  request: Request,
  token: string,
  action: string,
): Promise<Response> {
  const deps = getPatientPageDeps();
  if (!deps || !deps.isEnabled()) return new Response('Not found', { status: 404 });

  const form = await request.formData();
  const lang = parseLocale(typeof form.get('lang') === 'string' ? (form.get('lang') as string) : undefined);
  const langQuery = lang ? `&lang=${lang}` : '';
  const base = `/p/${encodeURIComponent(token)}`;

  switch (action) {
    case 'verify': {
      const dob = form.get('dob');
      const result = await deps.service.verify(token, typeof dob === 'string' ? dob : '');
      if (result.status === 'verified') {
        return redirect(base, {
          'Set-Cookie': buildSessionCookie(token, result.sessionToken, result.expiresAt),
        });
      }
      if (result.status === 'wrong_dob') {
        return redirect(`${base}?e=dob&r=${result.attemptsRemaining}`);
      }
      return redirect(base);
    }
    case 'request-link': {
      await deps.service.requestNewLink(token);
      return redirect(`${base}?sent=1${langQuery}`);
    }
    case 'contacts': {
      const session = sessionCookie(request);
      const contactId = form.get('contactId');
      if (!session || typeof contactId !== 'string') return redirect(base);
      const types = form.getAll('types').filter((v): v is string => typeof v === 'string');
      await deps.service.saveContactPreferences(session, contactId, types);
      return redirect(`${base}?saved=1${langQuery}`);
    }
    case 'choose-slot': {
      const session = sessionCookie(request);
      const slotId = form.get('slotId');
      if (!session || typeof slotId !== 'string') return redirect(base);
      const result = await deps.service.chooseSlot(session, slotId);
      return redirect(result.status === 'requested' ? `${base}?requested=1${langQuery}` : base);
    }
    default:
      return new Response('Not found', { status: 404 });
  }
}
