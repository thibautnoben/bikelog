import { defineMiddleware } from 'astro:middleware';
import { SESSION_COOKIE, readSessionValue } from './lib/auth';
import { getAthlete, ruleJobProgress } from './lib/db';
import { processRuleJob } from './lib/ruleJob';

const PUBLIC_PATHS = ['/', '/auth/login', '/auth/callback'];

export const onRequest = defineMiddleware(async (context, next) => {
  const started = performance.now();
  // Webhooks are called by Strava, not a signed-in browser.
  if (context.url.pathname.startsWith('/webhook/')) {
    context.locals.athlete = null;
    return next();
  }
  const athleteId = await readSessionValue(context.cookies.get(SESSION_COOKIE)?.value);
  context.locals.athlete = athleteId ? await getAthlete(athleteId) : null;

  const athlete = context.locals.athlete;
  const isPublic = PUBLIC_PATHS.includes(context.url.pathname);
  if (!athlete && !isPublic) {
    return context.redirect('/');
  }
  const response = await next();
  // Time until the page's data was loaded and streaming began: the server's share of TTFB, shown in
  // DevTools > Network > Timing. (Workers only advance the clock across I/O, which is what we want to see.)
  try {
    response.headers.append('Server-Timing', `app;dur=${Math.round(performance.now() - started)}`);
  } catch {
    // Responses such as Response.redirect() have immutable headers; skip the timing for those.
  }

  // Keep an "apply rules to past rides" run moving in the background while the app is used. The
  // pending check runs in the background too, so the response doesn't wait for its D1 round trip.
  const pausedUntil = athlete?.rule_job_paused_until ?? 0;
  if (
    athlete &&
    context.request.method === 'GET' &&
    context.url.pathname !== '/rules/job' &&
    pausedUntil < Date.now() / 1000
  ) {
    const run = async () => {
      if ((await ruleJobProgress(athlete.id))?.pending) await processRuleJob(athlete.id, 20_000);
    };
    context.locals.cfContext.waitUntil(run().catch((e) => console.error('Rule job failed:', e)));
  }
  return response;
});
