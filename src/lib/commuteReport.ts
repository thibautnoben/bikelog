import type { Activity, Athlete } from './db';
import { athletesWithReportEmail, listBikes, listCommutes } from './db';
import { sendEmail } from './email';
import { formatHours } from './periods';
import { syncStrava } from './sync';

const REPORT_DAYS = 30;
const DAY_MS = 86_400_000;

// --- CSV export --------------------------------------------------------------------------------

/** Quotes a CSV field; a leading = + - @ is neutralised so spreadsheets don't run it as a formula. */
function csvField(value: string | number): string {
  let s = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** start_date_local is the athlete's wall-clock time with a misleading 'Z' suffix. */
const localDate = (a: Activity) => a.start_date_local.slice(0, 10);
const localTime = (a: Activity) => a.start_date_local.slice(11, 16);
const bikeName = (a: Activity, bikeNames: Map<string, string>) =>
  a.gear_id ? (bikeNames.get(a.gear_id) ?? 'Other gear') : '';

/** One row per commute, oldest first, with a totals row at the end. */
export function commutesCsv(commutes: Activity[], bikeNames: Map<string, string>): string {
  const rows: (string | number)[][] = [
    ['Date', 'Start time', 'Ride', 'Bike', 'Distance (km)', 'Moving time (min)', 'Elevation (m)', 'Strava'],
  ];
  const sorted = [...commutes].sort((a, b) => a.start_date.localeCompare(b.start_date));
  for (const a of sorted) {
    rows.push([
      localDate(a),
      localTime(a),
      a.name,
      bikeName(a, bikeNames),
      (a.distance_m / 1000).toFixed(2),
      Math.round(a.moving_time_s / 60),
      Math.round(a.elevation_gain_m),
      `https://www.strava.com/activities/${a.id}`,
    ]);
  }
  const t = totals(commutes);
  rows.push(['Total', '', `${t.rides} commutes`, '', (t.distance_m / 1000).toFixed(2), Math.round(t.moving_time_s / 60), Math.round(t.elevation_m), '']);
  // CRLF line endings and a BOM so Excel opens it as UTF-8.
  return '﻿' + rows.map((r) => r.map(csvField).join(',')).join('\r\n') + '\r\n';
}

// --- Summary -----------------------------------------------------------------------------------

interface Totals {
  rides: number;
  days: number;
  distance_m: number;
  moving_time_s: number;
  elevation_m: number;
  byBike: [string, { rides: number; distance_m: number }][];
}

function totals(commutes: Activity[], bikeNames = new Map<string, string>()): Totals {
  const byBike = new Map<string, { rides: number; distance_m: number }>();
  for (const a of commutes) {
    const name = bikeName(a, bikeNames) || 'No bike';
    const b = byBike.get(name) ?? { rides: 0, distance_m: 0 };
    b.rides++;
    b.distance_m += a.distance_m;
    byBike.set(name, b);
  }
  return {
    rides: commutes.length,
    days: new Set(commutes.map(localDate)).size,
    distance_m: commutes.reduce((s, a) => s + a.distance_m, 0),
    moving_time_s: commutes.reduce((s, a) => s + a.moving_time_s, 0),
    elevation_m: commutes.reduce((s, a) => s + a.elevation_gain_m, 0),
    byBike: [...byBike].sort((a, b) => b[1].distance_m - a[1].distance_m),
  };
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const km = (m: number) => `${(m / 1000).toLocaleString('en-GB', { maximumFractionDigits: 1 })} km`;
const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const longDay = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

export interface CommuteReport {
  subject: string;
  html: string;
  text: string;
  csv: string;
  filename: string;
  rides: number;
}

/** Summary of the commutes between `from` and `to`; `commutes` may be in any order. */
export function buildCommuteReport(
  athlete: Pick<Athlete, 'firstname'>,
  commutes: Activity[],
  bikeNames: Map<string, string>,
  from: Date,
  to: Date,
  origin?: string,
): CommuteReport {
  const t = totals(commutes, bikeNames);
  const sorted = [...commutes].sort((a, b) => a.start_date.localeCompare(b.start_date));
  const period = `${longDay(from)} – ${longDay(to)}`;
  const rides = `${t.rides} commute${t.rides === 1 ? '' : 's'}`;
  const subject = `Commutes: ${rides}, ${km(t.distance_m)} in the last ${REPORT_DAYS} days`;
  const hello = athlete.firstname ? `Hi ${athlete.firstname},` : 'Hi,';

  const stats: [string, string][] = [
    ['Commutes', String(t.rides)],
    ['Days commuted', String(t.days)],
    ['Distance', km(t.distance_m)],
    ['Moving time', formatHours(t.moving_time_s)],
    ['Elevation', `${Math.round(t.elevation_m).toLocaleString('en-GB')} m`],
  ];
  if (t.rides > 0) stats.push(['Average per commute', km(t.distance_m / t.rides)]);

  const text = [
    hello,
    '',
    `Your commutes from ${period}:`,
    '',
    ...stats.map(([k, v]) => `  ${k}: ${v}`),
    ...(t.byBike.length > 1 ? ['', 'Per bike:', ...t.byBike.map(([n, b]) => `  ${n}: ${b.rides} × ${km(b.distance_m)}`)] : []),
    '',
    ...(t.rides > 0
      ? ['Rides:', ...sorted.map((a) => `  ${day(a.start_date_local)} ${localTime(a)}  ${a.name}  ${km(a.distance_m)}`)]
      : ['No rides were marked as commute in this period.']),
    '',
    'The rides are attached as a CSV file.',
    ...(origin ? ['', `${origin}/commutes`] : []),
  ].join('\n');

  const cell = 'padding:4px 8px;border-bottom:1px solid #ddd;';
  const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#222;max-width:640px;margin:0 auto;padding:16px">
<p>${escapeHtml(hello)}</p>
<p>Your commutes from <strong>${escapeHtml(period)}</strong>:</p>
<table style="border-collapse:collapse;margin-bottom:16px">${stats
    .map(([k, v]) => `<tr><td style="${cell}color:#666">${escapeHtml(k)}</td><td style="${cell}font-weight:600;text-align:right">${escapeHtml(v)}</td></tr>`)
    .join('')}</table>
${
  t.byBike.length > 1
    ? `<p style="color:#666">${t.byBike.map(([n, b]) => `${escapeHtml(n)}: ${b.rides} × ${escapeHtml(km(b.distance_m))}`).join(' · ')}</p>`
    : ''
}
${
  t.rides > 0
    ? `<table style="border-collapse:collapse;width:100%;font-size:14px"><thead><tr>
<th style="${cell}text-align:left">Date</th><th style="${cell}text-align:left">Ride</th><th style="${cell}text-align:right">Distance</th><th style="${cell}text-align:right">Time</th>
</tr></thead><tbody>${sorted
        .map(
          (a) => `<tr><td style="${cell}white-space:nowrap">${escapeHtml(day(a.start_date_local))} ${localTime(a)}</td>
<td style="${cell}"><a href="https://www.strava.com/activities/${a.id}" style="color:#fc4c02">${escapeHtml(a.name)}</a></td>
<td style="${cell}text-align:right;white-space:nowrap">${escapeHtml(km(a.distance_m))}</td>
<td style="${cell}text-align:right;white-space:nowrap">${escapeHtml(formatHours(a.moving_time_s))}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : '<p>No rides were marked as commute in this period.</p>'
}
<p style="color:#666;font-size:13px">The rides are attached as a CSV file.${
    origin ? ` <a href="${escapeHtml(origin)}/commutes" style="color:#666">Open Bikelog</a>` : ''
  }</p>
</body></html>`;

  return {
    subject,
    html,
    text,
    csv: commutesCsv(commutes, bikeNames),
    filename: `commutes-${from.toISOString().slice(0, 10)}-to-${to.toISOString().slice(0, 10)}.csv`,
    rides: t.rides,
  };
}

// --- Sending -----------------------------------------------------------------------------------

/**
 * E-mails the athlete a summary of their commutes in the `REPORT_DAYS` days before `now`.
 * @param idempotencyKey for scheduled sends only: a manual send with the same key would make Resend reject the next one.
 */
export async function sendCommuteReport(
  athlete: Athlete,
  now = new Date(),
  { origin, idempotencyKey }: { origin?: string; idempotencyKey?: string } = {},
): Promise<number> {
  if (!athlete.report_email) throw new Error('No report e-mail address set');
  const from = new Date(now.getTime() - REPORT_DAYS * DAY_MS);
  const [commutes, bikes] = await Promise.all([
    listCommutes(athlete.id, from.toISOString(), now.toISOString()),
    listBikes(athlete.id),
  ]);
  const report = buildCommuteReport(athlete, commutes, new Map(bikes.map((b) => [b.id, b.name])), from, now, origin);
  await sendEmail({
    to: athlete.report_email,
    subject: report.subject,
    html: report.html,
    text: report.text,
    attachments: [{ filename: report.filename, content: report.csv, contentType: 'text/csv' }],
    idempotencyKey,
  });
  return report.rides;
}

/**
 * Cron job (25th of each month, see `triggers` in wrangler.jsonc): syncs Strava for every athlete who
 * set a report address, so the latest rides are included, then sends them their summary.
 */
export async function sendMonthlyCommuteReports(
  waitUntil: (promise: Promise<unknown>) => void,
  now = new Date(),
): Promise<void> {
  const athletes = await athletesWithReportEmail();
  const failures: string[] = [];
  for (const athlete of athletes) {
    try {
      await syncStrava(athlete, true, waitUntil);
    } catch (e) {
      // Still send what is stored; at worst the last few rides are missing.
      console.error(`Commute report: Strava sync failed for athlete ${athlete.id}:`, e);
    }
    try {
      const rides = await sendCommuteReport(athlete, now, {
        idempotencyKey: `commute-report/${athlete.id}/${now.toISOString().slice(0, 10)}`,
      });
      console.log(`Commute report: sent ${rides} commutes to athlete ${athlete.id}`);
    } catch (e) {
      console.error(`Commute report: sending failed for athlete ${athlete.id}:`, e);
      failures.push(athlete.id);
    }
  }
  // Fail the invocation so it shows up as an error in the Workers cron dashboard.
  if (failures.length > 0) throw new Error(`Commute report failed for athletes ${failures.join(', ')}`);
}
