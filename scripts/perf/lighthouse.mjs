// Lab Core Web Vitals check: runs Lighthouse (mobile, simulated slow 4G) against a running server and fails
// when a page misses the "good" thresholds. Start the app first with `npm run preview`.
//
//   npm run test:perf                        # signed-out home page only
//   LH_ATHLETE_ID=999 npm run test:perf      # also the signed-in pages, as that athlete in the local D1
//
// Env: LH_BASE_URL (default http://localhost:8787), LH_ATHLETE_ID, LH_PATHS (comma-separated, overrides
// the default pages), CHROME_PATH (any Chrome/Chromium; e.g. a Playwright download).
import { createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as chromeLauncher from 'chrome-launcher';
import lighthouse from 'lighthouse';

const BASE = process.env.LH_BASE_URL ?? 'http://localhost:8787';
const athleteId = process.env.LH_ATHLETE_ID;

/**
 * "Good" Core Web Vitals thresholds (web.dev/articles/vitals). Lighthouse cannot measure INP, which needs a
 * real interaction, so Total Blocking Time stands in for it as Lighthouse recommends.
 */
const ASSERTIONS = [
  { audit: 'largest-contentful-paint', max: 2500, unit: 'ms' },
  { audit: 'cumulative-layout-shift', max: 0.1, unit: '' },
  { audit: 'total-blocking-time', max: 200, unit: 'ms' },
  { audit: 'first-contentful-paint', max: 1800, unit: 'ms' },
];
const MIN_SCORE = 0.9;

/** Same format as createSessionValue() in src/lib/auth.ts, signed with SESSION_SECRET from .dev.vars. */
function sessionCookie(id) {
  const secret =
    process.env.SESSION_SECRET ??
    readFileSync('.dev.vars', 'utf8').match(/^SESSION_SECRET\s*=\s*"?([^"\n]+)"?/m)?.[1];
  if (!secret) throw new Error('SESSION_SECRET not found in the environment or .dev.vars');
  const payload = `${id}.${Math.floor(Date.now() / 1000) + 3600}`;
  return `bl_session=${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

function defaultPaths() {
  if (process.env.LH_PATHS) return process.env.LH_PATHS.split(',').map((p) => p.trim());
  // Signed in, "/" is the bike overview; the first bike link gives a bike page.
  return athleteId ? ['/', '/bikes/', '/commutes', '/rules'] : ['/'];
}

const headers = athleteId ? { Cookie: sessionCookie(athleteId) } : {};

/** Resolves "/bikes/" to the first bike linked from the overview. */
async function resolve(path) {
  if (path !== '/bikes/') return path;
  const html = await (await fetch(BASE + '/', { headers })).text();
  const href = html.match(/href="(\/bikes\/[^"]+)"/)?.[1];
  if (!href) throw new Error('No bike link on the overview; set LH_PATHS instead.');
  return href;
}

// An explicit profile dir: under WSL, chrome-launcher otherwise creates a Windows-style path in the cwd.
const userDataDir = mkdtempSync(join(tmpdir(), 'lighthouse-'));
const chrome = await chromeLauncher.launch({ chromeFlags: ['--headless=new', '--no-sandbox'], userDataDir });
let failed = false;
mkdirSync('.lighthouse', { recursive: true });
try {
  for (const path of await Promise.all(defaultPaths().map(resolve))) {
    const url = BASE + path;
    const result = await lighthouse(url, {
      port: chrome.port,
      onlyCategories: ['performance'],
      extraHeaders: headers,
      output: 'html',
      logLevel: 'error',
    });
    if (!result) throw new Error(`Lighthouse returned nothing for ${url}`);
    const { lhr, report } = result;
    const file = `.lighthouse/${path.replace(/\W+/g, '_') || 'root'}.html`;
    writeFileSync(file, Array.isArray(report) ? report[0] : report);

    if (lhr.finalDisplayedUrl.replace(/\/$/, '') !== url.replace(/\/$/, '')) {
      console.log(`FAIL ${path}: redirected to ${lhr.finalDisplayedUrl} (is LH_ATHLETE_ID in the local D1?)`);
      failed = true;
      continue;
    }
    const score = lhr.categories.performance.score ?? 0;
    const lines = [`${score >= MIN_SCORE ? 'ok  ' : 'FAIL'} score ${Math.round(score * 100)} (min ${MIN_SCORE * 100})`];
    failed ||= score < MIN_SCORE;
    for (const { audit, max, unit } of ASSERTIONS) {
      const value = lhr.audits[audit]?.numericValue ?? Infinity;
      const ok = value <= max;
      failed ||= !ok;
      const shown = unit ? `${Math.round(value)} ${unit}` : value.toFixed(3);
      lines.push(`${ok ? 'ok  ' : 'FAIL'} ${audit}: ${shown} (max ${max}${unit && ' ' + unit})`);
    }
    console.log(`\n${path}  →  ${file}\n  ${lines.join('\n  ')}`);
  }
} finally {
  await chrome.kill();
  rmSync(userDataDir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
