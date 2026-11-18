import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { timingSafeEqual } from '../../../lib/auth';
import { clearScope } from '../../../lib/db';
import { handleActivityEvent } from '../../../lib/gearRules';

// Strava does not sign webhook events, so the callback URL carries a secret token and the
// activity itself is always re-fetched from Strava with the owner's token.
// Trimmed: a newline pasted into `wrangler secret put` would otherwise never match.
const webhookToken = () => (env.STRAVA_WEBHOOK_TOKEN ?? '').trim();

function validToken(token: string | undefined): boolean {
  return !!webhookToken() && !!token && timingSafeEqual(token, webhookToken());
}

interface StravaEvent {
  object_type: 'activity' | 'athlete';
  aspect_type: 'create' | 'update' | 'delete';
  object_id: string;
  owner_id: string;
  object_id_str?: string;
  owner_id_str?: string;
  updates?: Record<string, string>;
}

/** Subscription validation handshake. */
export const GET: APIRoute = ({ params, url }) => {
  const challenge = url.searchParams.get('hub.challenge');
  const verifyToken = url.searchParams.get('hub.verify_token') ?? '';
  const pathOk = validToken(params.token);
  const verifyOk = verifyToken === webhookToken();
  if (!pathOk || !verifyOk || !challenge) {
    // Lengths only, never the values, to tell a missing/whitespace-padded secret from a wrong one.
    console.warn(
      `Webhook validation refused: secret length ${webhookToken().length}, path token length ${params.token?.length ?? 0} ` +
        `(${pathOk ? 'matches' : 'differs'}), verify_token length ${verifyToken.length} (${verifyOk ? 'matches' : 'differs'}), ` +
        `challenge ${challenge ? 'present' : 'missing'}`,
    );
    return new Response('Forbidden', { status: 403 });
  }
  return Response.json({ 'hub.challenge': challenge });
};

export const POST: APIRoute = async ({ params, request, locals }) => {
  if (!validToken(params.token)) return new Response('Forbidden', { status: 403 });
  const body = await request.text();
  const event = JSON.parse(body) as StravaEvent;
  const rawObjectId = body.match(/"object_id"\s*:\s*"?(\d+)"?/)?.[1];
  const rawOwnerId = body.match(/"owner_id"\s*:\s*"?(\d+)"?/)?.[1];
  event.object_id = event.object_id_str ?? rawObjectId ?? String(event.object_id);
  event.owner_id = event.owner_id_str ?? rawOwnerId ?? String(event.owner_id);

  if (event.object_type === 'activity') {
    // Strava expects a response within 2 seconds, so the work continues after responding.
    locals.cfContext.waitUntil(
      handleActivityEvent(event.owner_id, event.object_id, event.aspect_type).catch((e) =>
        console.error(`Handling ${event.aspect_type} of activity ${event.object_id} failed:`, e),
      ),
    );
  } else if (event.object_type === 'athlete' && event.updates?.authorized === 'false') {
    await clearScope(event.owner_id);
  }
  return new Response('OK');
};
