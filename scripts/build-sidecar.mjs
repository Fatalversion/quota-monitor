#!/usr/bin/env node
/**
 * Build the standalone `quota` sidecar that ships inside the Tauri app.
 *
 * The pipeline, and why each step is here:
 *
 *   1. tsc                 src/ -> dist/, the same output `npm run build` makes
 *   2. bundle              dist/ + node_modules/yaml -> one CommonJS file,
 *                          because Node's SEA loader can only require() built-in
 *                          modules (see scripts/lib/bundle.mjs)
 *   3. node --check        the generated file must at least parse
 *   4. plain-node smoke    run the bundle under normal node and parse its JSON,
 *                          so a bundler bug is caught before SEA muddies it
 *   5. sea-config          node --experimental-sea-config makes the blob
 *   6. copy node           the binary is a copy of this very node executable
 *   7. postject            inject the blob into that copy
 *   8. verify              run the finished binary and diff it against dist/
 *   9. install             drop it where Tauri's externalBin expects it
 *
 * Nothing here is allowed to half-succeed. If postject is missing, or the
 * finished binary does not answer correctly, the partial executable is deleted
 * and the script exits non-zero with the command that fixes it. A sidecar that
 * exists but is broken is worse than no sidecar: Tauri would happily bundle it.
 *
 * Usage:
 *   node scripts/build-sidecar.mjs [--target <triple>] [--out-dir <dir>]
 *                                  [--skip-tsc] [--keep-intermediates]
 */

import { mkdirSync, copyFileSync, rmSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { bundle } from './lib/bundle.mjs';
import {
  EXE_SUFFIX,
  IS_WINDOWS,
  ROOT,
  capture,
  die,
  info,
  run,
  step,
  targetTriple,
  warn,
} from './lib/toolchain.mjs';

/** Node's documented magic string; postject replaces it with the blob offset. */
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const BUILD_DIR = join(ROOT, 'build', 'sea');
const BUNDLE_FILE = join(BUILD_DIR, 'quota.cjs');
const BLOB_FILE = join(BUILD_DIR, 'quota.blob');
const SEA_CONFIG = 'sea-config.json';
const ENTRY = join(ROOT, 'dist', 'cli', 'index.js');

/* -------------------------------------------------------------------------- */

function parseArgs(argv) {
  const options = { target: null, outDir: null, skipTsc: false, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--target') options.target = argv[++i] ?? null;
    else if (arg === '--out-dir') options.outDir = argv[++i] ?? null;
    else if (arg === '--skip-tsc') options.skipTsc = true;
    else if (arg === '--keep-intermediates') options.keep = true;
    else die(`Unknown option "${arg}".\nUsage: node scripts/build-sidecar.mjs [--target <triple>] [--out-dir <dir>] [--skip-tsc] [--keep-intermediates]`);
  }
  return options;
}

function kb(path) {
  return `${(statSync(path).size / 1024).toFixed(0)} KB`;
}

/** Delete a half-built executable so nothing downstream can pick it up. */
function scrap(path, message) {
  if (existsSync(path)) {
    rmSync(path, { force: true });
    warn(`removed the incomplete binary at ${path}`);
  }
  die(message);
}

/* -------------------------------------------------------------------------- */
/* postject                                                                   */
/* -------------------------------------------------------------------------- */

const POSTJECT_HELP = [
  'postject is required to inject the SEA blob into the node binary, and it',
  'could not be found or fetched.',
  '',
  'It is deliberately NOT a dependency of this project - it is a build-time',
  'tool, and quota-monitor ships with exactly one runtime dependency. Install',
  'it whichever way suits you:',
  '',
  '  npm install -g postject          # once, globally',
  '  npm install -D postject          # or pin it into this repo',
  '',
  'or make sure the machine can reach the npm registry, since the script also',
  'tries `npx --yes postject`.',
  '',
  'Without it there is no sidecar. Development still works without one:',
  '',
  '  npm run build && node dist/cli/index.js --json',
].join('\n');

/**
 * Find something that can run postject, in order of least surprise:
 * a local install, then one on PATH, then npx (which may fetch it).
 */
function findPostject() {
  const local = join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js');
  if (existsSync(local)) return { command: process.execPath, args: [local], label: 'node_modules/postject' };

  const onPath = capture('postject', ['--help']);
  if (!onPath.failed) return { command: 'postject', args: [], label: 'postject (PATH)' };

  info('postject is not installed locally; trying `npx --yes postject`');
  const viaNpx = capture('npx', ['--yes', 'postject', '--help']);
  if (!viaNpx.failed) return { command: 'npx', args: ['--yes', 'postject'], label: 'npx postject' };

  return null;
}

/* -------------------------------------------------------------------------- */

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const triple = options.target
    ? { triple: options.target, source: '--target' }
    : targetTriple();

  /*
   * There is no cross-compiling here, and pretending otherwise would ship a
   * corrupt sidecar. A SEA binary IS a copy of the node executable currently
   * running, with a blob injected: build on Windows and you get a Windows PE,
   * whatever you name it. Build each platform's sidecar on that platform.
   */
  const targetOs = /windows/.test(triple.triple)
    ? 'win32'
    : /apple|darwin/.test(triple.triple)
      ? 'darwin'
      : /linux/.test(triple.triple)
        ? 'linux'
        : 'unknown';
  if (targetOs !== 'unknown' && targetOs !== process.platform) {
    die(
      `Cannot build a ${targetOs} sidecar on ${process.platform}.\n\n` +
        'A single-executable app is a copy of the running node binary with a\n' +
        `blob injected, so this would produce a ${process.platform} executable\n` +
        `named "quota-${triple.triple}${EXE_SUFFIX}" - which the ${targetOs} installer would\n` +
        'happily bundle and then fail to run. Build it on a ' + targetOs + ' machine.',
    );
  }

  /*
   * Tauri resolves `bundle.externalBin: ["binaries/quota"]` to
   * `binaries/quota-<target triple><exe suffix>`, so the suffix is not
   * decoration - it is how the bundler finds the file at all. See the long
   * note on targetTriple() in scripts/lib/toolchain.mjs.
   *
   * That declaration lives in src-tauri/tauri.bundle.conf.json and is merged
   * in by `npm run build:installer`; see scripts/widget.mjs.
   */
  const binaryName = `quota-${triple.triple}${EXE_SUFFIX}`;
  const stagedBinary = join(BUILD_DIR, binaryName);
  const outDir = options.outDir ? join(ROOT, options.outDir) : join(ROOT, 'src-tauri', 'binaries');
  const installedBinary = join(outDir, binaryName);

  info(`quota-monitor ${pkg.version}`);
  info(`node          ${process.version} (${process.execPath})`);
  info(`target triple ${triple.triple}  [${triple.source}]`);
  info(`sidecar name  ${binaryName}`);

  mkdirSync(BUILD_DIR, { recursive: true });

  /* -- 1. typescript ------------------------------------------------------ */
  if (options.skipTsc) {
    info('skipping tsc (--skip-tsc)');
  } else {
    step('Compiling TypeScript to dist/');
    const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
    if (!existsSync(tsc)) die('TypeScript is not installed. Run `npm install` first.');
    const built = run(process.execPath, [tsc, '-p', 'tsconfig.json']);
    if (built.code !== 0) die('tsc failed. Fix the compile errors above.');
  }
  if (!existsSync(ENTRY)) die(`${ENTRY} does not exist; the tsc build produced nothing to bundle.`);

  /* -- 2. bundle ---------------------------------------------------------- */
  step('Bundling to a single CommonJS file');
  let built;
  try {
    built = await bundle({ entry: ENTRY, root: ROOT, versionStamp: pkg.version });
  } catch (error) {
    die(`${error.message}\n\nThe SEA bundler refuses to guess. See scripts/lib/bundle.mjs.`);
  }
  writeFileSync(BUNDLE_FILE, built.code, 'utf8');
  info(`${built.moduleCount} modules -> ${BUNDLE_FILE} (${kb(BUNDLE_FILE)})`);

  /* -- 3. parse check ----------------------------------------------------- */
  step('Checking the bundle parses');
  if (run(process.execPath, ['--check', BUNDLE_FILE]).code !== 0) {
    die('The generated bundle is not valid JavaScript. This is a bundler bug.');
  }
  info('ok');

  /* -- 4. smoke test under plain node ------------------------------------- */
  step('Running the bundle under plain node');
  const smoke = capture(process.execPath, [BUNDLE_FILE, '--json']);
  const smokeJson = parseEnvelope(smoke.stdout);
  if (smoke.failed || smokeJson === null) {
    die(
      'The bundle did not print a usable JSON envelope.\n\n' +
        `exit code: ${smoke.code}\nstderr:\n${smoke.stderr.trim() || '(empty)'}\n` +
        `stdout (first 400 chars):\n${smoke.stdout.slice(0, 400)}`,
    );
  }
  info(`ok - ${smokeJson.results.length} provider result(s), version ${smokeJson.version}`);

  /* -- 5. sea blob -------------------------------------------------------- */
  step('Generating the SEA preparation blob');
  const blob = run(process.execPath, ['--experimental-sea-config', SEA_CONFIG]);
  if (blob.code !== 0 || !existsSync(BLOB_FILE)) {
    die(`node --experimental-sea-config ${SEA_CONFIG} failed. Node ${process.version} must be >= 20.`);
  }
  info(`${BLOB_FILE} (${kb(BLOB_FILE)})`);

  /* -- 6. copy the node binary -------------------------------------------- */
  step('Copying the node runtime');
  rmSync(stagedBinary, { force: true });
  copyFileSync(process.execPath, stagedBinary);
  info(`${stagedBinary} (${kb(stagedBinary)})`);

  if (IS_WINDOWS) {
    // node.exe is Authenticode-signed. Injecting a blob invalidates that
    // signature, and an invalid signature is worse than none: it can trip
    // SmartScreen and some enterprise policies. Remove it if we can, say so
    // if we cannot. Either way the installer build should sign the app.
    const signtool = capture('where', ['signtool']);
    if (!signtool.failed) {
      const stripped = run('signtool', ['remove', '/s', stagedBinary]);
      info(stripped.code === 0 ? 'stripped node.exe Authenticode signature' : 'signtool could not strip the signature (continuing)');
    } else {
      warn("signtool not found: the binary keeps node.exe's now-invalid signature.");
      warn('postject will warn about this. Sign the finished app in the installer step.');
    }
  }

  /* -- 7. inject ---------------------------------------------------------- */
  step('Injecting the blob with postject');
  const postject = findPostject();
  if (postject === null) scrap(stagedBinary, POSTJECT_HELP);
  info(`using ${postject.label}`);

  const injectArgs = [
    ...postject.args,
    stagedBinary,
    'NODE_SEA_BLOB',
    BLOB_FILE,
    '--sentinel-fuse',
    SEA_FUSE,
    ...(process.platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : []),
  ];
  if (run(postject.command, injectArgs).code !== 0) {
    scrap(stagedBinary, 'postject failed to inject the blob (see its output above).');
  }

  /* -- 8. verify ---------------------------------------------------------- */
  step('Verifying the finished binary');

  const version = capture(stagedBinary, ['--version']);
  if (version.failed) {
    scrap(stagedBinary, `The binary failed to run \`--version\`:\n${version.stderr || version.stdout}`);
  }
  if (version.stdout.trim() !== pkg.version) {
    scrap(
      stagedBinary,
      `The binary reports version "${version.stdout.trim()}" but package.json says "${pkg.version}".\n` +
        'The build-time version stamp in the bundle is wrong.',
    );
  }
  info(`--version    ${version.stdout.trim()}`);

  const live = capture(stagedBinary, ['--json']);
  const liveJson = parseEnvelope(live.stdout);
  if (live.failed || liveJson === null) {
    scrap(
      stagedBinary,
      `The binary did not print a usable JSON envelope.\n\nexit code: ${live.code}\n` +
        `stderr:\n${live.stderr.trim() || '(empty)'}\nstdout (first 400 chars):\n${live.stdout.slice(0, 400)}`,
    );
  }
  info(`--json       ${liveJson.results.length} provider result(s), ${countReadings(liveJson)} reading(s)`);

  // The binary and the TypeScript build must agree about which providers exist
  // and what each one reported. Values move between runs (that is the point of
  // the tool), so compare shape, not numbers.
  const reference = capture(process.execPath, [ENTRY, '--json']);
  const referenceJson = parseEnvelope(reference.stdout);
  if (referenceJson !== null) {
    const a = shapeOf(liveJson);
    const b = shapeOf(referenceJson);
    if (a !== b) {
      scrap(
        stagedBinary,
        'The binary and `node dist/cli/index.js --json` disagree:\n' +
          `  binary: ${a}\n  dist:   ${b}\n\nThat is a bundler bug, not a provider difference.`,
      );
    }
    info(`matches \`node dist/cli/index.js --json\`: ${a}`);
  } else {
    warn('could not run dist/cli/index.js for comparison; skipped the cross-check');
  }

  /* -- 9. install --------------------------------------------------------- */
  step('Installing the sidecar');

  // Only ever write INTO an existing src-tauri/. Conjuring the directory here
  // would leave a stray tree for `tauri init` to trip over, and the Rust shell
  // is not this script's to create.
  const tauriProjectMissing =
    options.outDir === null && !existsSync(join(ROOT, 'src-tauri'));

  if (tauriProjectMissing) {
    warn('src-tauri/ does not exist yet, so there is nowhere to install to.');
    info(`The finished binary is staged at ${stagedBinary}`);
    info('Re-run this once the Tauri shell exists, or pass --out-dir <dir>.');
  } else {
    mkdirSync(outDir, { recursive: true });
    copyFileSync(stagedBinary, installedBinary);
    info(`${installedBinary} (${kb(installedBinary)})`);
  }

  if (!options.keep) {
    rmSync(BLOB_FILE, { force: true });
  }

  step('Done');
  info('`npm run build:installer` bundles this by merging src-tauri/tauri.bundle.conf.json,');
  info('which declares bundle.externalBin: ["binaries/quota"]');
  info('Development does not need it at all: node dist/cli/index.js --json');
  process.stdout.write('\n');
}

/** Parse a `quota --json` envelope, or null if it is not one. */
function parseEnvelope(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    if (!Array.isArray(parsed?.results)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function countReadings(envelope) {
  return envelope.results.reduce((n, r) => n + (r.ok ? r.readings.length : 0), 0);
}

/** A stable description of an envelope: which providers, with how many rows. */
function shapeOf(envelope) {
  return envelope.results
    .map((r) => (r.ok ? `${r.id}:ok:${r.readings.map((x) => x.window).join('+')}` : `${r.id}:error`))
    .join(' ');
}

await main();
