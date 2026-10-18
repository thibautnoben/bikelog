import { env } from 'cloudflare:workers';

export const SESSION_COOKIE = 'bl_session';
export const STATE_COOKIE = 'bl_oauth_state';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

const encoder = new TextEncoder();

async function hmac(data: string): Promise<string> {
  if (!env.SESSION_SECRET) throw new Error('SESSION_SECRET is not configured');
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(env.SESSION_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Cookie value: `<athleteId>.<expiresAt>.<signature>` */
export async function createSessionValue(athleteId: number): Promise<{ value: string; maxAge: number }> {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = `${athleteId}.${expiresAt}`;
  return { value: `${payload}.${await hmac(payload)}`, maxAge: SESSION_TTL_SECONDS };
}

export async function readSessionValue(value: string | undefined): Promise<number | null> {
  if (!value) return null;
  const [id, exp, sig] = value.split('.');
  if (!id || !exp || !sig) return null;
  if (Number(exp) < Date.now() / 1000) return null;
  if (!timingSafeEqual(sig, await hmac(`${id}.${exp}`))) return null;
  const athleteId = Number(id);
  return Number.isSafeInteger(athleteId) ? athleteId : null;
}

export function isAthleteAllowed(athleteId: number): boolean {
  const allowed = (env.ALLOWED_ATHLETE_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return allowed.length === 0 || allowed.includes(String(athleteId));
}

export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
