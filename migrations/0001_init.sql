-- Distances are stored in metres, as Strava returns them. Dates are ISO 'YYYY-MM-DD'; timestamps are unix seconds.

CREATE TABLE athletes (
  id                     INTEGER PRIMARY KEY,           -- Strava athlete id
  firstname              TEXT,
  lastname               TEXT,
  access_token           TEXT    NOT NULL,
  refresh_token          TEXT    NOT NULL,
  expires_at             INTEGER NOT NULL,
  scope                  TEXT,                          -- scopes granted on the last Strava login (comma-separated)
  last_synced_at         INTEGER,
  backfill_done          INTEGER NOT NULL DEFAULT 0,    -- whole history imported (see backfillActivities in src/lib/sync.ts)
  rule_job_paused_until  INTEGER,                       -- Strava rate limit hit; the rule job resumes after this time
  created_at             INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE bikes (
  id               TEXT    PRIMARY KEY,           -- Strava gear id, e.g. 'b1234567'
  athlete_id       INTEGER NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  name             TEXT    NOT NULL,
  odometer_m       REAL    NOT NULL DEFAULT 0,    -- total distance according to Strava
  is_primary       INTEGER NOT NULL DEFAULT 0,
  retired          INTEGER NOT NULL DEFAULT 0,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX bikes_athlete ON bikes(athlete_id);

CREATE TABLE components (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  bike_id                 TEXT    NOT NULL REFERENCES bikes(id) ON DELETE CASCADE,
  kind                    TEXT    NOT NULL,     -- see COMPONENT_KINDS in src/lib/components.ts
  label                   TEXT,                 -- brand / model
  installed_on            TEXT    NOT NULL,
  installed_odometer_m    REAL    NOT NULL,     -- bike odometer at install
  initial_m               REAL    NOT NULL DEFAULT 0, -- distance already on the part when installed
  -- Limits. Electronic parts (isBatteryKind()) use only the battery and day limits, never the km ones.
  lifespan_km             INTEGER,
  lifespan_days           INTEGER,
  service_interval_km     INTEGER,              -- e.g. chain lube / wax
  battery_type            TEXT,                 -- e.g. CR2032
  battery_interval_hours  INTEGER,              -- hours of riding on the bike between battery changes
  last_service_on         TEXT,
  last_service_odometer_m REAL,
  last_battery_on         TEXT,                 -- NULL = since install
  removed_on              TEXT,
  removed_odometer_m      REAL,
  notes                   TEXT,
  created_at              INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX components_bike ON components(bike_id, removed_on);

CREATE TABLE events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  bike_id       TEXT    NOT NULL REFERENCES bikes(id) ON DELETE CASCADE,
  component_id  INTEGER REFERENCES components(id) ON DELETE SET NULL,
  type          TEXT    NOT NULL,               -- install | remove | service | battery | note
  happened_on   TEXT    NOT NULL,
  odometer_m    REAL,
  description   TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX events_bike ON events(bike_id, happened_on);

-- Strava activities, kept in sync for the monthly chart, recent rides and commutes.
CREATE TABLE activities (
  id                 INTEGER PRIMARY KEY,           -- Strava activity id
  athlete_id         INTEGER NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  gear_id            TEXT,                          -- Strava gear id; not a FK, may be shoes or unknown gear
  name               TEXT    NOT NULL,
  sport_type         TEXT    NOT NULL,
  start_date         TEXT    NOT NULL,              -- ISO UTC
  start_date_local   TEXT    NOT NULL,              -- ISO, athlete's local time
  distance_m         REAL    NOT NULL DEFAULT 0,
  moving_time_s      INTEGER NOT NULL DEFAULT 0,
  elevation_gain_m   REAL    NOT NULL DEFAULT 0,
  device_watts       INTEGER NOT NULL DEFAULT 0,
  commute            INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX activities_gear ON activities(athlete_id, gear_id, start_date DESC);
CREATE INDEX activities_athlete ON activities(athlete_id, start_date DESC);
CREATE INDEX activities_commute ON activities(athlete_id, commute, start_date DESC);

-- Named locations with a radius, used as rule conditions.
CREATE TABLE places (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  athlete_id  INTEGER NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  lat         REAL    NOT NULL,
  lng         REAL    NOT NULL,
  radius_m    INTEGER NOT NULL DEFAULT 300
);
CREATE INDEX places_athlete ON places(athlete_id);

-- Evaluated in `position` order; the first enabled rule whose conditions all match applies its actions.
CREATE TABLE gear_rules (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  athlete_id        INTEGER NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  position          INTEGER NOT NULL,
  name              TEXT,
  -- Conditions; NULL = any
  start_place_id    INTEGER REFERENCES places(id),
  end_place_id      INTEGER REFERENCES places(id),
  power_meter       TEXT    NOT NULL DEFAULT 'any' CHECK (power_meter IN ('any', 'yes', 'no')),
  sport_type        TEXT,                           -- Strava sport_type
  -- Actions; NULL / 0 = leave that field alone
  gear_id           TEXT    REFERENCES bikes(id) ON DELETE SET NULL,
  mark_commute      INTEGER NOT NULL DEFAULT 0,
  set_name          TEXT,
  set_description   TEXT,
  set_private_note  TEXT,
  enabled           INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX gear_rules_athlete ON gear_rules(athlete_id, position);

-- Change log of every ride a rule updated.
CREATE TABLE gear_assignments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  athlete_id      INTEGER NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  activity_id     INTEGER NOT NULL,
  activity_name   TEXT,
  activity_date   TEXT,
  from_gear_id    TEXT,
  to_gear_id      TEXT    NOT NULL,
  marked_commute  INTEGER NOT NULL DEFAULT 0,
  changed_fields  TEXT,                           -- 'gear,commute,name,description,private_note'
  warning         TEXT,                           -- e.g. Strava ignored the private note
  rule_id         INTEGER REFERENCES gear_rules(id) ON DELETE SET NULL,
  source          TEXT    NOT NULL,               -- webhook | manual
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX gear_assignments_athlete ON gear_assignments(athlete_id, created_at);

-- Queue for applying rules to many past rides, processed in batches within Strava's rate limits.
CREATE TABLE rule_job_items (
  athlete_id     INTEGER NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  activity_id    INTEGER NOT NULL,
  rule_id        INTEGER NOT NULL,
  activity_json  TEXT    NOT NULL,                -- Strava summary activity at the time of queueing
  status         TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'working', 'changed', 'unchanged', 'failed')),
  claimed_at     INTEGER,
  error          TEXT,
  PRIMARY KEY (athlete_id, activity_id)
);
CREATE INDEX rule_job_items_status ON rule_job_items(athlete_id, status);
