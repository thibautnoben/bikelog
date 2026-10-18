import { env } from 'cloudflare:workers';
import type { Athlete } from './db';
import { saveTokens } from './db';

const STRAVA = 'https://www.strava.com';
// profile:read_all is needed to see bikes, activity:read_all to sum distance since a past date.
export const REQUIRED_SCOPES = ['read', 'profile:read_all', 'activity:read_all'];
// activity:write lets gear rules change the bike on an activity; sign-in works without it.
export const GEAR_RULES_SCOPE = 'activity:write';
export const STRAVA_SCOPE = [...REQUIRED_SCOPES, GEAR_RULES_SCOPE].join(',');

export interface StravaTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  athlete?: { id: number; firstname?: string; lastname?: string };
}

export interface StravaGear {
  id: string;
  name: string;
  distance: number; // metres
  primary: boolean;
  retired?: boolean;
}

export interface StravaActivity {
  id: number;
  name: string;
  sport_type: string;
  start_date: string;
  start_date_local: string;
  moving_time: number;
  total_elevation_gain: number;
  start_latlng: [number, number] | [];
  end_latlng: [number, number] | [];
  /** True when watts come from a power meter rather than Strava's estimate. */
  device_watts?: boolean;
  commute: boolean;
  gear_id: string | null;
  /** Only in the detailed representation (GET /activities/{id}), not in activity lists. */
  description?: string | null;
  /** Not in Strava's documented API; present only if Strava returns it. */
  private_note?: string | null;
  distance: number;
}

/**
 * `mobile` uses Strava's mobile endpoint: on Android it opens the Strava app when installed,
 * and otherwise shows Strava's mobile web login.
 */
export function authorizeUrl(redirectUri: string, state: string, mobile = false): string {
  const params = new URLSearchParams({
    client_id: env.STRAVA_CLIENT_ID.trim(),
    redirect_uri: redirectUri,
    response_type: 'code',
    approval_prompt: 'auto',
    scope: STRAVA_SCOPE,
    state,
  });
  return `${STRAVA}/oauth/${mobile ? 'mobile/' : ''}authorize?${params}`;
}

async function tokenRequest(body: Record<string, string>): Promise<StravaTokenResponse> {
  const res = await fetch(`${STRAVA}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      // Trimmed: a newline pasted into `wrangler secret put` makes Strava reject the credentials.
      client_id: env.STRAVA_CLIENT_ID.trim(),
      client_secret: env.STRAVA_CLIENT_SECRET.trim(),
      ...body,
    }),
  });
  // Strava's error body names the rejected field (e.g. client_secret) and contains no secrets.
  if (!res.ok) throw new Error(`Strava token request failed (${res.status}): ${await res.text()}`);
  return res.json();
}

export function exchangeCode(code: string): Promise<StravaTokenResponse> {
  return tokenRequest({ code, grant_type: 'authorization_code' });
}

/** Returns a valid access token, refreshing (and persisting) it when it is about to expire. */
export async function accessToken(athlete: Athlete): Promise<string> {
  if (athlete.expires_at > Date.now() / 1000 + 120) return athlete.access_token;
  const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: athlete.refresh_token });
  await saveTokens(athlete.id, t.access_token, t.refresh_token, t.expires_at);
  athlete.access_token = t.access_token;
  athlete.refresh_token = t.refresh_token;
  athlete.expires_at = t.expires_at;
  return t.access_token;
}

/** Thrown on HTTP 429; `retryAt` (unix seconds) is when Strava's exceeded window resets. */
export class RateLimitError extends Error {
  constructor(readonly retryAt: number) {
    super('Strava rate limit reached, try again in a few minutes.');
  }
}

/**
 * When the exceeded limit resets: 15-minute windows reset at :00/:15/:30/:45, daily limits at
 * midnight UTC. Headers look like `X-RateLimit-Usage: 201,1500` (15 min, daily).
 */
export function rateLimitReset(headers: Headers, now = new Date()): number {
  const pairs = (name: string) => (headers.get(name) ?? '').split(',').map(Number);
  const dailyExceeded = (['X-RateLimit', 'X-ReadRateLimit'] as const).some((prefix) => {
    const [, limit] = pairs(`${prefix}-Limit`);
    const [, usage] = pairs(`${prefix}-Usage`);
    return limit > 0 && usage >= limit;
  });
  const reset = new Date(now);
  if (dailyExceeded) {
    reset.setUTCHours(24, 0, 0, 0);
  } else {
    reset.setUTCMinutes(Math.floor(now.getUTCMinutes() / 15) * 15 + 15, 0, 0);
  }
  return Math.floor(reset.getTime() / 1000);
}

async function api<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${STRAVA}/api/v3${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...init?.headers },
  });
  if (res.status === 429) throw new RateLimitError(rateLimitReset(res.headers));
  if (!res.ok) throw new Error(`Strava API ${path} failed (${res.status})`);
  return res.json();
}

export async function fetchBikes(token: string): Promise<StravaGear[]> {
  const athlete = await api<{ bikes?: StravaGear[] }>(token, '/athlete');
  return athlete.bikes ?? [];
}

/** Distance (metres) ridden on `gearId` in activities that started at or after `sinceEpoch`. */
export async function distanceSince(token: string, gearId: string, sinceEpoch: number): Promise<number> {
  const perPage = 200;
  let total = 0;
  for (let page = 1; page <= 20; page++) {
    const activities = await api<StravaActivity[]>(
      token,
      `/athlete/activities?after=${sinceEpoch - 1}&per_page=${perPage}&page=${page}`,
    );
    for (const a of activities) if (a.gear_id === gearId) total += a.distance;
    if (activities.length < perPage) break;
  }
  return total;
}

export function getActivity(token: string, id: number): Promise<StravaActivity> {
  return api<StravaActivity>(token, `/activities/${id}`);
}

export function recentActivities(token: string, count = 30, page = 1): Promise<StravaActivity[]> {
  return api<StravaActivity[]>(token, `/athlete/activities?per_page=${count}&page=${page}`);
}

/** All activities that started after `afterEpoch` (unix seconds), newest first; at most `maxPages` × 200. */
export async function activitiesSince(token: string, afterEpoch: number, maxPages = 10): Promise<StravaActivity[]> {
  const all: StravaActivity[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const batch = await api<StravaActivity[]>(
      token,
      `/athlete/activities?after=${afterEpoch}&per_page=200&page=${page}`,
    );
    all.push(...batch);
    if (batch.length < 200) break;
  }
  // With `after`, Strava returns oldest first.
  return all.sort((a, b) => b.start_date.localeCompare(a.start_date));
}

/** Up to `count` activities that started before `beforeEpoch` (unix seconds), newest first. */
export function activitiesBefore(token: string, beforeEpoch: number, count = 200): Promise<StravaActivity[]> {
  return api<StravaActivity[]>(token, `/athlete/activities?before=${beforeEpoch}&per_page=${count}`);
}

export interface ActivityChanges {
  gear_id?: string;
  commute?: true;
  name?: string;
  description?: string;
  /** Undocumented by Strava; the caller checks the response to see whether it was accepted. */
  private_note?: string;
}

/** Updates an activity and returns Strava's updated (detailed) activity. */
export function updateActivity(token: string, id: number, changes: ActivityChanges): Promise<StravaActivity> {
  return api<StravaActivity>(token, `/activities/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(changes),
  });
}
