#!/usr/bin/env node
/**
 * Regenerate ui/fixture.json.
 *
 * The fixture is what ui/index.html falls back to when `window.__TAURI__` is
 * absent, which is what makes the widget openable in a plain browser with no
 * toolchain at all. It has to be REAL captured output, not something written
 * by hand: a hand-made fixture is how a UI ends up quietly unable to render
 * the awkward cases - a null limit, a window that already reset, a provider
 * that failed - which are exactly the cases this tool exists to be honest
 * about.
 *
 *   node scripts/write-fixture.mjs [--out <path>]
 *
 * The output is YOUR usage: plan names, token counts, spend estimates. Read it
 * before committing.
 */

import { writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';

import { ROOT, capture, die, info, run, step } from './lib/toolchain.mjs';

let out = join(ROOT, 'ui', 'fixture.json');
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--out') {
    const value = argv[++i];
    if (value === undefined) die('--out needs a path');
    out = join(ROOT, value);
  } else {
    die(`Unknown option "${argv[i]}".\nUsage: node scripts/write-fixture.mjs [--out <path>]`);
  }
}

step('Building dist/');
const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
if (!existsSync(tsc)) die('TypeScript is not installed. Run `npm install` first.');
if (run(process.execPath, [tsc, '-p', 'tsconfig.json']).code !== 0) die('tsc failed.');

step('Capturing `quota --json`');
const result = capture(process.execPath, [join(ROOT, 'dist', 'cli', 'index.js'), '--json']);

let payload;
try {
  payload = JSON.parse(result.stdout);
} catch {
  payload = null;
}
if (result.failed || !Array.isArray(payload?.results)) {
  die(
    'The CLI did not print a JSON envelope, so there is nothing to capture.\n\n' +
      `exit code: ${result.code}\nstderr:\n${result.stderr.trim() || '(empty)'}\n` +
      `stdout (first 400 chars):\n${result.stdout.slice(0, 400)}`,
  );
}

const readings = payload.results.reduce((n, r) => n + (r.ok ? r.readings.length : 0), 0);
if (readings === 0) {
  die(
    'The capture contains no readings, which would make the browser preview\n' +
      'show the empty state forever. Run Claude Code or Codex at least once,\n' +
      'or keep the fixture you already have.',
  );
}

// Pretty-printed, because this file is read by humans doing design work.
writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

step('Done');
info(`${relative(ROOT, out)} - ${payload.results.length} provider result(s), ${readings} reading(s)`);
info('This is your real usage data. Check it before committing.');
if (payload.warnings.length > 0) info(`${payload.warnings.length} config warning(s) captured with it`);
