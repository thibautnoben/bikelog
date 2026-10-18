# Bikelog

A logbook for your bikes: track wear on consumables (chain, tires, brake pads, sealant, …), let rules
pick the right bike for each Strava ride, and see the recent rides of every bike.
Bikes, kilometres and rides come from Strava; the app runs on Cloudflare Workers with a D1 database.

## How it works

- Sign in with Strava. On Android, sign-in uses Strava's mobile OAuth endpoint, which opens the
  Strava app when it is installed (Strava's mobile web login otherwise). Your bikes (Strava *My Gear*) and their odometers are synced automatically
  (at most every 30 minutes, or immediately with **Sync Strava**).
- For each bike you add components. A component remembers the bike odometer at install, so its
  distance is simply `current bike km − bike km at install (+ km already on it)`.
- Install, replace, service and remove dates may lie in the past: the distance ridden on that bike
  since then is summed from your Strava activities.
- Each component can have a lifespan in km, a lifespan in days (e.g. sealant, brake fluid), a
  service interval in km (e.g. chain lube/wax) and a battery with a life in hours of riding (electronic
  shifters, power meter, speed/cadence sensor), counted from the moving time of rides on that bike
  since the last battery change. Status turns **Soon** at 80 % and **Due** at 100 %
  of whichever limit is closest.
- Every action is written to a per-bike maintenance log, where you can also add free-text notes.
- Strava activities are stored too. Each bike shows a chart of kilometres per month for the last
  6 months (hover or tap a month for its riding time and number of rides). The **Commutes** page lists every ride marked as commute, grouped
  per month with totals. Your whole Strava history is imported: the newest 1,000 activities on the
  first sync, then older ones in the background on later syncs. New rides are fetched on every sync,
  and the last 7 days are re-checked so a bike or commute flag changed on Strava afterwards is
  picked up. With the webhook enabled, new, edited and deleted activities are updated immediately.
- **Rules** (`/rules`) update a ride automatically when it is uploaded to Strava, based on start
  location, end location, whether a power meter recorded the ride, and the ride type. Each rule
  chooses which fields it changes: bike, commute flag, title, description and/or private note.
  Private notes are not in Strava's documented API; the change log shows when Strava ignores one.
  Rules are checked top to bottom and the first match wins. Locations are named places with a
  radius. *Test on past rides* previews the rules on the last 30 days, 3 months or year and can
  apply them retroactively. Large selections are queued and processed in batches within Strava's
  rate limits (about 200 changes per 15 minutes); when the limit is hit the queue pauses until the
  next 15-minute window and continues by itself while you use the app. Every change is logged.

## Stack

- [Astro](https://astro.build) 7 (server output) with `@astrojs/cloudflare`
- Cloudflare D1 (`migrations/`)
- Strava OAuth + API (`src/lib/strava.ts`)
- Login session is an HMAC-signed cookie (`src/lib/auth.ts`); no KV needed

## 1. Create a Strava API application

At <https://www.strava.com/settings/api>:

- **Authorization Callback Domain**: your production domain (e.g. `bikelog.<you>.workers.dev`).
  `localhost` is always allowed for development.
- Note the **Client ID** and **Client Secret**.

## 2. Local development

```sh
npm install
cp .dev.vars.example .dev.vars        # fill in Strava id/secret and a random SESSION_SECRET
npm run db:migrate:local
npm run dev                           # http://localhost:4321
```

## 3. Deploy to Cloudflare

```sh
npx wrangler login
npx wrangler d1 create bikelog     # copy the database_id into wrangler.jsonc
npm run db:migrate:remote
npx wrangler secret put STRAVA_CLIENT_ID
npx wrangler secret put STRAVA_CLIENT_SECRET
npx wrangler secret put SESSION_SECRET    # e.g. output of `openssl rand -hex 32`
npx wrangler secret put STRAVA_WEBHOOK_TOKEN  # another random string
npm run deploy
```

These steps are only needed once. After that, deploys happen on every push to `main` (below).

### Continuous deployment (Workers Builds)

The GitHub repository is connected to the Worker with
[Cloudflare Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)
(*Workers & Pages → bikelog → Settings → Builds*). Every push to `main` builds and deploys:

| Setting | Value |
| --- | --- |
| Branch | `main` |
| Build command | `npm run check && npm run test:budget` |
| Deploy command | `npm run db:migrate:remote && npx wrangler deploy` |
| Root directory | `/` |

- A failing type check or byte budget stops the build, so nothing is deployed.
- Migrations run before the new code is deployed, so a migration must also work with the code that is
  still live: add tables and columns freely, but split a drop or rename over two deploys.
- The Worker name in Cloudflare must match `name` in `wrangler.jsonc`.
- Builds use a custom API token (*My Profile → API Tokens*), selected under *Builds → API token*. The
  token Cloudflare generates has no D1 access, so the migration step would fail with it. Permissions:
  Account › Workers Scripts › Edit, Account › D1 › Edit, Account › Account Settings › Read,
  User › User Details › Read, User › Memberships › Read.
- Builds of other branches (preview versions) would run migrations against the production database.
  Keep them disabled, or use a deploy command without the migration step for those branches.
- Runtime secrets (`wrangler secret put`) live on the Worker and are not part of the build.

### Enable gear rules (Strava webhook)

Gear rules need two things:

1. **Write permission.** Users grant `activity:write` when they sign in (Strava calls it
   "Upload your activities"). People who signed in before this feature existed see a
   *Reconnect Strava* link on the rules page.
2. **A webhook subscription**, created once per Strava app after the first deploy:

   ```sh
   curl -X POST https://www.strava.com/api/v3/push_subscriptions \
     -F client_id=<STRAVA_CLIENT_ID> \
     -F client_secret=<STRAVA_CLIENT_SECRET> \
     -F callback_url=https://<your-domain>/webhook/strava/<STRAVA_WEBHOOK_TOKEN> \
     -F verify_token=<STRAVA_WEBHOOK_TOKEN>
   ```

   Strava calls the URL right away to verify it, so the site must already be deployed. Check the
   subscription with
   `curl -G https://www.strava.com/api/v3/push_subscriptions -d client_id=... -d client_secret=...`.

Strava can't reach `localhost`, so webhooks only fire in production. Locally you can still create
rules and use *Test on recent rides*.

To keep the site for yourself, set `ALLOWED_ATHLETE_IDS` in `wrangler.jsonc` to your Strava athlete
id (the number in your Strava profile URL). If it is empty, anyone with a Strava account can sign in
and gets their own separate data.

## Scripts

| Script | |
| --- | --- |
| `npm run dev` | Astro dev server (runs in `workerd`, with local D1) |
| `npm run check` | Type-check |
| `npm run test:budget` | Build, then fail if JS, CSS or font bytes exceed their budgets (`scripts/perf/budget.mjs`) |
| `npm run test:perf` | Lighthouse lab Core Web Vitals check against a running `npm run preview` (see below) |
| `npm run preview` | Build and run with `wrangler dev` |
| `npm run deploy` | Build and deploy by hand (pushes to `main` deploy through Workers Builds) |
| `npm run db:migrate:local` / `db:migrate:remote` | Apply D1 migrations |
| `npm run cf-typegen` | Regenerate `worker-configuration.d.ts` after changing `wrangler.jsonc` |

## Performance

- No client framework: pages are server-rendered and ship no hydrated islands. The two small page scripts
  (bike form presets, rules page) are inlined by Astro, so there are no JS requests at all. Should an
  interactive component ever be needed, add it as an island with `client:visible`/`client:idle`;
  `test:budget` keeps its bundle in check.
- Each page loads its independent D1 queries in parallel. The `Server-Timing` response header shows the
  server's share of the time to first byte.
- JetBrains Mono is self-hosted through Astro's Fonts API (`astro.config.mjs`): hashed and cached
  immutably, preloaded, and with a metric-matched local fallback so the swap does not shift the layout.
- Chromium prefetches a page when a link to it is hovered (speculation rules in `Layout.astro`).
- `npm run test:perf` runs Lighthouse (mobile, simulated slow 4G) and fails below a score of 90 or when LCP,
  CLS, TBT (the lab stand-in for INP) or FCP miss the "good" thresholds. HTML reports go to `.lighthouse/`.
  Set `LH_ATHLETE_ID` to an athlete in the local D1 to audit the signed-in pages too; the script signs a
  session cookie with `SESSION_SECRET` from `.dev.vars`. It needs a Chrome/Chromium (`CHROME_PATH`).

## Dependencies and vulnerabilities

- `npm audit` checks every package in `package-lock.json`, indirect ones included, against GitHub's
  advisory database. `npm audit fix` applies the upgrades that stay within the version ranges in
  `package.json`.
- To block deploys with known high or critical vulnerabilities, prefix the Workers Builds build command
  with `npm audit --audit-level=high &&`. A newly published advisory then blocks deploys until the
  package is upgraded.
- Enable *Dependabot alerts* and *Dependabot security updates* in the GitHub repository
  (*Settings → Code security*) to get alerts and fix PRs when a new advisory affects a dependency.

## Notes

- Default lifespans per component type are in `src/lib/components.ts` and are only a starting
  point; every value can be edited per component.
- Strava API limits are 100 requests / 15 min and 1000 / day. Normal use needs one request per sync;
  back-dated actions need one request per 200 activities since that date. A gear rule uses one or
  two requests per uploaded ride.
- Strava privacy zones hide the real start and end of a ride, so give places near home a radius
  larger than your privacy zone.
- Webhook events for rides that started more than 14 days ago are ignored.
