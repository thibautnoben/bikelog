import { env } from 'cloudflare:workers';
import type { StravaActivity } from './strava';

export interface Athlete {
  id: number;
  firstname: string | null;
  lastname: string | null;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  last_synced_at: number | null;
  scope: string | null;
  backfill_done: number;
  rule_job_paused_until: number | null;
}

export interface Bike {
  id: string;
  athlete_id: number;
  name: string;
  odometer_m: number;
  is_primary: number;
  retired: number;
  updated_at: number;
}

export interface Component {
  id: number;
  bike_id: string;
  kind: string;
  label: string | null;
  installed_on: string;
  installed_odometer_m: number;
  initial_m: number;
  lifespan_km: number | null;
  lifespan_days: number | null;
  service_interval_km: number | null;
  last_service_on: string | null;
  last_service_odometer_m: number | null;
  battery_type: string | null;
  battery_interval_hours: number | null;
  last_battery_on: string | null;
  removed_on: string | null;
  removed_odometer_m: number | null;
  notes: string | null;
}

export interface MaintenanceEvent {
  id: number;
  bike_id: string;
  component_id: number | null;
  type: 'install' | 'remove' | 'service' | 'battery' | 'note';
  happened_on: string;
  odometer_m: number | null;
  description: string | null;
}

const db = () => env.DB;

export async function upsertAthlete(a: {
  id: number;
  firstname?: string;
  lastname?: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scope: string;
}): Promise<void> {
  await db()
    .prepare(
      `INSERT INTO athletes (id, firstname, lastname, access_token, refresh_token, expires_at, scope)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(id) DO UPDATE SET
         firstname = excluded.firstname, lastname = excluded.lastname,
         access_token = excluded.access_token, refresh_token = excluded.refresh_token,
         expires_at = excluded.expires_at, scope = excluded.scope`,
    )
    .bind(a.id, a.firstname ?? null, a.lastname ?? null, a.access_token, a.refresh_token, a.expires_at, a.scope)
    .run();
}

export async function saveTokens(id: number, access: string, refresh: string, expiresAt: number): Promise<void> {
  await db()
    .prepare('UPDATE athletes SET access_token = ?2, refresh_token = ?3, expires_at = ?4 WHERE id = ?1')
    .bind(id, access, refresh, expiresAt)
    .run();
}

export function getAthlete(id: number): Promise<Athlete | null> {
  return db().prepare('SELECT * FROM athletes WHERE id = ?').bind(id).first<Athlete>();
}

export async function replaceBikes(
  athleteId: number,
  bikes: { id: string; name: string; distance: number; primary: boolean; retired?: boolean }[],
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const statements = bikes.map((b) =>
    db()
      .prepare(
        `INSERT INTO bikes (id, athlete_id, name, odometer_m, is_primary, retired, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, odometer_m = excluded.odometer_m,
           is_primary = excluded.is_primary, retired = excluded.retired, updated_at = excluded.updated_at
         WHERE bikes.athlete_id = excluded.athlete_id`,
      )
      .bind(b.id, athleteId, b.name, b.distance, b.primary ? 1 : 0, b.retired ? 1 : 0, now),
  );
  statements.push(db().prepare('UPDATE athletes SET last_synced_at = ?2 WHERE id = ?1').bind(athleteId, now));
  await db().batch(statements);
}

export async function listBikes(athleteId: number): Promise<Bike[]> {
  const { results } = await db()
    .prepare('SELECT * FROM bikes WHERE athlete_id = ? ORDER BY retired, is_primary DESC, name')
    .bind(athleteId)
    .all<Bike>();
  return results;
}

export function getBike(athleteId: number, bikeId: string): Promise<Bike | null> {
  return db().prepare('SELECT * FROM bikes WHERE id = ?1 AND athlete_id = ?2').bind(bikeId, athleteId).first<Bike>();
}

export async function activeComponentsForAthlete(athleteId: number): Promise<Component[]> {
  const { results } = await db()
    .prepare(
      `SELECT c.* FROM components c JOIN bikes b ON b.id = c.bike_id
       WHERE b.athlete_id = ? AND c.removed_on IS NULL`,
    )
    .bind(athleteId)
    .all<Component>();
  return results;
}

export async function componentsForBike(bikeId: string): Promise<Component[]> {
  const { results } = await db()
    .prepare('SELECT * FROM components WHERE bike_id = ? ORDER BY removed_on IS NOT NULL, removed_on DESC, kind')
    .bind(bikeId)
    .all<Component>();
  return results;
}

export function getComponent(bikeId: string, id: number): Promise<Component | null> {
  return db().prepare('SELECT * FROM components WHERE id = ?1 AND bike_id = ?2').bind(id, bikeId).first<Component>();
}

export async function eventsForBike(bikeId: string, limit = 50): Promise<MaintenanceEvent[]> {
  const { results } = await db()
    .prepare('SELECT * FROM events WHERE bike_id = ? ORDER BY happened_on DESC, id DESC LIMIT ?')
    .bind(bikeId, limit)
    .all<MaintenanceEvent>();
  return results;
}

export interface NewComponent {
  bike_id: string;
  kind: string;
  label: string | null;
  installed_on: string;
  installed_odometer_m: number;
  initial_m: number;
  lifespan_km: number | null;
  lifespan_days: number | null;
  service_interval_km: number | null;
  battery_type: string | null;
  battery_interval_hours: number | null;
  notes: string | null;
}

function insertComponentStatements(c: NewComponent, description: string) {
  return [
    db()
      .prepare(
        `INSERT INTO components (bike_id, kind, label, installed_on, installed_odometer_m, initial_m,
           lifespan_km, lifespan_days, service_interval_km, battery_type, battery_interval_hours, notes)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
      )
      .bind(
        c.bike_id, c.kind, c.label, c.installed_on, c.installed_odometer_m, c.initial_m,
        c.lifespan_km, c.lifespan_days, c.service_interval_km, c.battery_type, c.battery_interval_hours, c.notes,
      ),
    db()
      .prepare(
        `INSERT INTO events (bike_id, component_id, type, happened_on, odometer_m, description)
         VALUES (?1, last_insert_rowid(), 'install', ?2, ?3, ?4)`,
      )
      .bind(c.bike_id, c.installed_on, c.installed_odometer_m, description),
  ];
}

export async function addComponent(c: NewComponent, description: string): Promise<void> {
  await db().batch(insertComponentStatements(c, description));
}

/** Retires `old` and, when `replacement` is given, installs it in the same transaction. */
export async function removeComponent(
  old: Component,
  on: string,
  odometerM: number,
  description: string,
  replacement?: { component: NewComponent; description: string },
): Promise<void> {
  const statements = [
    db()
      .prepare('UPDATE components SET removed_on = ?2, removed_odometer_m = ?3 WHERE id = ?1')
      .bind(old.id, on, odometerM),
    db()
      .prepare(
        `INSERT INTO events (bike_id, component_id, type, happened_on, odometer_m, description)
         VALUES (?1, ?2, 'remove', ?3, ?4, ?5)`,
      )
      .bind(old.bike_id, old.id, on, odometerM, description),
  ];
  if (replacement) statements.push(...insertComponentStatements(replacement.component, replacement.description));
  await db().batch(statements);
}

export async function serviceComponent(c: Component, on: string, odometerM: number, description: string): Promise<void> {
  await db().batch([
    db()
      .prepare('UPDATE components SET last_service_on = ?2, last_service_odometer_m = ?3 WHERE id = ?1')
      .bind(c.id, on, odometerM),
    db()
      .prepare(
        `INSERT INTO events (bike_id, component_id, type, happened_on, odometer_m, description)
         VALUES (?1, ?2, 'service', ?3, ?4, ?5)`,
      )
      .bind(c.bike_id, c.id, on, odometerM, description),
  ]);
}

export async function updateComponent(
  c: Component,
  fields: Pick<
    Component,
    'label' | 'lifespan_km' | 'lifespan_days' | 'service_interval_km' | 'battery_type' | 'battery_interval_hours' | 'notes'
  >,
): Promise<void> {
  await db()
    .prepare(
      `UPDATE components SET label = ?2, lifespan_km = ?3, lifespan_days = ?4, service_interval_km = ?5,
         battery_type = ?6, battery_interval_hours = ?7, notes = ?8
       WHERE id = ?1`,
    )
    .bind(
      c.id, fields.label, fields.lifespan_km, fields.lifespan_days, fields.service_interval_km,
      fields.battery_type, fields.battery_interval_hours, fields.notes,
    )
    .run();
}

/**
 * Riding time (seconds) on the bike since each battery-tracked component's last battery change
 * (or install), keyed by component id. Rides on the change day itself count towards the new battery.
 */
export async function batteryRideSeconds(athleteId: number, bikeId?: string): Promise<Map<number, number>> {
  const { results } = await db()
    .prepare(
      `SELECT c.id, COALESCE(SUM(a.moving_time_s), 0) AS seconds
       FROM components c
       JOIN bikes b ON b.id = c.bike_id AND b.athlete_id = ?1
       LEFT JOIN activities a ON a.athlete_id = ?1 AND a.gear_id = c.bike_id
         AND substr(a.start_date_local, 1, 10) >= COALESCE(c.last_battery_on, c.installed_on)
         AND (c.removed_on IS NULL OR substr(a.start_date_local, 1, 10) < c.removed_on)
       WHERE (c.battery_type IS NOT NULL OR c.battery_interval_hours IS NOT NULL)
         AND (?2 IS NULL OR c.bike_id = ?2)
       GROUP BY c.id`,
    )
    .bind(athleteId, bikeId ?? null)
    .all<{ id: number; seconds: number }>();
  return new Map(results.map((r) => [r.id, r.seconds]));
}

export async function changeBattery(c: Component, on: string, odometerM: number, description: string): Promise<void> {
  await db().batch([
    db().prepare('UPDATE components SET last_battery_on = ?2 WHERE id = ?1').bind(c.id, on),
    db()
      .prepare(
        `INSERT INTO events (bike_id, component_id, type, happened_on, odometer_m, description)
         VALUES (?1, ?2, 'battery', ?3, ?4, ?5)`,
      )
      .bind(c.bike_id, c.id, on, odometerM, description),
  ]);
}

export async function deleteComponent(c: Component): Promise<void> {
  await db().prepare('DELETE FROM components WHERE id = ?').bind(c.id).run();
}

export async function addNote(bikeId: string, on: string, odometerM: number, description: string): Promise<void> {
  await db()
    .prepare(
      `INSERT INTO events (bike_id, type, happened_on, odometer_m, description) VALUES (?1, 'note', ?2, ?3, ?4)`,
    )
    .bind(bikeId, on, odometerM, description)
    .run();
}

export async function deleteEvent(bikeId: string, id: number): Promise<void> {
  await db().prepare('DELETE FROM events WHERE id = ?1 AND bike_id = ?2').bind(id, bikeId).run();
}

/** Forces the next page load to re-sync odometers, e.g. after gear was moved between bikes. */
export async function markStale(athleteId: number): Promise<void> {
  await db().prepare('UPDATE athletes SET last_synced_at = NULL WHERE id = ?').bind(athleteId).run();
}

/** Called when the athlete revokes access on Strava: gear rules can no longer write. */
export async function clearScope(athleteId: number): Promise<void> {
  await db().prepare("UPDATE athletes SET scope = '' WHERE id = ?").bind(athleteId).run();
}

// --- Gear rules -------------------------------------------------------------------------------

export interface Place {
  id: number;
  athlete_id: number;
  name: string;
  lat: number;
  lng: number;
  radius_m: number;
}

export type PowerMeterCondition = 'any' | 'yes' | 'no';

export interface GearRule {
  id: number;
  athlete_id: number;
  position: number;
  name: string | null;
  start_place_id: number | null;
  end_place_id: number | null;
  power_meter: PowerMeterCondition;
  sport_type: string | null;
  enabled: number;
  // Actions: null / 0 leaves that field alone.
  gear_id: string | null;
  mark_commute: number;
  set_name: string | null;
  set_description: string | null;
  set_private_note: string | null;
}

export type RuleFields = Omit<GearRule, 'id' | 'athlete_id' | 'position' | 'enabled'>;

export interface GearAssignment {
  id: number;
  activity_id: number;
  activity_name: string | null;
  activity_date: string | null;
  from_gear_id: string | null;
  to_gear_id: string;
  marked_commute: number;
  /** Comma-separated: gear, commute, name, description, private_note. */
  changed_fields: string | null;
  warning: string | null;
  rule_id: number | null;
  source: 'webhook' | 'manual';
  created_at: number;
}

export async function listPlaces(athleteId: number): Promise<Place[]> {
  const { results } = await db()
    .prepare('SELECT * FROM places WHERE athlete_id = ? ORDER BY name')
    .bind(athleteId)
    .all<Place>();
  return results;
}

export async function addPlace(athleteId: number, p: Pick<Place, 'name' | 'lat' | 'lng' | 'radius_m'>): Promise<void> {
  await db()
    .prepare('INSERT INTO places (athlete_id, name, lat, lng, radius_m) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(athleteId, p.name, p.lat, p.lng, p.radius_m)
    .run();
}

/** Returns false when the place is still used by a rule. */
export async function deletePlace(athleteId: number, id: number): Promise<boolean> {
  const used = await db()
    .prepare('SELECT 1 FROM gear_rules WHERE athlete_id = ?1 AND (start_place_id = ?2 OR end_place_id = ?2) LIMIT 1')
    .bind(athleteId, id)
    .first();
  if (used) return false;
  await db().prepare('DELETE FROM places WHERE id = ?1 AND athlete_id = ?2').bind(id, athleteId).run();
  return true;
}

export async function listRules(athleteId: number): Promise<GearRule[]> {
  const { results } = await db()
    .prepare('SELECT * FROM gear_rules WHERE athlete_id = ? ORDER BY position, id')
    .bind(athleteId)
    .all<GearRule>();
  return results;
}

export async function addRule(athleteId: number, r: RuleFields): Promise<void> {
  await db()
    .prepare(
      `INSERT INTO gear_rules
         (athlete_id, position, name, start_place_id, end_place_id, power_meter, sport_type,
          gear_id, mark_commute, set_name, set_description, set_private_note)
       VALUES (?1, (SELECT COALESCE(MAX(position), 0) + 1 FROM gear_rules WHERE athlete_id = ?1),
               ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
    )
    .bind(
      athleteId, r.name, r.start_place_id, r.end_place_id, r.power_meter, r.sport_type,
      r.gear_id, r.mark_commute, r.set_name, r.set_description, r.set_private_note,
    )
    .run();
}

export async function updateRule(athleteId: number, id: number, r: RuleFields): Promise<void> {
  await db()
    .prepare(
      `UPDATE gear_rules SET name = ?3, start_place_id = ?4, end_place_id = ?5, power_meter = ?6, sport_type = ?7,
         gear_id = ?8, mark_commute = ?9, set_name = ?10, set_description = ?11, set_private_note = ?12
       WHERE id = ?1 AND athlete_id = ?2`,
    )
    .bind(
      id, athleteId, r.name, r.start_place_id, r.end_place_id, r.power_meter, r.sport_type,
      r.gear_id, r.mark_commute, r.set_name, r.set_description, r.set_private_note,
    )
    .run();
}

export async function setRuleEnabled(athleteId: number, id: number, enabled: boolean): Promise<void> {
  await db()
    .prepare('UPDATE gear_rules SET enabled = ?3 WHERE id = ?1 AND athlete_id = ?2')
    .bind(id, athleteId, enabled ? 1 : 0)
    .run();
}

export async function deleteRule(athleteId: number, id: number): Promise<void> {
  await db().prepare('DELETE FROM gear_rules WHERE id = ?1 AND athlete_id = ?2').bind(id, athleteId).run();
}

/** Swaps the rule with its neighbour so it is evaluated earlier (-1) or later (+1). */
export async function moveRule(athleteId: number, id: number, direction: -1 | 1): Promise<void> {
  const rules = await listRules(athleteId);
  const i = rules.findIndex((r) => r.id === id);
  const j = i + direction;
  if (i < 0 || j < 0 || j >= rules.length) return;
  [rules[i], rules[j]] = [rules[j], rules[i]];
  await db().batch(
    rules.map((r, position) =>
      db().prepare('UPDATE gear_rules SET position = ?2 WHERE id = ?1').bind(r.id, position + 1),
    ),
  );
}

export async function logAssignment(
  athleteId: number,
  a: Omit<GearAssignment, 'id' | 'created_at'>,
): Promise<void> {
  await db()
    .prepare(
      `INSERT INTO gear_assignments
         (athlete_id, activity_id, activity_name, activity_date, from_gear_id, to_gear_id, marked_commute,
          changed_fields, warning, rule_id, source)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
    )
    .bind(
      athleteId, a.activity_id, a.activity_name, a.activity_date, a.from_gear_id, a.to_gear_id,
      a.marked_commute, a.changed_fields, a.warning, a.rule_id, a.source,
    )
    .run();
}

export async function recentAssignments(athleteId: number, limit = 20): Promise<GearAssignment[]> {
  const { results } = await db()
    .prepare('SELECT * FROM gear_assignments WHERE athlete_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
    .bind(athleteId, limit)
    .all<GearAssignment>();
  return results;
}

// --- Activities -------------------------------------------------------------------------------

export interface Activity {
  id: number;
  athlete_id: number;
  gear_id: string | null;
  name: string;
  sport_type: string;
  start_date: string;
  start_date_local: string;
  distance_m: number;
  moving_time_s: number;
  elevation_gain_m: number;
  device_watts: number;
  commute: number;
}

export async function upsertActivities(athleteId: number, activities: StravaActivity[]): Promise<void> {
  if (activities.length === 0) return;
  await db().batch(
    activities.map((a) =>
      db()
        .prepare(
          `INSERT INTO activities (id, athlete_id, gear_id, name, sport_type, start_date, start_date_local,
             distance_m, moving_time_s, elevation_gain_m, device_watts, commute)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
           ON CONFLICT(id) DO UPDATE SET
             gear_id = excluded.gear_id, name = excluded.name, sport_type = excluded.sport_type,
             start_date = excluded.start_date, start_date_local = excluded.start_date_local,
             distance_m = excluded.distance_m, moving_time_s = excluded.moving_time_s,
             elevation_gain_m = excluded.elevation_gain_m, device_watts = excluded.device_watts,
             commute = excluded.commute
           WHERE activities.athlete_id = excluded.athlete_id`,
        )
        .bind(
          a.id, athleteId, a.gear_id ?? null, a.name, a.sport_type, a.start_date, a.start_date_local,
          a.distance ?? 0, a.moving_time ?? 0, a.total_elevation_gain ?? 0, a.device_watts ? 1 : 0,
          a.commute ? 1 : 0,
        ),
    ),
  );
}

export async function newestActivityDate(athleteId: number): Promise<string | null> {
  const row = await db()
    .prepare('SELECT MAX(start_date) AS d FROM activities WHERE athlete_id = ?')
    .bind(athleteId)
    .first<{ d: string | null }>();
  return row?.d ?? null;
}


export async function deleteActivity(athleteId: number, id: number): Promise<void> {
  await db().prepare('DELETE FROM activities WHERE id = ?1 AND athlete_id = ?2').bind(id, athleteId).run();
}

export async function oldestActivityDate(athleteId: number): Promise<string | null> {
  const row = await db()
    .prepare('SELECT MIN(start_date) AS d FROM activities WHERE athlete_id = ?')
    .bind(athleteId)
    .first<{ d: string | null }>();
  return row?.d ?? null;
}

export async function setBackfillDone(athleteId: number): Promise<void> {
  await db().prepare('UPDATE athletes SET backfill_done = 1 WHERE id = ?').bind(athleteId).run();
}

export interface RideTotals {
  rides: number;
  distance_m: number;
  moving_time_s: number;
}

/**
 * Ride totals per gear per calendar month (athlete's local time), keyed by gear id.
 * `months` are 'YYYY-MM' keys; the result has one entry per key, in the same order.
 */
export async function monthlyTotalsByGear(athleteId: number, months: string[]): Promise<Map<string, RideTotals[]>> {
  const { results } = await db()
    .prepare(
      `SELECT gear_id, substr(start_date_local, 1, 7) AS month, COUNT(*) AS rides,
              SUM(distance_m) AS distance_m, SUM(moving_time_s) AS moving_time_s
       FROM activities
       WHERE athlete_id = ?1 AND gear_id IS NOT NULL AND start_date_local >= ?2
       GROUP BY gear_id, month`,
    )
    .bind(athleteId, `${months[0]}-01`)
    .all<RideTotals & { gear_id: string; month: string }>();

  const totals = new Map<string, RideTotals[]>();
  for (const r of results) {
    const i = months.indexOf(r.month);
    if (i < 0) continue;
    let perMonth = totals.get(r.gear_id);
    if (!perMonth) totals.set(r.gear_id, (perMonth = months.map(() => ({ rides: 0, distance_m: 0, moving_time_s: 0 }))));
    perMonth[i] = { rides: r.rides, distance_m: r.distance_m, moving_time_s: r.moving_time_s };
  }
  return totals;
}

export async function listCommutes(athleteId: number): Promise<Activity[]> {
  const { results } = await db()
    .prepare('SELECT * FROM activities WHERE athlete_id = ? AND commute = 1 ORDER BY start_date DESC')
    .bind(athleteId)
    .all<Activity>();
  return results;
}

// --- Rule job queue ----------------------------------------------------------------------------

export interface RuleJobItem {
  athlete_id: number;
  activity_id: number;
  rule_id: number;
  activity_json: string;
  status: 'pending' | 'working' | 'changed' | 'unchanged' | 'failed';
  error: string | null;
}

export interface RuleJobProgress {
  total: number;
  pending: number;
  changed: number;
  unchanged: number;
  failed: number;
  pausedUntil: number | null;
}

/** Replaces any previous job with these items. */
export async function enqueueRuleJob(
  athleteId: number,
  items: { activity: StravaActivity; ruleId: number }[],
): Promise<void> {
  await db().batch([
    db().prepare('DELETE FROM rule_job_items WHERE athlete_id = ?').bind(athleteId),
    db().prepare('UPDATE athletes SET rule_job_paused_until = NULL WHERE id = ?').bind(athleteId),
    ...items.map(({ activity, ruleId }) =>
      db()
        .prepare('INSERT INTO rule_job_items (athlete_id, activity_id, rule_id, activity_json) VALUES (?1, ?2, ?3, ?4)')
        .bind(athleteId, activity.id, ruleId, JSON.stringify(activity)),
    ),
  ]);
}

/**
 * Atomically claims up to `limit` pending items, so concurrent processors never handle the same ride.
 * Items stuck in 'working' for over 2 minutes (a processor that died) are released first.
 */
export async function claimRuleJobItems(athleteId: number, limit: number): Promise<RuleJobItem[]> {
  const now = Math.floor(Date.now() / 1000);
  await db()
    .prepare("UPDATE rule_job_items SET status = 'pending' WHERE athlete_id = ?1 AND status = 'working' AND claimed_at < ?2")
    .bind(athleteId, now - 120)
    .run();
  const { results } = await db()
    .prepare(
      `UPDATE rule_job_items SET status = 'working', claimed_at = ?2
       WHERE athlete_id = ?1 AND activity_id IN (
         SELECT activity_id FROM rule_job_items WHERE athlete_id = ?1 AND status = 'pending'
         ORDER BY activity_id DESC LIMIT ?3
       )
       RETURNING *`,
    )
    .bind(athleteId, now, limit)
    .all<RuleJobItem>();
  return results;
}

export async function finishRuleJobItem(
  athleteId: number,
  activityId: number,
  status: RuleJobItem['status'],
  error: string | null = null,
): Promise<void> {
  await db()
    .prepare('UPDATE rule_job_items SET status = ?3, error = ?4 WHERE athlete_id = ?1 AND activity_id = ?2')
    .bind(athleteId, activityId, status, error)
    .run();
}

export async function pauseRuleJob(athleteId: number, until: number | null): Promise<void> {
  await db().prepare('UPDATE athletes SET rule_job_paused_until = ?2 WHERE id = ?1').bind(athleteId, until).run();
}

export async function ruleJobProgress(athleteId: number): Promise<RuleJobProgress | null> {
  const { results } = await db()
    .prepare('SELECT status, COUNT(*) AS n FROM rule_job_items WHERE athlete_id = ? GROUP BY status')
    .bind(athleteId)
    .all<{ status: RuleJobItem['status']; n: number }>();
  if (results.length === 0) return null;
  const count = (s: RuleJobItem['status']) => results.find((r) => r.status === s)?.n ?? 0;
  const paused = await db()
    .prepare('SELECT rule_job_paused_until AS t FROM athletes WHERE id = ?')
    .bind(athleteId)
    .first<{ t: number | null }>();
  return {
    total: results.reduce((sum, r) => sum + r.n, 0),
    pending: count('pending') + count('working'),
    changed: count('changed'),
    unchanged: count('unchanged'),
    failed: count('failed'),
    pausedUntil: paused?.t && paused.t > Date.now() / 1000 ? paused.t : null,
  };
}

export async function failedRuleJobItems(athleteId: number, limit = 10): Promise<RuleJobItem[]> {
  const { results } = await db()
    .prepare("SELECT * FROM rule_job_items WHERE athlete_id = ? AND status = 'failed' LIMIT ?")
    .bind(athleteId, limit)
    .all<RuleJobItem>();
  return results;
}

/** Cancel: drops rides that weren't processed yet. Clear: removes the whole (finished) job. */
export async function cancelRuleJob(athleteId: number, onlyPending: boolean): Promise<void> {
  await db()
    .prepare(
      `DELETE FROM rule_job_items WHERE athlete_id = ?1 ${onlyPending ? "AND status IN ('pending', 'working')" : ''}`,
    )
    .bind(athleteId)
    .run();
  await pauseRuleJob(athleteId, null);
}
