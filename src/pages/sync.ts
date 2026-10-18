import type { APIRoute } from 'astro';
import { syncStrava } from '../lib/sync';

export const POST: APIRoute = async ({ locals, request, redirect }) => {
  if (!locals.athlete) return redirect('/');
  await syncStrava(locals.athlete, true, (p) => locals.cfContext.waitUntil(p));
  const back = new URL(request.headers.get('referer') ?? '/', request.url);
  return redirect(back.origin === new URL(request.url).origin ? back.pathname : '/');
};
