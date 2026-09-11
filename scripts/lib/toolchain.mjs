/**
 * Shared plumbing for the build scripts: process spawning, the Rust target
 * triple, and finding the Tauri CLI.
 *
 * Everything here follows one rule: never degrade quietly. If a tool is
 * missing we say which tool, why we wanted it, and the exact command that
 * fixes it. A build script that shrugs and carries on is how you end up
 * shipping an installer with a sidecar that was never rebuilt.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const IS_WINDOWS = process.platform === 'win32';
export const EXE_SUFFIX = IS_WINDOWS ? '.exe' : '';

/* Colour is a nicety; $NO_COLOR and non-terminals get plain text. */
const COLOR = process.stdout.isTTY === true && !process.env.NO_COLOR;
const BOLD = COLOR ? '\x1b[1m' : '';
const RED = COLOR ? '\x1b[31m' : '';
const RESET = COLOR ? '\x1b[0m' : '';

/** Loud, greppable build log. Every step the script takes prints one line. */
export function step(message) {
  process.stdout.write(`\n${BOLD}> ${message}${RESET}\n`);
}

export function info(message) {
  process.stdout.write(`  ${message}\n`);
}

export function warn(message) {
  process.stderr.write(`  ! ${message}\n`);
}

/** Print the failure the way a human reads it, then stop. Never exit 0. */
export function die(message) {
  process.stderr.write(`\n${RED}BUILD FAILED${RESET}\n${message}\n\n`);
  process.exit(1);
}

/**
 * Rust installs into ~/.cargo/bin, which is on the PATH of a normal login
 * shell but not always of whatever spawned npm. Tauri needs cargo, so add it.
 */
export function envWithCargo(extra = {}) {
  const cargoBin = join(homedir(), '.cargo', 'bin');
  const path = process.env.PATH ?? '';
  const needsCargo = existsSync(cargoBin) && !path.split(delimiter).includes(cargoBin);
  return {
    ...process.env,
    ...(needsCargo ? { PATH: `${path}${delimiter}${cargoBin}` } : {}),
    ...extra,
  };
}

/**
 * Windows spawn rules, which are not optional and not obvious.
 *
 *  - `npx`, `cargo`, `rustc` and friends are .cmd shims, and cmd.exe is the
 *    only thing that can run those, so those need `shell: true`.
 *  - a real .exe given by absolute path must NOT go through the shell, because
 *    cmd.exe splits it on spaces and this repo lives under "Open Source".
 *  - when the shell is unavoidable and the path has a space in it, the path
 *    has to be quoted or cmd.exe truncates it at the first space.
 */
function spawnShape(command, args, options) {
  const shellNeeded =
    IS_WINDOWS && (!isAbsolute(command) || /\.(cmd|bat)$/i.test(command));
  const shell = options.shell ?? shellNeeded;
  // Under a shell, Node hands the whole line to cmd.exe verbatim, so every
  // word with a space in it - the command and each argument - must be quoted.
  const quote = (value) => (shell && /\s/.test(value) && !value.startsWith('"') ? `"${value}"` : value);
  return { command: quote(command), args: args.map(quote), shell };
}

/** Run a command to completion, inheriting stdio. Returns the exit code. */
export function run(command, args, options = {}) {
  const shape = spawnShape(command, args, options);
  const result = spawnSync(shape.command, shape.args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: envWithCargo(),
    ...options,
    shell: shape.shell,
  });
  if (result.error) return { code: 1, error: result.error };
  return { code: result.status ?? 1 };
}

/** Run a command and capture stdout. Used for probing, never for output. */
export function capture(command, args, options = {}) {
  const shape = spawnShape(command, args, options);
  const result = spawnSync(shape.command, shape.args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: envWithCargo(),
    ...options,
    shell: shape.shell,
  });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    failed: result.error !== undefined || result.status !== 0,
  };
}

/** Run a command, replacing this process's lifetime with it (long-running). */
export function exec(command, args, options = {}) {
  const shape = spawnShape(command, args, options);
  const child = spawn(shape.command, shape.args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: envWithCargo(),
    ...options,
    shell: shape.shell,
  });
  child.on('exit', (code, signal) => {
    process.exit(signal ? 1 : (code ?? 0));
  });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => child.kill(sig));
  }
  return child;
}

/* -------------------------------------------------------------------------- */
/* target triple                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Fallback map for when rustc is not installed. Deliberately small: these are
 * the hosts Tauri v2 ships desktop builds for.
 */
const FALLBACK_TRIPLES = {
  'win32:x64': 'x86_64-pc-windows-msvc',
  'win32:arm64': 'aarch64-pc-windows-msvc',
  'darwin:x64': 'x86_64-apple-darwin',
  'darwin:arm64': 'aarch64-apple-darwin',
  'linux:x64': 'x86_64-unknown-linux-gnu',
  'linux:arm64': 'aarch64-unknown-linux-gnu',
};

/**
 * The host target triple, e.g. `x86_64-pc-windows-msvc`.
 *
 * WHY THE SIDECAR FILENAME CARRIES THIS
 * -------------------------------------
 * A sidecar is declared as `bundle.externalBin: ["binaries/quota"]` - no
 * suffix. Tauri appends the target triple and the platform executable
 * extension and looks for `binaries/quota-<triple>[.exe]`. That is how one
 * repo can hold a macOS arm64 and a Windows x64 sidecar side by side and have
 * each installer pick up the right one; the copy that lands next to the app is
 * renamed back to plain `quota`. Get the suffix wrong and the build fails with
 * "resource path ... doesn't exist", so we derive it from rustc rather than
 * hard-coding it.
 *
 * That declaration lives in `src-tauri/tauri.bundle.conf.json`, not in
 * tauri.conf.json, and is merged in only for the installer. See the long note
 * on BUNDLE_CONFIG in scripts/widget.mjs for why.
 */
export function targetTriple() {
  const probe = capture('rustc', ['-vV']);
  if (!probe.failed) {
    const match = /^host:\s*(\S+)$/m.exec(probe.stdout);
    if (match) return { triple: match[1], source: 'rustc -vV' };
  }
  const fallback = FALLBACK_TRIPLES[`${process.platform}:${process.arch}`];
  if (fallback) return { triple: fallback, source: 'platform fallback (rustc not found)' };
  die(
    `Cannot determine the Rust target triple for ${process.platform}/${process.arch}.\n` +
      'Install Rust (https://rustup.rs) so `rustc -vV` can report the host triple,\n' +
      'or pass one explicitly:  npm run build:sidecar -- --target <triple>',
  );
  return { triple: '', source: '' };
}

/* -------------------------------------------------------------------------- */
/* tauri cli                                                                  */
/* -------------------------------------------------------------------------- */

const TAURI_HELP = [
  'The Tauri CLI was not found. Install either one:',
  '',
  '  cargo install tauri-cli --version "^2.0"      # `cargo tauri ...`',
  '  npm install -D @tauri-apps/cli@^2             # `npx tauri ...`',
  '',
  'The Rust CLI is the lighter option here: this project deliberately keeps',
  'its npm dependency list to one runtime package.',
].join('\n');

/**
 * Find a Tauri v2 CLI. Prefers a local npm install (pinned, reproducible),
 * then cargo-tauri. Returns null rather than guessing.
 */
export function findTauri() {
  const localBin = join(ROOT, 'node_modules', '.bin', IS_WINDOWS ? 'tauri.cmd' : 'tauri');
  if (existsSync(localBin)) return { command: localBin, args: [], label: 'node_modules/.bin/tauri' };

  const cargo = capture('cargo', ['tauri', '--version']);
  if (!cargo.failed) return { command: 'cargo', args: ['tauri'], label: 'cargo tauri' };

  return null;
}

export function requireTauri() {
  const tauri = findTauri();
  if (tauri === null) die(TAURI_HELP);
  return tauri;
}

/** src-tauri/ is owned by the Rust side of the project; we only check for it. */
export function requireTauriProject() {
  const dir = join(ROOT, 'src-tauri');
  const conf = join(dir, 'tauri.conf.json');
  if (!existsSync(conf)) {
    die(
      `${conf} does not exist, so there is no widget to ${existsSync(dir) ? 'run - src-tauri/ is there but not a Tauri project yet' : 'run'}.\n\n` +
        'The CLI half of this project does not need it:\n\n' +
        '  npm run build && node dist/cli/index.js --json\n' +
        '  npm run ui:serve          # the widget UI in a browser',
    );
  }
  return dir;
}
