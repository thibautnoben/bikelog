import type { Athlete, Bike } from './db';
import { newestActivityDate, oldestActivityDate, replaceBikes, setBackfillDone, upsertActivities } from './db';
import { accessToken, activitiesBefore, distanceSince, fetchBikes, recentActivities } from './strava';
import { today } from './components';

const STALE_AFTER_SECONDS = 30 * 60;
const ACTIVITIES_PER_PAGE = 100;
/** Syncs page back until they overlap stored activities by this many days... */
const OVERLAP_DAYS = 7;
/** ...or hit this many pages. */
const MAX_INCREMENTAL_PAGES = 10;
/** Older history is imported this many pages (of 200) per sync until it is complete. */
const BACKFILL_PAGES_PER_SYNC = 5;

/**
 * Pulls bike odometers and new activities from Strava. Skipped when synced recently unless `force` is set.
 * Older history is imported via `waitUntil` so page loads don't wait for it; only the very first
 * import runs inline, so a fresh login shows data straight away.
 */
export async function syncStrava(
  athlete: Athlete,
  force = false,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<void> {
  const fresh = athlete.last_synced_at && Date.now() / 1000 - athlete.last_synced_at < STALE_AFTER_SECONDS;
  if (fresh && !force) return;
  const token = await accessToken(athlete);

  if (await newestActivityDate(athlete.id)) {
    await syncNewActivities(athlete.id, token);
    if (!athlete.backfill_done) {
      const backfill = backfillActivities(athlete, token).catch((e) => console.error('History import failed:', e));
      if (waitUntil) waitUntil(backfill);
      else await backfill;
    }
  } else {
    await backfillActivities(athlete, token);
  }
  await replaceBikes(athlete.id, await fetchBikes(token));
  athlete.last_synced_at = Math.floor(Date.now() / 1000);
}

/**
 * Stores new activities. Recent ones are re-fetched too (the overlap window), so gear or the
 * commute flag changed on Strava after upload is picked up.
 */
async function syncNewActivities(athleteId: number, token: string): Promise<void> {
  const newest = await newestActivityDate(athleteId);
  const cutoff = newest ? new Date(Date.parse(newest) - OVERLAP_DAYS * 86_400_000).toISOString() : null;

  for (let page = 1; page <= MAX_INCREMENTAL_PAGES; page++) {
    const activities = await recentActivities(token, ACTIVITIES_PER_PAGE, page);
    await upsertActivities(athleteId, activities);
    if (activities.length < ACTIVITIES_PER_PAGE) break;
    if (cutoff && activities[activities.length - 1].start_date < cutoff) break;
  }
}

/** Imports activities older than the oldest stored one, a few pages per call, until history is complete. */
async function backfillActivities(athlete: Athlete, token: string): Promise<void> {
  const oldest = await oldestActivityDate(athlete.id);
  let before = oldest ? Math.floor(Date.parse(oldest) / 1000) : Math.floor(Date.now() / 1000);

  for (let page = 0; page < BACKFILL_PAGES_PER_SYNC; page++) {
    const activities = await activitiesBefore(token, before, 200);
    await upsertActivities(athlete.id, activities);
    if (activities.length < 200) {
      await setBackfillDone(athlete.id);
      athlete.backfill_done = 1;
      return;
    }
    // Don't rely on the sort order: continue from the oldest activity in this page.
    before = Math.min(...activities.map((a) => Math.floor(Date.parse(a.start_date) / 1000)));
  }
}

/**
 * Bike odometer (metres) at the start of `date`. For today it's the current odometer;
 * for past dates the distance ridden since then is subtracted, using Strava activities.
 */
export async function odometerOn(athlete: Athlete, bike: Bike, date: string): Promise<number> {
  if (date >= today()) return bike.odometer_m;
  const token = await accessToken(athlete);
  const since = Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);
  const ridden = await distanceSince(token, bike.id, since);
  return Math.max(0, bike.odometer_m - ridden);
}
