import type { Athlete, Bike } from './db';
import {
  claimSync,
  newestActivityDate,
  oldestActivityDate,
  replaceBikes,
  setBackfillDone,
  setLastSynced,
  upsertActivities,
} from './db';
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
 * With `waitUntil`, a page load renders from stored data and the sync runs in the background; only an
 * athlete with nothing stored yet waits, so the first page isn't empty. Older history is imported via
 * `waitUntil` too, so a forced sync (login, Sync button) only waits for new activities and bikes.
 */
export async function syncStrava(
  athlete: Athlete,
  force = false,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<void> {
  const fresh = athlete.last_synced_at && Date.now() / 1000 - athlete.last_synced_at < STALE_AFTER_SECONDS;
  if (fresh && !force) return;
  if (!force && waitUntil && (athlete.last_synced_at || athlete.backfill_done)) {
    waitUntil(backgroundSync(athlete).catch((e) => console.error('Background sync failed:', e)));
    return;
  }
  await runSync(athlete, waitUntil);
}

/** Claims the sync first, so page loads and prefetches arriving meanwhile don't start their own. */
async function backgroundSync(athlete: Athlete): Promise<void> {
  const previous = athlete.last_synced_at;
  if (!(await claimSync(athlete.id, Math.floor(Date.now() / 1000) - STALE_AFTER_SECONDS))) return;
  try {
    await runSync(athlete);
  } catch (e) {
    // Release the claim so the next page load retries instead of waiting out the stale period.
    await setLastSynced(athlete.id, previous);
    throw e;
  }
}

async function runSync(athlete: Athlete, waitUntil?: (promise: Promise<unknown>) => void): Promise<void> {
  const token = await accessToken(athlete);

  const newest = await newestActivityDate(athlete.id);
  if (newest) {
    await syncNewActivities(athlete.id, token, newest);
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
async function syncNewActivities(athleteId: number, token: string, newest: string): Promise<void> {
  const cutoff = new Date(Date.parse(newest) - OVERLAP_DAYS * 86_400_000).toISOString();

  for (let page = 1; page <= MAX_INCREMENTAL_PAGES; page++) {
    const activities = await recentActivities(token, ACTIVITIES_PER_PAGE, page);
    await upsertActivities(athleteId, activities);
    if (activities.length < ACTIVITIES_PER_PAGE) break;
    if (activities[activities.length - 1].start_date < cutoff) break;
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
