import type { Athlete, GearRule, Place } from './db';
import {
  deleteActivity,
  getAthlete,
  listPlaces,
  listRules,
  logAssignment,
  markStale,
  upsertActivities,
} from './db';
import type { StravaActivity } from './strava';
import type { ActivityChanges } from './strava';
import { GEAR_RULES_SCOPE, accessToken, getActivity, updateActivity } from './strava';

/** Strava sport types that can carry a bike as gear. */
export const RIDE_SPORT_TYPES = [
  'Ride',
  'GravelRide',
  'MountainBikeRide',
  'EBikeRide',
  'EMountainBikeRide',
  'VirtualRide',
  'Velomobile',
  'Handcycle',
];

/** Webhook events for activities older than this are ignored (late or replayed events). */
const WEBHOOK_MAX_AGE_DAYS = 14;

export function hasGearRulesScope(athlete: Athlete): boolean {
  return (athlete.scope ?? '').split(',').includes(GEAR_RULES_SCOPE);
}

/** Great-circle distance in metres. */
export function distanceM(a: [number, number], b: [number, number]): number {
  const rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad;
  const dLng = (b[1] - a[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

function near(latlng: [number, number] | [], place: Place | undefined): boolean {
  if (!place || latlng.length !== 2) return false;
  return distanceM(latlng, [place.lat, place.lng]) <= place.radius_m;
}

export function ruleMatches(rule: GearRule, activity: StravaActivity, places: Map<number, Place>): boolean {
  if (rule.sport_type && activity.sport_type !== rule.sport_type) return false;
  if (rule.power_meter === 'yes' && !activity.device_watts) return false;
  if (rule.power_meter === 'no' && activity.device_watts) return false;
  if (rule.start_place_id != null && !near(activity.start_latlng, places.get(rule.start_place_id))) return false;
  if (rule.end_place_id != null && !near(activity.end_latlng, places.get(rule.end_place_id))) return false;
  return true;
}

/** First enabled rule that matches a ride, or null. */
export function matchingRule(rules: GearRule[], places: Place[], activity: StravaActivity): GearRule | null {
  if (!RIDE_SPORT_TYPES.includes(activity.sport_type)) return null;
  const byId = new Map(places.map((p) => [p.id, p]));
  return rules.find((r) => r.enabled && ruleMatches(r, activity, byId)) ?? null;
}

/** Log names of the fields in ActivityChanges. */
const FIELD_NAMES: Record<keyof ActivityChanges, string> = {
  gear_id: 'gear',
  commute: 'commute',
  name: 'name',
  description: 'description',
  private_note: 'private_note',
};

/**
 * What `rule` would change on `activity`; empty when it already matches. Description and private note
 * are only in Strava's detailed activity, so for list entries they count as changed when the rule sets them.
 */
export function ruleChanges(rule: GearRule, activity: StravaActivity): ActivityChanges {
  const changes: ActivityChanges = {};
  if (rule.gear_id && activity.gear_id !== rule.gear_id) changes.gear_id = rule.gear_id;
  if (rule.mark_commute && !activity.commute) changes.commute = true;
  if (rule.set_name && activity.name !== rule.set_name) changes.name = rule.set_name;
  if (rule.set_description && activity.description !== rule.set_description) changes.description = rule.set_description;
  if (rule.set_private_note && activity.private_note !== rule.set_private_note)
    changes.private_note = rule.set_private_note;
  return changes;
}

/** Applies `rule` to `activity` on Strava and locally, and logs it. Returns true when something changed. */
export async function applyRule(
  athlete: Athlete,
  activity: StravaActivity,
  rule: GearRule,
  source: 'webhook' | 'manual',
): Promise<boolean> {
  const changes = ruleChanges(rule, activity);
  if (Object.keys(changes).length === 0) return false;
  const updated = await updateActivity(await accessToken(athlete), activity.id, changes);
  // Private notes aren't in Strava's documented API: report it when Strava didn't store ours.
  const warning =
    changes.private_note !== undefined && updated.private_note !== changes.private_note
      ? 'Strava did not accept the private note (not supported by its API)'
      : null;
  await logAssignment(athlete.id, {
    activity_id: activity.id,
    activity_name: changes.name ?? activity.name,
    activity_date: activity.start_date.slice(0, 10),
    from_gear_id: activity.gear_id,
    to_gear_id: changes.gear_id ?? activity.gear_id ?? '',
    marked_commute: changes.commute ? 1 : 0,
    changed_fields: (Object.keys(changes) as (keyof ActivityChanges)[]).map((k) => FIELD_NAMES[k]).join(','),
    warning,
    rule_id: rule.id,
    source,
  });
  Object.assign(activity, changes);
  await upsertActivities(athlete.id, [activity]);
  return true;
}

/** Handles a Strava activity webhook event: stores the activity and applies gear rules to new ones. */
export async function handleActivityEvent(
  athleteId: number,
  activityId: number,
  aspect: 'create' | 'update' | 'delete',
): Promise<void> {
  if (aspect === 'delete') return deleteActivity(athleteId, activityId);
  const athlete = await getAthlete(athleteId);
  if (!athlete) return;

  const activity = await getActivity(await accessToken(athlete), activityId);
  const ageDays = (Date.now() - Date.parse(activity.start_date)) / 86_400_000;
  if (aspect === 'create' && ageDays <= WEBHOOK_MAX_AGE_DAYS && hasGearRulesScope(athlete)) {
    const rule = matchingRule(await listRules(athlete.id), await listPlaces(athlete.id), activity);
    if (rule) await applyRule(athlete, activity, rule, 'webhook');
  }
  await upsertActivities(athlete.id, [activity]);
  // A new ride changes the bike's odometer, so refresh it on the next page load.
  await markStale(athlete.id);
}
