import type { APIRoute } from 'astro';
import { STATE_COOKIE, randomToken } from '../../lib/auth';
import { authorizeUrl } from '../../lib/strava';

export const GET: APIRoute = ({ url, request, cookies, redirect }) => {
  const state = randomToken();
  cookies.set(STATE_COOKIE, state, {
    path: '/auth',
    httpOnly: true,
    secure: url.protocol === 'https:',
    sameSite: 'lax',
    maxAge: 600,
  });
  // Android only: on iOS the Strava app is reached through a strava:// URL that a website can't rely on.
  const android = /Android/i.test(request.headers.get('user-agent') ?? '');
  return redirect(authorizeUrl(new URL('/auth/callback', url).href, state, android));
};
