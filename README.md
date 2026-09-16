# quota-monitor

**One widget for every AI subscription you are burning through.**

A small dock that lives on the edge of your screen and tells you how much of
each AI coding subscription you have spent. It reads tools you already have
installed, so there is nothing to connect, no account, and no API key.

Free and open source, and it stays that way. No paid tier, no hosted plan,
nothing held back for a pro version.

```
✳  Claude Code                    Max 20x
   Session    resets in 4h 17m         7%
   Weekly     resets in 4d 14h        85%
   Weekly · Fable                     76%

⬡  Codex                              Pro
   Weekly     resets in 4d 15h        80%
   Weekly · GPT-5.3-Codex-Spark        0%
```

Those are real figures, and they match what each tool reports about itself to
the digit. The per-model rows are limits that apply to one model rather than
the whole plan - on a Max plan that is frequently the one that stops the work
first, and it is the row a subscription dashboard tends not to show you.

Hover the dock to expand it, click to pin it open, drag it to any screen edge.
It also lives in the system tray.

---

## Providers

| Provider | Setup | Figures are |
| --- | --- | --- |
| **Codex CLI** | None | Reported by OpenAI |
| **Claude Code** | None | Reported by Anthropic |

Both read files the tool already writes to your disk, or data it hands to a
command you configured. Nothing is uploaded and no credential is used.

**Codex is the better case, and not because of anything we did.** OpenAI writes
its own `used_percent`, window length and reset time into the Codex rollout
logs, so those readings are the provider's own verdict. They update when you
next run Codex, and the widget says how stale the snapshot is rather than
presenting an old figure as live.

**Claude Code is the harder case.** The transcripts record every token spent, so
the numerator is real. Nothing on disk records the cap.

There are two ways to the figure itself, and the widget uses both.

**Asking.** `claude -p "/usage"` prints Anthropic's own percentages, and it
costs nothing: `/usage` is answered inside Claude Code rather than by a model -
measured at zero tokens, zero dollars, `num_turns: 0`, about a second. The
widget runs that when you press refresh and when it starts. Note what it is NOT
doing: it does not read your credentials file, or call Anthropic itself. It
asks the CLI you are already signed into, and reads what that prints. Reading
another tool's stored token is a line this project does not cross.

**Being told.** Claude Code hands its **status line** command a JSON payload
carrying the same percentages on every response. Point your status line at
`quota statusline` and the figures refresh as you work, with nothing to press.
Worth doing if you live in a terminal; unnecessary otherwise, and it does
nothing at all for IDE sessions, which never run a status line.

Between those two, the estimate carries the bar - and it is priced at a rate
measured from your own account rather than a constant. See
[Calibration](#calibration).

## Claude Code percentages

One settings entry, which you add yourself. quota-monitor never edits Claude
Code's settings.

1. Print the entry for your install:

   ```bash
   quota statusline --print-config
   ```

2. Add the `statusLine` block it prints to `~/.claude/settings.json`. It looks
   like this, with the path to your own install:

   ```json
   {
     "statusLine": {
       "type": "command",
       "command": "C:/Users/you/AppData/Local/quota-monitor/quota.exe statusline"
     }
   }
   ```

3. Send Claude Code a message. Your status line now reads
   `5h 18% (2h 31m) | 7d 39% (5d 02h)`, and the widget's Claude Code rows lose
   their `~`.

**Already have a status line?** Keep it, and pass the same input on from your
script without printing anything:

```bash
input=$(cat)
echo "$input" | quota statusline --silent
# ...the rest of your script, unchanged
```

What `quota statusline` does with the payload: it keeps the four numbers and
nothing else. The same payload carries your working directory, repository,
session name and pull request URL, and none of it is stored. The figures go to
`~/.config/quota-monitor/claude-code-rate-limits.json`.

Things worth knowing, because they are where a reported figure can still
mislead:

- **Pro and Max plans only.** Claude Code sends no rate limits to API-key users,
  and none before a session's first response.
- **Not live.** The figure moves only when a session with the status line gets a
  response. The widget says how long ago it last changed, and counts the Claude
  Code calls on this machine since then, which the figure cannot include. Usage
  on claude.ai, the desktop app or another machine counts against the same
  limit and shows up only at the next update.
- **Many sessions, one figure.** An idle session re-renders with whatever its
  last response carried. Within a window the recorder keeps the highest figure
  it has seen and a later window replaces an earlier one, so an old session can
  never drag the number back down.
- **After a reset** the row falls back to the transcript estimate until Claude
  Code reports the new window, and says so.
- **One account per home directory.** Nothing in the payload identifies the
  account, so switching Claude accounts on one machine mixes their figures.
- **IDE extensions never run it.** Status lines are a terminal feature: an IDE
  session, a print-mode run (`claude -p`) and a headless SDK session fire no
  status line at all, so a day's work in the VS Code extension moves nothing
  here. That is what `--refresh` below is for.

## Asking for a figure now

```bash
quota --refresh
```

The widget does this for you when it starts and when you press the refresh
control in the panel header, or Refresh in the tray menu. The 60-second poll
does not: it reads what is on disk.

A refresh runs `claude -p "/usage"` and records the figures it prints, through
the same rules the status line goes through. That covers the two cases local
files cannot: an IDE session, which fires no status line, and usage on your
phone, on claude.ai or on another machine, which never touches this computer at
all.

**It spends no quota.** `/usage` is answered inside Claude Code rather than by
a model. Measured on the machine this was written on: zero tokens, zero dollars,
`num_turns: 0`, about a second. No credential is read and no network call is
made from this tool - your own CLI is already signed in, and we read what it
prints.

If Claude Code is not installed, not signed in, or prints something this does
not recognise, the refresh changes nothing and the widget carries on with the
status line snapshot and its own estimate. Nothing of the report is kept but the
percentages and their reset times - `/usage` also prints a breakdown naming
your sessions, subagents and MCP servers, and none of that is stored or logged.

One figure it shows and this tool does not model yet: a per-model weekly limit
("Current week (Fable)"), alongside the session and all-models windows.

### Not supported, and why

Researched and ruled out rather than forgotten:

- **Devin (formerly Windsurf)** keeps its quota on the server. Checked on a Pro
  account, 2026-09-16, with the app's own panel showing 73% of the week used:

  - The IDE's cache (`%APPDATA%/devin/User/globalStorage/state.vscdb`, key
    `windsurf.reactSettings.cachedPlanInfoData:<user>`) has exactly the right
    shape - `dailyRemainingPercent`, `weeklyRemainingPercent`,
    `overageBalanceMicros`, both reset timestamps - and is **not refreshed**:
    the file was written minutes before it was read, while the record inside
    said 100%/100% with reset timestamps a month old.
  - The CLI's `user_status.*.bin` (a JSON envelope around base64 protobuf)
    carries the account, the org and the model configs. Two captures a month
    apart differ in **zero** fields; there is no quota in it.
  - The CLI (`devin.exe`, "chisel") takes `-p/--print` like Claude Code, but
    `/help` lists no usage command: `/status` is authentication,
    `/session-stats` is this session's tokens, `/context` is the context
    window. Logging the CLI in separately changes none of that.
  - The CLI plainly KNOWS the figure - its interactive banner prints
    "Pro · 27% remaining (resets in 3d 23h)" - and keeps it in memory. A
    `user_status.*.bin` written by that very login carries the plan and its end
    date and no percentage; the CLI's own logs carry none either.
  - `~/.codeium` and `%APPDATA%/Windsurf` are the pre-rebrand install and stop
    being written the day the machine moves to Devin.

  So the figure the panel shows is fetched when the panel renders, and nothing
  a local reader can see. Worth revisiting if Devin starts writing it down;
  reading its API key out of the auth store to ask the server is not on the
  table (see Honesty, below).

- **Cursor** gives an individual subscriber no way to read either their usage or their cap.
- **Gemini CLI** was retired for consumers in June 2026 and replaced by Antigravity CLI.

Cline, OpenCode, Amp and GitHub Copilot all look feasible and are not built
yet.

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

Anthropic publishes no token cap, and there is no honest constant to ship: a
week of mixed models and a day of 1M-context Opus were measured 4.5x apart on
one machine in one week. So the cap is measured rather than assumed, and you do
not have to do anything for it.

**How it works.** Two reported percentages and the transcripts between them say
what one of your tokens costs against a window. On a real account:

```
priced at 23.2% per million tokens, MEASURED from Anthropic's own figures:
they added 27% over the 1.2M tokens recorded between 13:05 and 07:44
```

A hundred points of that is the cap - about 4.3M tokens there. It is stored, so
it survives the window reset that clears the evidence, and it is re-measured
whenever two fresh figures allow. Between reported figures the same rate tops
the last one up with the calls made since, which is what keeps the bar moving
in an IDE session where no status line ever fires.

**What it will not do.** It will not price local work against a rate it has not
got: with no measurement and no configured cap, the row shows raw spend and no
bar, because a wrong percentage is worse than none. It will not count anything
but this machine, so treat a topped-up figure as a floor - usage from a phone,
claude.ai or another computer raises the real number without appearing here.
And it will not override you:

```yaml
providers:
  claude-code:
    sessionLimit: 5460000    # a number you measured yourself
    weeklyLimit: 7926000
```

A configured cap always wins. If you set one months ago and your mix of models
has moved on, delete it and let the measurement take over - that is now the
better number, not the worse one.

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
    usageProbe: true    # let a refresh run `claude -p /usage`
    scanCache: true     # remember each transcript's parsed events between reads
  codex:
    enabled: true
    rateLimitProbe: true    # let a refresh ask Codex's app-server for its limits
```

The two probes cost no quota and about a second each, but they do start a
process - set either to `false` if you would rather a monitoring widget never
did that, and refreshes will read only what is on disk.

`scanCache` is the difference between opening a week of transcripts on every
poll and opening the two or three a session has touched; on one machine that is
389 MB versus almost nothing, every 60 seconds. Turn it off only to prove it is
not the thing lying to you.

Note that `enabled` stops the adapter reading at all. To simply hide a provider
from the widget while still tracking it, untick it in the tray menu.

Credentials are never stored here. When API-based providers arrive they will use
the OS keychain, and the config parser actively rejects an inline secret.

## Installing

Windows, today. macOS and Linux build from source but are untested.

1. Build the installer - `npm ci && npm run build:installer` - or take one from
   a release. It produces both an `.exe` (NSIS) and an `.msi`; either will do,
   and the NSIS one installs per-user with no administrator prompt.
2. Run it. The widget appears as a thin rail on the right-hand edge of your
   screen and as a tray icon.
3. There is no sign-in and no configuration step. It looks for the tools you
   already have: if Claude Code or Codex is installed, their rows appear on the
   first read.

Living with it:

- **Hover** the rail to expand it, **click** to pin it open, **drag** it to any
  screen edge - left and right give the upright rail, top and bottom the
  horizontal bar. It remembers where you put it.
- **↻ in the panel header**, or **Refresh** in the tray menu, asks each tool for
  a current figure rather than re-reading what is on disk. The app also does
  this once at startup; the 60-second poll deliberately does not.
- **The tray menu** hides individual providers, which stops them being drawn
  without stopping them being read.
- Files live in `~/.config/quota-monitor/`: `config.yaml`, and beside it the
  figures the tool has recorded and its scan cache. Deleting any of them costs
  nothing but a re-read.

To start it with Windows, put a shortcut to the installed `quota-monitor.exe`
in `shell:startup`. The app does not write to your registry or install a
service to do this for you.

## Building

Needs Node 20+ and, for the desktop widget, the Rust toolchain.

```bash
npm ci
npm test               # 831 tests
npm run dev            # the CLI, prints a readout
npm run dev -- --json  # machine-readable
npm run dev -- --refresh --verbose   # ask the tools, and say what was asked

cd src-tauri && cargo test    # 92 tests
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
- Write to another tool's files, or make any network call from the desktop shell. That includes Claude Code's settings: you add the status line entry yourself.
- Spend quota to measure quota. The two probes run the vendor's own CLI and are
  free by measurement, not by assumption: zero tokens, zero cost, no session
  created.
- Scrape a provider's web interface, drive it with browser automation, or read session cookies.
- Grow a paid tier, a licence key, or an upsell.

## Licence

[MIT](LICENSE). Provider names and marks belong to their owners and are used
only to identify what is being measured; see [TRADEMARKS.md](TRADEMARKS.md).

Not affiliated with Anthropic, OpenAI, GitHub, Google, Cognition or Anysphere.
