# ui/

The whole frontend. Four files, no framework, no bundler, no build step.

| file                  | what it is                                                        |
| --------------------- | ----------------------------------------------------------------- |
| `index.html`          | both window modes in one document, plus the host glue              |
| `panel.css`           | theme-aware tokens, light and dark                                 |
| `panel.js`            | rendering, as a plain ES module                                    |
| `fixture.json`        | your own captured `quota --json` output. **Gitignored**            |
| `fixture.sample.json` | committed sanitised stand-in, used when `fixture.json` is absent   |

These are served to the Tauri webview directly off disk. Editing one and
reloading is the entire edit loop.

## Design work in a normal browser

```sh
npm run ui:serve
```

Then open:

- <http://127.0.0.1:4173/> — the collapsed strip that expands on hover
- <http://127.0.0.1:4173/?mode=panel> — the tray popover, permanently expanded

No Tauri, no providers, no network: the page reads `fixture.json` and renders
it. A fresh clone has no `fixture.json` (it holds real usage and is gitignored),
so the page falls back to `fixture.sample.json` and says so in a warning line
above the rows. Only a **missing** fixture falls back: one that exists but does
not parse is shown as the error it is, because quietly substituting the sample's
numbers for yours is the kind of lie this project exists not to tell.

**Why a server and not just double-clicking `index.html`?** Because the page is
a real ES module page — it does `import ... from './panel.js'` and
`fetch('./fixture.json')`, and both are subject to CORS. A `file://` page has an
opaque origin, so Chrome, Edge and Firefox all refuse. You get a blank widget
and a console full of CORS errors. `npm run ui:serve` is forty lines of
`node:http` with no dependencies (`scripts/serve-ui.mjs`); `python -m http.server
4173 --directory ui` does the same job if you prefer.

## The two modes are one file

`index.html` renders both, switched by `document.body.dataset.mode`:

- **strip** — a ~6px sliver docked to a screen edge. One segment per provider.
- **panel** — the expanded readout: a row per reading, with the footer total.

`panel.css` shows and hides them with `body[data-mode="strip"]` and
`body[data-mode="panel"]`. Nothing else differs.

Which mode you get depends on how the window loaded the page:

| window            | URL                    | behaviour                                                          |
| ----------------- | ---------------------- | ------------------------------------------------------------------ |
| docked widget     | `index.html`           | starts in strip; hover peeks, click pins, collapses 350ms after leave |
| tray popover      | `index.html?mode=panel`| starts in panel and **never** collapses                            |

`?mode=panel` is not a styling shortcut — it disables the hover handlers
entirely. A popover that shrank when your cursor left it while you were reading
it would be useless, so the tray window must load the page with that query
string.

Hover expansion resizes the **OS window**, because a 6px window cannot paint
outside itself. That is what `invoke('set_expanded', { expanded })` is for.

The hover listeners are bound to `document.documentElement`, not to `window`.
`mouseenter` and `mouseleave` do not bubble and `window` is not an element in
their dispatch path, so a bubble-phase listener on `window` never fires for
either one. Binding them there is a silent no-op, not a style choice.

## Hover peeks, a click pins

Hover alone is useless if you want to *read* the panel: it collapses the moment
you move toward it. So a `mousedown` anywhere pins the panel open until one of

- the window loses focus — that is "click out", and it is the normal way to
  dismiss;
- **Escape**;
- the pointer leaves, but **only** if the pin never got focus (see below).

While pinned the panel says so: a `PINNED · ESC` hint in the header and a
brighter border, driven by `body[data-pinned]`.

Both dismissals need keyboard focus, which an always-on-top widget does not have
by default — hence `set_pinned`. Two consequences the page handles itself:

- a blur arriving within 500ms of the pin is treated as the window activation
  itself rather than as a click-out, and is re-checked against
  `document.hasFocus()` once the activation settles, so the pin cannot be
  cancelled by the very click that made it;
- if focus never arrives at all (`set_pinned` unimplemented, or the shell
  refusing to activate the window) the page logs a warning and falls back to
  collapse-on-mouseleave, so the panel can never be stuck open with no way out.

## Host contract

`index.html` reads `window.__TAURI__` and degrades to the fixture when it is
absent, which is what makes the browser preview above work at all. Under Tauri
it calls these commands:

| call                                            | the Rust side must                                                                                   |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `invoke('read_quota')`                          | return the parsed `quota --json` envelope                                                             |
| `invoke('set_expanded', { expanded: bool })`    | resize the OS window for the mode                                                                     |
| `invoke('set_pinned', { pinned: bool })`        | make the window focusable and focus it while pinned; release that when unpinned                       |
| `invoke('set_panel_size', { width, height })`   | set the webview **inner** size, in CSS pixels, clamped to the screen                                  |
| `invoke('widget_state')`                        | answer `{ hidden, dock, layout, expanded, pinned }` for the window that asked                        |

and listens for these events:

| event                  | payload            | what the page does                                            |
| ---------------------- | ------------------ | ------------------------------------------------------------- |
| `widget-layout`        | `{ dock, layout }` | re-square the corners and switch the collapsed shape (strip only) |
| `quota-refresh`        | none               | run `load()` now instead of waiting for the 60-second timer   |
| `provider-visibility`  | `{ hidden: [id] }` | redraw without those providers, then re-measure the window    |

### The page never assumes it just started

`widget_state` is asked on **every** load, not only the first, and the answer
wins over the query string. A webview can be reloaded by something other than
the user - a crash and restart, a stray navigation - and when that happens the
JavaScript begins at its defaults (collapsed, unpinned, drawing the layout the
URL named) while the shell's window is still the size the page had grown it to.
That mismatch is the "wide squat box with two badges floating in it" bug. The
shell owns the window, so the shell is asked; the page adopts what it is told,
including the docked edge, which the URL only knows as of the moment the window
was created.

For the same reason nothing in the shell may answer "refresh" by reloading the
document. Refresh means re-read, and `quota-refresh` is how it is asked for.

### Hidden providers are not disabled providers

`provider-visibility` carries the ids the user unticked in the tray menu. Those
providers are still detected, still read on every poll and still in the envelope
- the page just filters them out of what it draws, and re-measures so the strip
shrinks to fit. It is **not** `providers.<id>.enabled` in the config file, which
stops the adapter reading at all. Hiding the last one is a deliberate state: the
collapsed layouts draw one muted word so the widget stays hoverable, and the
panel says which of "you hid them" and "none is installed" it is.

`width`/`height` are the intrinsic size the panel content wants, measured at
`max-content`, so they do not depend on the window's current size and cannot
feed back into the next measurement. They are the size of the panel itself; if
the window needs slack for the drop shadow, add it in Rust.

A rejected command is logged once with `console.warn`, never swallowed. A
missing command therefore degrades visibly rather than silently doing nothing.

The Rust side runs the bundled `quota` sidecar to answer `read_quota`, falling
back to `node dist/cli/index.js --json` in development. No provider logic, no
credentials and no network access exist in this directory.

The page re-reads every 60 seconds and on load. A failed call is rendered as a
failed row, never swallowed.

## Regenerating the fixture

```sh
npm run ui:fixture          # writes ui/fixture.json
```

That compiles `src/` and captures real `quota --json` output. It refuses to
write a fixture with zero readings, since that would leave the preview stuck on
the empty state.

The fixture is **your own usage** — plan names, token counts, spend estimates —
so it is gitignored and never committed. `fixture.sample.json` is the sanitised
stand-in that is, and it deliberately carries every awkward case: a reading with
`"limit": null` (dashed track, no percentage), a *derived* percentage that must
show the `~` marker, a *reported* one that must not, a window whose `resetsAt`
is in the past (`window ended … ago`), a reading over the critical threshold, an
envelope `warnings` entry, and a result with `"ok": false`. Those are the states
the widget exists to be honest about, and a sample without them lets a
regression through.

To capture somewhere else instead:

```sh
node scripts/write-fixture.mjs --out ui/fixture.empty.json
```
