/**
 * Rendering for all three widget layouts.
 *
 * Plain ES module, no framework and no build step, so the Tauri webview loads
 * it directly and a browser can open index.html for design work. The only
 * input is the JSON the `quota --json` sidecar prints, so this file never
 * talks to a provider and never sees a credential.
 *
 * The honesty rules from the core carry through to pixels:
 *   - a reading with no limit gets a grooved track and NO percentage, never an
 *     empty bar, which would read as "nothing used"
 *   - a derived percentage is marked; a provider-reported one is not, and that
 *     distinction is the whole point of tracking confidence
 *   - a window that already reset is called out rather than counted down
 */

const WARN_AT = 75;
const CRIT_AT = 90;

/**
 * Provider marks, drawn as inline SVG.
 *
 * These are geometry we author, not brand assets copied into the repo. That is
 * deliberate on two counts. A vendor's logo file is their property and is not
 * covered by this project's MIT licence, so shipping one would make the
 * licence a lie; and a font glyph (the previous approach) renders differently
 * on every machine and is missing entirely on some. See TRADEMARKS.md.
 *
 * Each entry returns an SVG string drawn on a 24x24 grid in `currentColor`.
 */
const MARKS = {
  /*
   * Each provider's OWN mark, shipped as the vendor published it.
   *
   * These files are not ours and are not covered by this project's licence -
   * see TRADEMARKS.md and the notice in ui/icons/. They are used the way each
   * brand's guidelines describe: unmodified, at their own colours, to identify
   * whose usage a row is reporting, and never as this project's own identity.
   * GitHub's wording is the clearest of the four and covers all of them: "Use a
   * permitted GitHub logo to inform others that your project integrates with
   * GitHub."
   *
   * Unmodified is the load-bearing word. They are drawn from a file rather than
   * inlined so nothing here can tint, stretch or recolour them by accident: the
   * badge colour underneath is ours, the mark on top is theirs. Where a brand
   * ships a variant for dark backgrounds and one for light, the chip is chosen
   * to suit the variant, not the other way round.
   */
  'claude-code': {
    title: 'Claude Code',
    // The clay burst, on a light chip. Anthropic's own file is #D97757.
    file: 'claude-code.svg',
  },
  codex: {
    title: 'OpenAI Codex',
    // The white Blossom, which needs the dark chip under it.
    file: 'codex.svg',
  },
  copilot: {
    title: 'GitHub Copilot',
    // The Invertocat, white. NOT the standalone Copilot face: GitHub
    // deprecated that in 2025, and their current identity for the product is
    // the Invertocat with a wordmark - which cannot be read at 22px, so the
    // mark goes in the badge and the word goes in the row label beside it.
    file: 'copilot.svg',
  },
  cursor: {
    title: 'Cursor',
    // The square avatar Cursor draws for dark grounds. Their SVGs are the
    // cube alone in a 466x532 canvas - portrait, and mostly empty - which is
    // what put it off-centre in a square badge. The avatar is square by
    // construction and is the asset they publish for exactly this use.
    file: 'cursor.png',
  },
  devin: {
    title: 'Devin',
    // Cognition's square avatar, which carries its own white ground - so it
    // fills the badge rather than sitting on a chip of ours.
    file: 'devin.svg',
  },
};

export function badgeFor(id) {
  const mark = MARKS[id];
  if (mark) return { file: mark.file, title: mark.title, known: true };
  // Unknown provider: initials, so a community adapter still gets a badge.
  return { text: (id || '?').slice(0, 2).toUpperCase(), title: id, known: false };
}

/** Escalation rides the bar filling up; only the extreme changes colour. */
export function statusFor(pct) {
  if (pct === null || pct === undefined || Number.isNaN(pct)) return 'unknown';
  if (pct >= CRIT_AT) return 'crit';
  if (pct >= WARN_AT) return 'warn';
  return 'ok';
}

const TONE = {
  ok: 'var(--accent)',
  warn: 'var(--accent-soft)',
  crit: 'var(--crit)',
  unknown: 'var(--track)',
};

/** used/limit as a percentage, or null when there is no honest denominator. */
export function percentOf(reading) {
  if (reading.limit === null || reading.limit === undefined) return null;
  if (!(reading.limit > 0)) return null;
  const pct = (reading.used / reading.limit) * 100;
  if (!Number.isFinite(pct)) return null;
  return Math.min(100, Math.max(0, pct));
}

export function formatTokens(n) {
  if (!Number.isFinite(n)) return '-';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

export function formatUsd(n) {
  if (!Number.isFinite(n)) return '';
  return `$${n.toFixed(2)}`;
}

/**
 * Human gap between two instants, plus the direction, because a window that
 * already ended must never be shown as a countdown approaching zero.
 */
/**
 * How old a provider's figure may be before the row says so.
 *
 * Ten minutes, because under that the answer is "just now" and a row cluttered
 * with an age nobody needed is worse than one without it. Over it, the
 * difference between "83%, now" and "83%, this morning" is the whole story -
 * Anthropic's figure only moves when a terminal session or a refresh catches
 * it, and Codex's only when Codex next runs.
 */
export const STALE_FIGURE_MS = 10 * 60_000;

/** "17h 46m", or null while the figure is current enough not to mention. */
export function figureAge(observedAtIso, now) {
  if (!observedAtIso) return null;
  const then = new Date(observedAtIso).getTime();
  if (!Number.isFinite(then)) return null;
  // A figure stamped in the future is a clock that disagrees, not an age.
  const ms = now.getTime() - then;
  if (ms < STALE_FIGURE_MS) return null;
  const gap = formatGap(observedAtIso, now);
  return gap === null ? null : gap.text;
}

export function formatGap(fromIso, now) {
  if (!fromIso) return null;
  const then = new Date(fromIso).getTime();
  if (!Number.isFinite(then)) return null;

  const ms = then - now.getTime();
  const past = ms < 0;
  const mins = Math.floor(Math.abs(ms) / 60_000);
  if (mins < 1) return { text: 'now', past };

  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const rem = mins % 60;

  let text;
  if (days > 0) text = `${days}d ${String(hours).padStart(2, '0')}h`;
  else if (hours > 0) text = `${hours}h ${String(rem).padStart(2, '0')}m`;
  else text = `${rem}m`;

  return { text, past };
}

const WINDOW_TITLE = {
  session: 'Session',
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
  balance: 'Balance',
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function readingsOf(result) {
  return Array.isArray(result.readings) ? result.readings : [];
}

function makeBadge(id) {
  const mark = badgeFor(id);
  const node = el('span', 'badge');
  node.dataset.provider = mark.known ? id : 'unknown';
  node.title = mark.title;
  if (mark.file) {
    // An <img>, not inline markup: the vendors' files carry their own ids and
    // clip paths, and five of them inlined into one document would collide.
    // It also makes recolouring one by accident impossible, which is a term of
    // using them at all.
    const img = el('img', 'mark');
    img.src = `icons/${mark.file}`;
    img.alt = '';
    node.append(img);
  } else {
    node.textContent = mark.text;
  }
  return node;
}

/** A bar in any orientation. Status drives the groove and the tone. */
function makeBar(pct, status) {
  const bar = el('div', 'bar');
  bar.dataset.status = status;
  bar.style.setProperty('--tone', TONE[status]);
  bar.style.setProperty('--fill', `${pct ?? 0}%`);
  bar.append(el('i'));
  return bar;
}

/* --------------------------------------------------------------- panel -- */

function renderReading(reading, now) {
  const pct = percentOf(reading);
  const status = statusFor(pct);

  const wrap = el('div', 'reading');
  // The scope, when there is one, is part of the name: a per-model weekly
  // limit beside the plan's weekly limit is two different numbers wearing the
  // same word otherwise.
  const title = WINDOW_TITLE[reading.window] ?? reading.window;
  const scope = typeof reading.scope === 'string' ? reading.scope.trim() : '';
  wrap.append(el('div', 'reading-name', scope === '' ? title : `${title} · ${scope}`));

  /*
   * Three columns: label, clock, percentage.
   *
   * The token total used to live in the middle column and was the longest
   * string in the row, which crowded the label out. It is gone and stays gone -
   * the question this widget answers is what PROPORTION is left, and raw
   * tokens are one `--json` away for anyone who wants them.
   *
   * The percentage gets its own column rather than being tacked onto the clock
   * so that the figures line up down the panel and the eye can compare them
   * without reading the sentences they sit in.
   */
  const meta = el('div', 'reading-meta');
  const gap = formatGap(reading.resetsAt, now);

  if (gap && gap.past) {
    meta.classList.add('is-stale');
    meta.textContent = `ended ${gap.text} ago`;
  } else if (gap) {
    meta.textContent = `resets in ${gap.text}`;
  } else {
    meta.textContent = 'no window';
  }

  /*
   * When the provider last said this, when that is not recently.
   *
   * The panel's clock says when the widget last READ; this says when the
   * figure was TRUE, and the two can be hours apart. Without it a stale
   * reported percentage and a current one are the same pixels.
   */
  const age = figureAge(reading.observedAt, now);
  if (age !== null) {
    const stamp = el('span', 'reading-age', ` · ${age} old`);
    stamp.title = `The provider reported this figure ${age} ago; it has not moved since`;
    meta.append(stamp);
  }
  wrap.append(meta);

  const figure = el('div', 'reading-pct');
  if (pct === null) {
    // No cap, so no percentage exists to show. An em dash, never a "0%".
    figure.textContent = '–';
    figure.title = 'No published cap for this plan, so no percentage can be honest';
    figure.classList.add('is-none');
  } else {
    figure.textContent = `${Math.round(pct)}%`;
    figure.dataset.status = status;
    // Derived means the cap came from config, not the provider. Marked,
    // because an estimate that looks identical to a reported figure is a lie
    // by design.
    if (reading.confidence === 'derived') {
      figure.classList.add('est');
      figure.title = 'Estimated: this cap came from your config, not the provider';
    }
  }
  wrap.append(figure);

  wrap.append(makeBar(pct, status));
  return wrap;
}

/** Terse form for the meta line, where every character competes with the label. */
function compactAmount(reading) {
  if (reading.unit === 'tokens') return formatTokens(reading.used);
  if (reading.unit === 'usd') return formatUsd(reading.used);
  if (reading.unit === 'percent') return `${reading.used}%`;
  return formatTokens(reading.used);
}

function amountOf(reading) {
  if (reading.unit === 'tokens') return `${formatTokens(reading.used)} tok`;
  if (reading.unit === 'usd') return formatUsd(reading.used);
  if (reading.unit === 'percent') return `${reading.used}%`;
  return `${formatTokens(reading.used)} ${reading.unit}`;
}

/**
 * The plan a provider's readings agree on, or null if there is nothing useful
 * to show.
 *
 * Readings from one provider normally share a label, but they do not have to,
 * and a header that silently showed only the first one would be wrong rather
 * than merely incomplete. Disagreement is rendered as such.
 */
function planOf(readings) {
  const labels = [...new Set(readings.map((r) => r.label).filter(Boolean))];
  if (labels.length === 0) return null;
  if (labels.length > 1) return labels.join(' / ');
  return labels[0];
}

function renderError(result) {
  const box = el('div', 'row-error');
  box.append(el('b', null, badgeFor(result.id).title));
  box.append(document.createTextNode(` unavailable: ${result.error}`));
  return box;
}

/*
 * Nothing to draw, and the two reasons for it.
 *
 * They are different facts and they need different sentences. "No providers
 * detected" told to someone who has just unticked the last one in the tray
 * menu is a lie that sends them looking for a broken install; the way out of
 * that state is the menu they came from, so the message says so.
 *
 * `hiddenCount` is how many providers the read DID return that the user has
 * hidden. It is not the size of the saved set: that can name a provider which
 * has since been uninstalled, and a stale id must not change what the panel
 * says about the providers in front of it.
 */
const NOTHING_DETECTED =
  'No providers detected. quota-monitor reads tools you already have, so there is nothing to connect. Install Claude Code or Codex and this fills in on its own.';
const ALL_HIDDEN =
  'Every provider is hidden. They are still being read - right-click the tray icon and tick one to draw it again.';

export function renderPanel(root, results, now, hiddenCount = 0) {
  root.replaceChildren();

  const anyReadings = results.some((r) => r.ok && readingsOf(r).length > 0);
  const anyErrors = results.some((r) => !r.ok);

  if (!anyReadings && !anyErrors) {
    root.append(el('div', 'empty', hiddenCount > 0 ? ALL_HIDDEN : NOTHING_DETECTED));
    return;
  }

  for (const result of results) {
    if (!result.ok) {
      root.append(renderError(result));
      continue;
    }
    const readings = readingsOf(result);
    if (readings.length === 0) continue;

    const group = el('div', 'group');
    group.append(makeBadge(result.id));
    const rows = el('div', 'group-rows');

    /*
     * Provider and plan, above the windows they apply to.
     *
     * The plan was being detected, carried on every reading as `label`, and
     * then never shown - so the panel said "Session 18%" without ever saying
     * 18% OF WHAT. It matters twice over here: the cap depends entirely on the
     * plan, and for Claude that cap is one the user supplied, so naming the
     * plan is part of showing your working.
     */
    const head = el('div', 'group-head');
    head.append(el('span', 'group-name', badgeFor(result.id).title));
    const plan = planOf(readings);
    if (plan !== null) head.append(el('span', 'group-plan', plan));
    rows.append(head);

    for (const reading of readings) rows.append(renderReading(reading, now));
    group.append(rows);
    root.append(group);
  }
}

/* ---------------------------------------------------- collapsed layouts -- */

/** Worst window per provider. Both collapsed layouts show only this. */
export function summarise(results) {
  return results.map((result) => {
    if (!result.ok) return { id: result.id, status: 'unknown', pct: null };
    let worst = null;
    for (const reading of readingsOf(result)) {
      const pct = percentOf(reading);
      if (pct === null) continue;
      if (worst === null || pct > worst) worst = pct;
    }
    return { id: result.id, status: statusFor(worst), pct: worst };
  });
}

/*
 * What a collapsed layout draws when it has nothing to draw.
 *
 * An empty card is the worst possible answer: it is indistinguishable from a
 * rendering fault, and hovering it is the only route to the panel that
 * explains itself - so it has to stay a visible, hoverable target. Muted, in
 * the same colour as the numbers it replaces.
 */
function makePlaceholder(className, hiddenCount, terse) {
  const hidden = hiddenCount > 0;
  // The rail is 72px wide and reads sideways, so it gets one word; the bar has
  // 300px and gets a sentence. Same fact either way.
  const text = terse
    ? hidden
      ? 'hidden'
      : 'none'
    : hidden
      ? 'all providers hidden'
      : 'no providers detected';
  const node = el('div', className, text);
  node.title = hidden
    ? 'Every provider is hidden. Right-click the tray icon to show one again.'
    : 'No providers detected yet.';
  // Still a drag grip: a widget you cannot move is worse than an empty one.
  node.dataset.tauriDragRegion = 'deep';
  return node;
}

/** Vertical dock: badges, upright bars, bare numbers. */
export function renderRail(root, results, hiddenCount = 0) {
  root.replaceChildren();

  /*
   * Appended in COLUMN order: badge, bar, number, per provider. `.rail` is a
   * grid of three rows with `grid-auto-flow: column`, so each provider owns one
   * column and the three elements share a vertical axis.
   *
   * They used to be three row containers, one per element type, and that is
   * exactly why nothing lined up: a 22px badge, an 8px bar and a number each
   * centred within its own row, independently, and drifted apart as the number
   * changed width.
   *
   * The badge stays the drag grip - it is the only part of the rail that is not
   * a measurement, so gripping it cannot be confused with poking at a figure.
   * It moves from the old row container onto each badge; "deep" so a press on
   * the glyph inside still counts.
   */
  const items = summarise(results);
  if (items.length === 0) {
    root.append(makePlaceholder('rail-none', hiddenCount, true));
    return;
  }

  for (const item of items) {
    const badge = makeBadge(item.id);
    badge.dataset.tauriDragRegion = 'deep';
    root.append(badge);
    root.append(makeBar(item.pct, item.status));
    root.append(el('div', 'rail-num', item.pct === null ? '–' : `${Math.round(item.pct)}%`));
  }
}

/** Horizontal dock: badge, bar, percentage, repeated. */
export function renderDock(root, results, hiddenCount = 0) {
  root.replaceChildren();

  const items = summarise(results);
  if (items.length === 0) {
    root.append(makePlaceholder('dock-none', hiddenCount, false));
    return;
  }

  for (const item of items) {
    const cell = el('div', 'dock-item');
    cell.append(makeBadge(item.id));
    cell.append(makeBar(item.pct, item.status));
    cell.append(el('div', 'dock-pct', item.pct === null ? '–' : `${Math.round(item.pct)}%`));
    root.append(cell);
  }
}

/* ----------------------------------------------------------------- cost -- */

/** Windows nest, shortest first. `balance` is credit left, not spend. */
const SPEND_WINDOW_RANK = { session: 1, daily: 2, weekly: 3, monthly: 4 };
const WINDOW_LABEL = { session: 'session', daily: 'day', weekly: 'week', monthly: 'month' };

export function windowLabel(window) {
  return WINDOW_LABEL[window] ?? 'window';
}

/**
 * Estimated spend, counting each provider ONCE.
 *
 * Summing every reading double counts, because a session sits inside the week
 * containing it: adding a $32 session to a $902 week reported $934, a number
 * that does not exist. Take each provider's widest window instead.
 */
export function totalCost(results) {
  let total = 0;
  let widest = null;
  let seen = false;

  for (const result of results) {
    if (!result.ok) continue;

    let best = null;
    for (const reading of readingsOf(result)) {
      if (!Number.isFinite(reading.estimatedCostUsd)) continue;
      const rank = SPEND_WINDOW_RANK[reading.window] ?? 0;
      if (rank === 0) continue;
      if (best === null || rank > best.rank) best = { rank, reading };
    }
    if (best === null) continue;

    total += best.reading.estimatedCostUsd;
    seen = true;
    if (widest === null || best.rank > (SPEND_WINDOW_RANK[widest] ?? 0)) {
      widest = best.reading.window;
    }
  }

  return seen ? { total, window: widest } : null;
}
