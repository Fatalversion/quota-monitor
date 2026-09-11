/**
 * SecretStore implementations.
 *
 * THE RULE, and it is not negotiable:
 *
 *   1. A secret VALUE is never written to the config file. The config file may
 *      name a key ("anthropic.apiKey"); it never holds the material behind it.
 *   2. A secret VALUE is never logged - not to stdout, not to stderr, not into
 *      a crash report, not into an Error message or an Error `cause`.
 *   3. A secret VALUE is never passed to AdapterContext.debug(). Debug output is
 *      assumed to end up pasted into a bug report by a tired human.
 *   4. Key NAMES are not secrets and may appear in errors and debug output; that
 *      is exactly why the errors below quote the key and never the value.
 *   5. quota-monitor never reads another tool's stored credentials. Nothing here
 *      touches ~/.claude/.credentials.json or any *.key file, ever.
 *   6. When v0.2 starts shelling out to a platform keychain, secret values go in
 *      over stdin and come back over stdout. Never argv - argv is world-readable
 *      in a process listing.
 *
 * v0.1 uses none of this. The shape exists now so the v0.2 API adapters have a
 * stable seam to plug into, and so tests have a store that is honest about being
 * a fake.
 */

import type { SecretStore } from './types.js';

/**
 * Prefix shared by every "we cannot store this" failure, so callers and tests
 * can match on one stable phrase.
 */
const NO_KEYCHAIN = 'no keychain configured';

/**
 * Keys are identifiers, not free text. An empty or blank key is always a caller
 * bug (a missing config lookup, usually) and TypeScript cannot catch `''`.
 */
function assertKey(key: string): void {
  if (typeof key !== 'string' || key.trim() === '') {
    throw new TypeError(
      `Secret key must be a non-empty string (received ${JSON.stringify(key)}).`,
    );
  }
}

function isEntryIterable(value: object): value is Iterable<readonly [string, string]> {
  return Symbol.iterator in value;
}

/**
 * An in-process store. Nothing is persisted, so nothing survives the process.
 *
 * This is the store tests should use. It is deliberately NOT the default: a
 * store that silently forgets everything on exit would be a bad surprise in
 * production and a good one in a test.
 */
export class MemorySecretStore implements SecretStore {
  readonly #entries = new Map<string, string>();

  /**
   * @param initial Optional seed data: either a plain object of key/value pairs
   *   or anything iterable of `[key, value]` (a Map, an array of tuples).
   */
  constructor(
    initial?: Readonly<Record<string, string>> | Iterable<readonly [string, string]>,
  ) {
    if (initial === undefined) return;
    const entries = isEntryIterable(initial) ? initial : Object.entries(initial);
    for (const [key, value] of entries) {
      assertKey(key);
      this.#entries.set(key, value);
    }
  }

  async get(key: string): Promise<string | undefined> {
    assertKey(key);
    return this.#entries.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    assertKey(key);
    this.#entries.set(key, value);
  }

  /** Deleting an absent key succeeds. Delete states an intent, it is not a query. */
  async delete(key: string): Promise<void> {
    assertKey(key);
    this.#entries.delete(key);
  }

  /** Number of keys held. Test affordance. */
  get size(): number {
    return this.#entries.size;
  }

  /** Whether a key is held, without reading its value. Test affordance. */
  has(key: string): boolean {
    assertKey(key);
    return this.#entries.has(key);
  }

  /**
   * The key names held, in insertion order. Names only - there is deliberately
   * no bulk value accessor, so an accidental `console.log(store.dump())` cannot
   * exist. Read values one at a time through `get`.
   */
  keys(): string[] {
    return [...this.#entries.keys()];
  }

  /** Drop everything. Test affordance. */
  clear(): void {
    this.#entries.clear();
  }
}

/**
 * The store you get when there is nowhere safe to put a secret.
 *
 * Reads succeed and return nothing, so an adapter that *optionally* uses an API
 * key degrades to its local-files-only path instead of crashing. Writes fail
 * loudly, because silently discarding a credential the user just supplied is
 * worse than an error.
 */
export class NullSecretStore implements SecretStore {
  /** Human-readable explanation, surfaced on write. Never contains a secret. */
  readonly reason: string;

  constructor(reason: string = NO_KEYCHAIN) {
    this.reason = reason;
  }

  /** Always undefined. There is no backing store to read from. */
  async get(key: string): Promise<string | undefined> {
    assertKey(key);
    return undefined;
  }

  async set(key: string, _value: string): Promise<void> {
    assertKey(key);
    // The key name is safe to quote. The value is not, and never appears here.
    throw new Error(
      `${this.reason}: refusing to store the secret "${key}". ` +
        `Configure a keychain-backed SecretStore before writing secrets.`,
    );
  }

  /** Succeeds. Nothing is stored, so the requested end state already holds. */
  async delete(key: string): Promise<void> {
    assertKey(key);
  }
}

/** How one platform's keychain will be reached, without any native dependency. */
export interface KeychainBackend {
  readonly platform: NodeJS.Platform;
  /** What a user would call this thing. */
  readonly displayName: string;
  /** The executable we will spawn - argv only, never a shell string. */
  readonly command: string;
}

const KEYCHAIN_BACKENDS: ReadonlyMap<NodeJS.Platform, KeychainBackend> = new Map<
  NodeJS.Platform,
  KeychainBackend
>([
  [
    'win32',
    {
      platform: 'win32',
      displayName: 'Windows Credential Manager',
      command: 'powershell.exe',
    },
  ],
  [
    'darwin',
    { platform: 'darwin', displayName: 'macOS Keychain', command: '/usr/bin/security' },
  ],
  ['linux', { platform: 'linux', displayName: 'Secret Service', command: 'secret-tool' }],
]);

/**
 * STUB. Documents how the OS keychain will be reached in v0.2, and throws until
 * then. Every method throws; nothing here shells out yet.
 *
 * The design constraint that shaped this: quota-monitor takes exactly one
 * runtime dependency ("yaml"). No keytar, no node-gyp, no prebuilt binaries. So
 * each platform is reached by spawning a program the OS already ships, via
 * child_process.execFile with an argv ARRAY - never a shell string, so nothing
 * needs quoting and nothing can be injected.
 *
 * Secret values move over stdin and stdout only. A value passed as a command
 * line argument is visible to every other process on the machine through the
 * process list; that is the single most common way a CLI leaks a token.
 *
 * ---------------------------------------------------------------------------
 * win32 - Windows Credential Manager, reached through PowerShell:
 *
 *   spawn: powershell.exe -NoProfile -NonInteractive -Command -
 *          (script piped in on stdin, and the secret piped in with it, so the
 *           value never reaches argv)
 *
 *   read:   Get-StoredCredential -Target 'quota-monitor:<key>'
 *   write:  New-StoredCredential -Target 'quota-monitor:<key>' -UserName '<key>'
 *             -Password $fromStdin -Persist LocalComputer
 *   delete: Remove-StoredCredential -Target 'quota-monitor:<key>'
 *
 *   The CredentialManager module is not present on a stock box. Fallback, which
 *   needs nothing installed: DPAPI directly, over a blob we own at
 *   %LOCALAPPDATA%\quota-monitor\secrets.dat -
 *     [System.Security.Cryptography.ProtectedData]::Protect(bytes, $null,
 *       [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
 *   and ::Unprotect to read it back. CurrentUser scope means the ciphertext is
 *   useless to any other Windows account on the machine.
 *
 * ---------------------------------------------------------------------------
 * darwin - macOS Keychain, through the 'security' binary the OS ships:
 *
 *   read:   /usr/bin/security find-generic-password -s quota-monitor -a <key> -w
 *   write:  /usr/bin/security add-generic-password -U -s quota-monitor -a <key> -w
 *           (-w with NO value: 'security' then reads the password from stdin,
 *            which keeps it out of argv)
 *   delete: /usr/bin/security delete-generic-password -s quota-monitor -a <key>
 *
 *   Exit status 44 from find-generic-password means "no such item" and maps to
 *   `undefined`, not to an error.
 *
 * ---------------------------------------------------------------------------
 * linux - Secret Service (GNOME Keyring, KWallet) via 'secret-tool' from
 * libsecret-tools:
 *
 *   read:   secret-tool lookup service quota-monitor account <key>
 *   write:  secret-tool store --label=quota-monitor/<key>
 *             service quota-monitor account <key>     (value read from stdin)
 *   delete: secret-tool clear service quota-monitor account <key>
 *
 *   secret-tool is often absent, and a headless box may have no Secret Service
 *   running at all. That detection failure must fall back to NullSecretStore
 *   rather than crash - see defaultSecretStore.
 * ---------------------------------------------------------------------------
 */
export class OsKeychainSecretStore implements SecretStore {
  /** Keychain "service" / target namespace every entry of ours lives under. */
  readonly service: string;
  readonly platform: NodeJS.Platform;
  /** undefined when this platform has no planned backend at all. */
  readonly backend: KeychainBackend | undefined;

  constructor(
    service: string = 'quota-monitor',
    platform: NodeJS.Platform = process.platform,
  ) {
    this.service = service;
    this.platform = platform;
    this.backend = OsKeychainSecretStore.backendFor(platform);
  }

  /** The planned backend for a platform, or undefined if there is none. */
  static backendFor(platform: NodeJS.Platform): KeychainBackend | undefined {
    return KEYCHAIN_BACKENDS.get(platform);
  }

  async get(key: string): Promise<string | undefined> {
    assertKey(key);
    throw this.#unimplemented('get');
  }

  async set(key: string, _value: string): Promise<void> {
    assertKey(key);
    throw this.#unimplemented('set');
  }

  async delete(key: string): Promise<void> {
    assertKey(key);
    throw this.#unimplemented('delete');
  }

  #unimplemented(operation: string): Error {
    const backend = this.backend;
    const how =
      backend === undefined
        ? `no keychain backend is planned for platform "${this.platform}"`
        : `the planned backend is ${backend.displayName} via ${backend.command}`;
    return new Error(
      `OsKeychainSecretStore.${operation}() is not implemented in v0.1 - ${how}. ` +
        `Use MemorySecretStore in tests, or NullSecretStore, until v0.2 ships keychain support.`,
    );
  }
}

/**
 * The store the app wires in by default.
 *
 * In v0.1 that is always a NullSecretStore: no adapter needs a secret yet and
 * OsKeychainSecretStore is a stub, so handing one out would turn every read
 * into a throw. The platform still shapes the failure message, so a user who
 * does hit it is told which tool v0.2 will use on their machine.
 *
 * v0.2 flips the body of this function, not its signature.
 *
 * @param platform Defaults to the running platform. Pass it explicitly in tests
 *   so the result never depends on the machine running them.
 */
export function defaultSecretStore(
  platform: NodeJS.Platform = process.platform,
): SecretStore {
  const backend = OsKeychainSecretStore.backendFor(platform);
  const reason =
    backend === undefined
      ? `${NO_KEYCHAIN} (platform "${platform}" has no supported keychain backend)`
      : `${NO_KEYCHAIN} (${backend.displayName} support via ${backend.command} arrives in v0.2)`;
  return new NullSecretStore(reason);
}
