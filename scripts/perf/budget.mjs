// Fails when the built client assets outgrow their byte budgets. Run after `astro build`.
// Sizes are gzip-compressed (what the browser downloads), except fonts, which are already compressed.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';

const ROOT = new URL('../../dist/client/', import.meta.url).pathname;

/** Budgets in bytes per asset type, for the whole site. */
const BUDGETS = {
  js: 10_000, // Page scripts are inlined today; an external bundle (e.g. a framework island) must stay small.
  css: 4_000,
  font: 40_000,
};

const typeOf = (file) =>
  file.endsWith('.js') && !file.endsWith('/sw.js') ? 'js' : file.endsWith('.css') ? 'css' : /\.woff2?$/.test(file) ? 'font' : null;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

const totals = { js: 0, css: 0, font: 0 };
for (const file of walk(ROOT)) {
  const type = typeOf(file);
  if (!type) continue;
  const bytes = type === 'font' ? statSync(file).size : gzipSync(readFileSync(file)).length;
  totals[type] += bytes;
  console.log(`  ${type.padEnd(4)} ${String(bytes).padStart(7)} B  ${relative(ROOT, file)}`);
}

let failed = false;
for (const [type, budget] of Object.entries(BUDGETS)) {
  const ok = totals[type] <= budget;
  failed ||= !ok;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${type}: ${totals[type]} B of ${budget} B`);
}
process.exit(failed ? 1 : 0);
