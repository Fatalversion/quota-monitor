# quota-monitor

**One widget for every AI subscription you are burning through.**

A small dock that lives on the edge of your screen and tells you how much of
each AI coding subscription you have spent. It reads tools you already have
installed, so there is nothing to connect, no account, and no API key.

Free and open source, and it stays that way. No paid tier, no hosted plan,
nothing held back for a pro version.

```
✳  Claude Code                    Max 20x
   Session    resets in 2h 31m        18%
   Weekly     resets in 2d 14h        94%

⬡  Codex                             Plus
   Session    ended 3d 19h ago         0%
   Weekly     resets in 2d 23h         0%
```

Hover the dock to expand it, click to pin it open, drag it to any screen edge.
It also lives in the system tray.

---

## Providers

| Provider | Setup | Figures are |
| --- | --- | --- |
| **Codex CLI** | None | Reported by OpenAI |
| **Claude Code** | None for spend, one step for percentages | Derived |

Both read files the tool already writes to your disk. Nothing is uploaded and
no credential is used.

**Codex is the better case, and not because of anything we did.** OpenAI writes
its own `used_percent`, window length and reset time into the Codex rollout
logs, so those readings are the provider's own verdict. They update when you
next run Codex, and the widget says how stale the snapshot is rather than
presenting an old figure as live.

**Claude Code is the harder case.** The transcripts record every token spent, so
the numerator is real. Nothing anywhere records the cap. Claude Code's own
`/usage` knows it, but it fetches that from Anthropic's servers using the OAuth
token in your credentials file, and reading another tool's stored credential is
a line this project does not cross. So out of the box you get real token counts
and no percentage. See [calibration](#calibration) to get bars.

### Not supported, and why

Researched and ruled out rather than forgotten:

- **Devin** exposes consumption only to enterprise administrators. A full-power personal key returns 403.
- **Cursor** gives an individual subscriber no way to read either their usage or their cap.
- **Gemini CLI** was retired for consumers in June 2026 and replaced by Antigravity CLI.

Cline, OpenCode, Amp, Windsurf and GitHub Copilot all look feasible and are not
built yet.

## Honesty

One idea runs through the whole codebase, and it is the reason to trust the
numbers.

Every reading is either **reported**, meaning the provider stated the figure, or
**derived**, meaning we or you supplied the denominator. Derived percentages are
marked in the interface. A reading with no cap shows a grooved bar and the raw
amount, never an empty bar, because an empty bar reads as "you have used none of
it" when it means "we do not know".

This is not decoration. An early build shipped community cap estimates for
Claude, and against a real account they were wrong by a factor of seven: the
widget showed a confident full bar to someone nowhere near their limit. Every
cap in `plans.ts` is now `null` and the comment there records why.

## Calibration

To get percentages for Claude Code, give it a denominator you measured.

1. Run `/usage` in Claude Code and note the session and weekly percentages.
2. Run `quota --json` at the same moment and note `used` for each window.
3. Divide, and put the results in your config.

```yaml
providers:
  claude-code:
    sessionLimit: 5460000    # 709,837 / 0.13
    weeklyLimit: 7926000     # 7,133,827 / 0.90
```

Sanity check: the session cap should come out below the weekly one. Percentages
stay marked as derived, because one calibration point fixes a ratio and not a
law. Delete both lines to go back to raw numbers with no bar.

`/usage` also shows a per-model limit that this tool does not model at all. That
ceiling can bite while both bars here still look calm.

## Configuration

`~/.config/quota-monitor/config.yaml`, all optional:

```yaml
refresh: 60s

widget:
  mode: both          # both | strip | tray
  dock: right         # left | right give the upright rail
                      # top | bottom give the horizontal bar

alerts:
  warn: 75
  critical: 90

providers:
  claude-code:
    enabled: true
  codex:
    enabled: true
```

Note that `enabled` stops the adapter reading at all. To simply hide a provider
from the widget while still tracking it, untick it in the tray menu.

Credentials are never stored here. When API-based providers arrive they will use
the OS keychain, and the config parser actively rejects an inline secret.

## Building

Needs Node 20+ and, for the desktop widget, the Rust toolchain.

```bash
npm install
npm test              # 679 tests
npm run dev           # the CLI, prints a readout
npm run dev -- --json # machine-readable

cd src-tauri && cargo test    # 93 tests
cargo build && ./target/debug/quota-monitor
```

The desktop shell does not reimplement any provider logic. It runs the Node CLI
and renders its JSON, so there is one implementation and one set of tests.

The interface is plain HTML with no bundler and no framework. Open
[ui/index.html](ui/index.html) in a browser and it renders against a sanitised
fixture with no toolchain at all.

## What it will not do

- Read `~/.claude/.credentials.json`, `~/.codex/auth.json`, or any other tool's stored token. Not even though it is local, easy, and would remove the last bit of setup.
- Send telemetry, analytics or crash reports. There is nothing to opt out of.
- Write to another tool's files, or make any network call from the desktop shell.
- Spend quota to measure quota.
- Scrape a provider's web interface, drive it with browser automation, or read session cookies.
- Grow a paid tier, a licence key, or an upsell.

## Licence

[MIT](LICENSE). Provider names and marks belong to their owners and are used
only to identify what is being measured; see [TRADEMARKS.md](TRADEMARKS.md).

Not affiliated with Anthropic, OpenAI, GitHub, Google, Cognition or Anysphere.
