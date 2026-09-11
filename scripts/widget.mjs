#!/usr/bin/env node
/**
 * Run or package the desktop widget.
 *
 *   node scripts/widget.mjs dev     -> npm run dev:widget
 *   node scripts/widget.mjs build   -> npm run build:installer
 *
 * The one thing worth knowing about `dev`: it does NOT need the single-file
 * sidecar. Building that binary needs postject and a working SEA toolchain,
 * and neither is guaranteed on a fresh clone, so the Rust side falls back to
 * running the plain TypeScript build:
 *
 *     node dist/cli/index.js --json
 *
 * This script guarantees that fallback exists before it starts Tauri, which is
 * why it always runs tsc and then actually executes the command to see that it
 * prints a JSON envelope. Zero extra setup: `npm install && npm run dev:widget`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  EXE_SUFFIX,
  ROOT,
  capture,
  die,
  exec,
  info,
  requireTauri,
  requireTauriProject,
  run,
  step,
  targetTriple,
  warn,
} from './lib/toolchain.mjs';

const MODES = new Set(['dev', 'build']);

const mode = process.argv[2];
if (!MODES.has(mode)) {
  die(`Usage: node scripts/widget.mjs <dev|build>\nGot: ${mode === undefined ? '(nothing)' : mode}`);
}
const passthrough = process.argv.slice(3);

/* -------------------------------------------------------------------------- */

/** Compile and then prove the dev fallback command actually works. */
function ensureDevFallback() {
  step('Building dist/ (the development fallback the Rust side shells out to)');
  const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc)) die('TypeScript is not installed. Run `npm install` first.');
  if (run(process.execPath, [tsc, '-p', 'tsconfig.json']).code !== 0) {
    die('tsc failed. Fix the compile errors above.');
  }

  const entry = join(ROOT, 'dist', 'cli', 'index.js');
  const probe = capture(process.execPath, [entry, '--json']);
  let parsed = null;
  try {
    parsed = JSON.parse(probe.stdout);
  } catch {
    parsed = null;
  }
  if (probe.failed || !Array.isArray(parsed?.results)) {
    die(
      'The development fallback does not work, so the widget would start with\n' +
        'no data and no way to get any.\n\n' +
        `  command: node dist/cli/index.js --json\n  exit:    ${probe.code}\n` +
        `  stderr:  ${probe.stderr.trim() || '(empty)'}`,
    );
  }
  info(`node dist/cli/index.js --json -> ${parsed.results.length} provider result(s), version ${parsed.version}`);
}

/**
 * The overlay config that declares the sidecar.
 *
 * WHY THE SIDECAR IS NOT DECLARED IN tauri.conf.json
 * --------------------------------------------------
 * `tauri-build` resolves `bundle.externalBin` at COMPILE time, not bundle
 * time: with it in the base config, a plain `cd src-tauri && cargo build`
 * fails with
 *
 *     resource path `binaries\quota-<triple>.exe` doesn't exist
 *
 * unless the 76 MB sidecar has already been built. `src-tauri/binaries/` is a
 * build artifact and is gitignored, so that would mean a fresh clone could not
 * compile the Rust at all - breaking this project's stated promise that "a
 * fresh clone should not have to care" about SEA.
 *
 * So the declaration lives here instead and is merged in with `--config` for
 * the installer only, after the sidecar has actually been built. Dev keeps
 * working with no sidecar because the Rust side falls back to
 * `node dist/cli/index.js --json`; an installed app has no checkout to fall
 * back on, which is exactly why the installer must carry the binary.
 */
const BUNDLE_CONFIG = 'tauri.bundle.conf.json';

function readConfig(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    warn(`could not read ${path} (${error.message})`);
    return null;
  }
}

/**
 * Check that every externalBin a config declares is actually on disk.
 *
 * Tauri resolves externalBin in dev too, and a missing file is a confusing
 * "binary not found", so say so up front. For the installer this is fatal: an
 * installer without the sidecar produces an app that cannot read anything.
 */
function checkSidecarPresence(projectDir, conf, { fatal }) {
  const external = conf?.bundle?.externalBin;
  if (!Array.isArray(external) || external.length === 0) {
    info('no externalBin declared by this config; nothing to check');
    return;
  }

  const { triple } = targetTriple();
  const missing = [];
  for (const entry of external) {
    const expected = join(projectDir, `${entry}-${triple}${EXE_SUFFIX}`);
    if (existsSync(expected)) {
      info(`sidecar present: ${expected}`);
    } else {
      missing.push(expected);
    }
  }
  if (missing.length === 0) return;

  if (fatal) {
    die(
      `The sidecar was just built, but it is not where Tauri will look for it:\n\n` +
        missing.map((path) => `  ${path}`).join('\n') +
        '\n\nThe installer would ship without it, and an installed app has no\n' +
        'checkout to fall back on, so every row would read "no quota CLI to run".\n' +
        'Check the --out-dir of scripts/build-sidecar.mjs.',
    );
  }
  for (const path of missing) warn(`sidecar missing: ${path}`);
  warn('Tauri resolves externalBin in dev too, so this may fail to start.');
  warn('Build it with `npm run build:sidecar`, or have the Rust side fall');
  warn('back to `node dist/cli/index.js --json` while developing.');
}

/* -------------------------------------------------------------------------- */

if (mode === 'dev') {
  ensureDevFallback();

  step('Checking the Tauri project');
  const projectDir = requireTauriProject();
  // Dev deliberately does NOT merge the bundle overlay: developing must not
  // require a 76 MB SEA build. The Rust side falls back to dist/ instead.
  checkSidecarPresence(projectDir, readConfig(join(projectDir, 'tauri.conf.json')), {
    fatal: false,
  });

  const tauri = requireTauri();
  step(`Starting the widget (${tauri.label} dev)`);
  info('The UI is served straight from ui/ - no bundler, no dev server of ours.');
  info('Quota data comes from `node dist/cli/index.js --json`, not the sidecar.');
  exec(tauri.command, [...tauri.args, 'dev', ...passthrough]);
} else {
  step('Building the sidecar first (the installer bundles it)');
  const sidecar = run(process.execPath, [join(ROOT, 'scripts', 'build-sidecar.mjs')]);
  if (sidecar.code !== 0) {
    die(
      'The sidecar build failed, so the installer would ship without it.\n' +
        'Fix the error above, or build the installer by hand once you have\n' +
        'a sidecar you trust.',
    );
  }

  step('Checking the Tauri project');
  const projectDir = requireTauriProject();

  // The installer MUST carry the sidecar, so the overlay that declares it is
  // merged in here and its binary is verified before Tauri is invoked.
  const overlayPath = join(projectDir, BUNDLE_CONFIG);
  if (!existsSync(overlayPath)) {
    die(
      `${overlayPath} does not exist.\n\n` +
        'That file is what declares bundle.externalBin: ["binaries/quota"], and\n' +
        'without it the installer would be built with no sidecar - producing an\n' +
        'app that cannot read anything on a machine with no checkout.',
    );
  }
  const overlay = readConfig(overlayPath);
  if (overlay === null) die(`${overlayPath} is not readable JSON; refusing to build without it.`);
  checkSidecarPresence(projectDir, overlay, { fatal: true });

  const tauri = requireTauri();
  step(`Building the installer (${tauri.label} build)`);
  info(`merging ${BUNDLE_CONFIG} so the bundle carries the sidecar`);
  // Absolute: the CLI is spawned with cwd=ROOT, not src-tauri/, and a relative
  // --config would be resolved against the wrong directory.
  exec(tauri.command, [...tauri.args, 'build', '--config', overlayPath, ...passthrough]);
}
