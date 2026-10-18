import type { APIRoute } from 'astro';
import { SESSION_COOKIE, STATE_COOKIE, createSessionValue, isAthleteAllowed } from '../../lib/auth';
import { getAthlete, upsertAthlete } from '../../lib/db';
import { REQUIRED_SCOPES, exchangeCode } from '../../lib/strava';
import { syncStrava } from '../../lib/sync';

export const GET: APIRoute = async ({ url, cookies, redirect, locals }) => {
  const expectedState = cookies.get(STATE_COOKIE)?.value;
  cookies.delete(STATE_COOKIE, { path: '/auth' });

  const code = url.searchParams.get('code');
  if (url.searchParams.get('error') || !code) return redirect('/?error=denied');
  if (!expectedState || url.searchParams.get('state') !== expectedState) return redirect('/?error=state');

  const scope = url.searchParams.get('scope') ?? '';
  const granted = scope.split(',');
  if (!REQUIRED_SCOPES.every((s) => granted.includes(s))) return redirect('/?error=scope');

  const token = await exchangeCode(code);
  if (!token.athlete || !isAthleteAllowed(token.athlete.id)) return redirect('/?error=forbidden');

  await upsertAthlete({ ...token.athlete, ...token, scope });
  const athlete = await getAthlete(token.athlete.id);
  if (athlete) await syncStrava(athlete, true, (p) => locals.cfContext.waitUntil(p));

  const session = await createSessionValue(token.athlete.id);
  cookies.set(SESSION_COOKIE, session.value, {
    path: '/',
    httpOnly: true,
    secure: url.protocol === 'https:',
    sameSite: 'lax',
    maxAge: session.maxAge,
  });
  return redirect('/');
};
