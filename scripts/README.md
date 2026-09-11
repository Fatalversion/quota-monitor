# scripts/

Build plumbing. No dependencies beyond what `package.json` already lists —
`postject` is fetched at build time and is deliberately not a dependency.

| script                  | what it does                                                     |
| ----------------------- | ---------------------------------------------------------------- |
| `npm run build`         | `tsc -p tsconfig.json` → `dist/`                                  |
| `npm run build:sidecar` | the standalone `quota` binary Tauri ships                         |
| `npm run dev:widget`    | runs the widget in development                                    |
| `npm run build:installer` | sidecar, then the platform installer                            |
| `npm run ui:fixture`    | regenerate `ui/fixture.json` from real output                     |
| `npm run ui:serve`      | serve `ui/` for browser design work                               |

## The sidecar

`npm run build:sidecar` produces, on this machine:

```
src-tauri/binaries/quota-x86_64-pc-windows-msvc.exe   (~76 MB)
```

### Why the filename carries a target triple

The sidecar is declared as `bundle.externalBin: ["binaries/quota"]` with no
suffix. Tauri appends the Rust target triple and the platform's executable
extension and looks for `binaries/quota-<triple>[.exe]`. That is what lets one
repo hold a macOS arm64 and a Windows x64 sidecar side by side and have each
installer pick the right one; the copy that lands next to the installed app is
renamed back to plain `quota`. Get the suffix wrong and the build fails with
"resource path ... doesn't exist", so the script asks `rustc -vV` for the host
triple rather than hard-coding it.

### Why that declaration is not in `tauri.conf.json`

It lives in **`src-tauri/tauri.bundle.conf.json`** and is merged in with
`--config` by `npm run build:installer`.

`tauri-build` resolves `externalBin` at **compile** time, not bundle time. With
the declaration in the base config, a plain

```sh
cd src-tauri && cargo build
```

fails with `resource path binaries\quota-<triple>.exe doesn't exist` until the
76 MB sidecar has been built — and `src-tauri/binaries/` is gitignored, so that
would be every fresh clone. Splitting it into an overlay is what keeps both
promises at once: a fresh clone compiles the Rust with no sidecar, and the
installer never ships without one.

**There is no cross-compiling.** A Node SEA binary is a copy of the node
executable that is currently running, with a blob injected — build on Windows
and you get a Windows PE whatever you name it. Passing `--target` for another OS
is refused rather than producing a corrupt sidecar.

### How it is built

Node 22's built-in Single Executable Application support, no `pkg`, `nexe`,
`esbuild` or `bun`:

1. `tsc` → `dist/`
2. **bundle** — `dist/` plus `node_modules/yaml` become one CommonJS file at
   `build/sea/quota.cjs`. This step exists because the SEA loader's `require()`
   [can only load built-in modules](https://nodejs.org/api/single-executable-applications.html),
   so the program must arrive as a single file. `scripts/lib/bundle.mjs` is a
   ~300-line bundler that understands exactly the syntax `tsc` emits here and
   **throws on anything else** — see below.
3. `node --check` on the generated file
4. run it under plain node and parse its `--json` output, so a bundler bug is
   caught before SEA is involved
5. `node --experimental-sea-config sea-config.json` → `build/sea/quota.blob`
6. copy this node binary
7. `postject` injects the blob
8. run the finished binary: `--version` must match `package.json`, and `--json`
   must produce the same provider/window shape as `node dist/cli/index.js --json`
9. copy into `src-tauri/binaries/`

Any failure deletes the half-made executable and exits non-zero. A sidecar that
exists but is broken is worse than none, because Tauri would bundle it.

### Why the bundler is safe to hand-roll

It is not a general JavaScript bundler and refuses to act like one:

- every import/export form is matched against an explicit whitelist; anything
  else — `export default`, `export * from`, namespace imports, multi-line
  imports, computed `require()` — is a build error naming the file and line
- after transforming an ES module it **imports the real module** and compares
  the export names it produced against the actual namespace
- import cycles are rejected, because exports are assigned at the end of each
  module
- the finished binary is diffed against the TypeScript build

### postject

Not a dependency. The script looks for `node_modules/postject`, then `postject`
on `PATH`, then `npx --yes postject`. If none work it fails loudly with install
instructions and leaves no binary behind.

On Windows the copied `node.exe` keeps an Authenticode signature that injection
invalidates. The script strips it with `signtool` when `signtool` is on `PATH`
and says so plainly when it is not — postject warns either way. Sign the app in
the installer step.

## Development needs none of this

SEA is fiddly, and a fresh clone should not have to care. The Rust side falls
back to a compiled checkout, so this always works:

```sh
npm install
npm run build
node dist/cli/index.js --json
```

`npm run dev:widget` guarantees exactly that before it starts Tauri: it runs
`tsc`, then actually executes `node dist/cli/index.js --json` and checks it
prints a JSON envelope, and fails with the command and its stderr if it does
not. It never builds the sidecar, and it deliberately does not merge
`tauri.bundle.conf.json`, so `tauri dev` runs with no `externalBin` at all and
the Rust side uses the `dist/` fallback. If a config in play ever does declare
`externalBin` and the binary is missing, it says so up front, because Tauri
resolves sidecars in dev too.

`src-tauri/` belongs to the Rust side. These scripts only ever write build
output into `src-tauri/binaries/`, and never create `src-tauri/` itself — if it
does not exist yet the finished binary is left in `build/sea/` with a note.

## Options

```sh
node scripts/build-sidecar.mjs [--target <triple>] [--out-dir <dir>]
                               [--skip-tsc] [--keep-intermediates]
node scripts/widget.mjs <dev|build> [-- passthrough tauri args]
node scripts/write-fixture.mjs [--out <path>]
node scripts/serve-ui.mjs [--port <n>]
```
