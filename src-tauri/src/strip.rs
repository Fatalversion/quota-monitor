//! The edge strip: a small dock glued to one edge of a monitor that grows into
//! a panel when the pointer reaches it.
//!
//! Which edge is `widget.dock` until the user drags the widget somewhere else,
//! after which it is wherever they left it. The edge decides the shape. Left and right
//! get the upright `rail` - badges over vertical bars over bare numbers, about
//! 64x190. Top and bottom get the horizontal `bar` - badge, bar, percentage,
//! repeated, about 300x44. The page renders whichever of the two it is asked
//! for; this module only has to put the window in the right place and hand the
//! page the right query string.
//!
//! A webview cannot paint outside its own window, so "expand on hover" is not
//! a CSS transition - it is an OS window resize driven from here, at the
//! frontend's request. index.html handles the hover and calls `set_expanded`;
//! this module decides where the window goes.
//!
//! Two constraints shape everything below:
//!
//!   - The docked edge does not move. Growing away from a right edge means
//!     moving left by exactly as much as the window widens; growing away from
//!     a top edge means not moving at all and getting taller. Either way the
//!     dock appears to unfold rather than slide.
//!   - It must never take focus by accident. The whole point is a widget you
//!     can watch out of the corner of your eye while typing in your editor; a
//!     window that steals the caret when you brush past it would be a bug
//!     worth uninstalling over. Hence `focusable(false)` (WS_EX_NOACTIVATE on
//!     Windows) at build time. It still receives mouse events, which is why
//!     the window is not click-through.
//!
//!     There is exactly one exception, `set_pinned`, and it is the user's own
//!     doing. Hovering is a peek, but a click is a deliberate request to keep
//!     the panel open and read or select something in it. Staying open until
//!     the user clicks away means the window has to be able to notice that
//!     they clicked away - which a window that can never be focused cannot.
//!     So a pin turns `focusable` back on and calls `set_focus`; unpinning
//!     restores `focusable(false)` in the same breath, so idle hovering can
//!     never take the caret again. Those two calls inside `set_pinned` are
//!     the only place in this file that touches focus at all.
//!
//! Dragging is the third thing, and it is why the edge is no longer a constant.
//! The page moves the window through `drag_move` while the button is down and
//! calls `drag_end` when it comes up; the drop snaps to the nearest edge of the
//! monitor the widget was dropped on, adopts that edge's layout, tells the page
//! so it can redraw itself as a rail or a bar, and writes the result down.
//!
//! Note what is deliberately absent: Tauri's own `data-tauri-drag-region`
//! handling. That attribute is on the two handles, because it is the honest
//! description of what they are, but the shell intercepts the press before
//! Tauri's script sees it - see the comment in ui/index.html. Three reasons.
//! `plugin:window|start_dragging` is not in this app's capability list and
//! would be refused; the OS drag it starts swallows the mouseup, so a click on
//! the header could never pin; and it reports no end, so there would be no
//! moment at which to snap.
//!
//! "The monitor" below always means the one the widget is on. `primary_monitor`
//! survives only as the last fallback when nothing else can be determined -
//! using it for anything else is how a widget on a second screen ends up
//! docking itself to the first one.

use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use tauri::{
    AppHandle, Emitter, LogicalPosition, Manager, Monitor, PhysicalPosition, PhysicalRect,
    PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

use crate::config::{Dock, Layout};
use crate::log;
use crate::placement::{self, Placement, Stored};
use crate::state::{AppState, Drag};

pub const LABEL: &str = "strip";

/// Emitted to the strip window when a drop changes which collapsed shape it
/// should draw. The payload is `{ dock, layout }`, both lower-case words, and
/// `layout` is the one the page acts on: `rail` or `bar`.
pub const LAYOUT_EVENT: &str = "widget-layout";

/// Logical size of the collapsed dock in each of its two shapes.
///
/// These are not arbitrary: they are what the CSS in ui/panel.css needs to lay
/// its content out without clipping. The rail stacks a row of 22px badges, a
/// column of bars and a row of 10px numbers inside 12px of padding; the bar
/// puts a badge, an 84px track and a percentage on one 44px-tall line. Change
/// one of these without changing the other side and the content overflows a
/// window that has `overflow: hidden`, which is to say it silently disappears.
/// 72 wide, not 64. At 64 the two 22px badges and their gap did not fit inside
/// the padding, so the grid overflowed and the whole column pair sat off-centre
/// - 6.6px of margin on one side against 2px on the other. Widening by 8px and
/// dropping the rail badge to 20px makes the arithmetic close with room for a
/// four-character "100%" underneath. See the `.rail .badge` note in panel.css.
const RAIL: (f64, f64) = (72.0, 196.0);
const BAR: (f64, f64) = (300.0, 44.0);
/// Logical size of the hover panel before the page has measured itself.
///
/// The old 300x220 is what produced the bug report: four readings plus an
/// error row did not fit, so the token counts were clipped off the right edge
/// and the panel grew a scrollbar. The real size now arrives from
/// `set_panel_size`; this is only the size of the first frame.
pub const PANEL_DEFAULT: (f64, f64) = (340.0, 260.0);

/// Hard bounds on anything `set_panel_size` will accept.
///
/// The number comes from the page measuring itself, so a layout bug there -
/// one runaway element, one unwrapped string - must not be able to turn a
/// six-pixel widget into a window that covers the screen.
/// 320 wide, not 240. At 240 a reading row cannot fit its label and its reset
/// time side by side, so the label truncated to "Ses..." while the figure
/// clipped. The floor exists to stop a bad measurement producing a useless
/// window, and a window too narrow to read is exactly that.
const PANEL_MIN: (f64, f64) = (320.0, 140.0);
const PANEL_MAX_WIDTH: f64 = 560.0;
/// The tallest the panel may get, as a fraction of the monitor work area.
const PANEL_MAX_HEIGHT_FRACTION: f64 = 0.70;
/// Work-area height assumed when the monitor cannot be queried at all. Only
/// used to keep the clamp meaningful in a case that is already logged.
const FALLBACK_WORK_HEIGHT: f64 = 720.0;

/// Frames in the grow/shrink, and the pause between them: about 110ms total.
/// Stepping the OS window is not free, so this is deliberately short and
/// coarse rather than a 60fps easing curve.
const STEPS: u32 = 8;
const FRAME: Duration = Duration::from_millis(14);

/// How long after the last drag frame the widget is still considered held.
/// Comfortably longer than the gap between two mouse moves and far shorter
/// than a user would notice; see `dragging_now`.
const DRAG_QUIET: Duration = Duration::from_millis(400);

/// Makes the hover handlers in index.html actually fire.
///
/// index.html does `addEventListener('mouseenter', ...)` on `window`, which is
/// the obvious thing to write and does not work: mouseenter and mouseleave do
/// not bubble, and the browser dispatches them at the document and the
/// elements being entered, so a bubble-phase listener on `window` is never
/// called. Verified in this app's own WebView2: a `mousemove` listener fires
/// on every pointer move over the strip while the `mouseenter` listener never
/// fires once.
///
/// Rather than edit the frontend - which has to keep working in a plain
/// browser, and where hover is genuinely the frontend's business - the shell
/// supplies the events the page is already waiting for. `mouseover` and
/// `mouseout` do bubble, and a null `relatedTarget` on them means the pointer
/// crossed the window boundary rather than moving between two elements inside
/// it. That is exactly the mouseenter/mouseleave pair, re-dispatched on
/// `window` so the page's own handler runs unmodified.
///
/// This is the only JavaScript the strip window injects, it adds no state the
/// page can see, and removing it changes nothing except that hover stops
/// working.
const HOVER_BRIDGE: &str = r#"
(function () {
  var inside = false;
  function forward(type) {
    window.dispatchEvent(new MouseEvent(type, { bubbles: false, cancelable: false }));
  }
  document.addEventListener('mouseover', function (event) {
    if (inside || event.relatedTarget !== null) return;
    inside = true;
    forward('mouseenter');
  }, true);
  document.addEventListener('mouseout', function (event) {
    if (!inside || event.relatedTarget !== null) return;
    inside = false;
    forward('mouseleave');
  }, true);
})();
"#;

/// Build the strip and dock it. Returns the window so the caller can wire
/// events to it.
pub fn create(app: &AppHandle) -> Result<WebviewWindow, String> {
    let (monitor, placement) = start_on(app);
    let panel = panel_size(app);
    let collapsed = collapsed_size(placement.dock.layout());

    // The query string is the contract with index.html, exactly as it is for
    // the popover. No parameter means the rail, which is the default edge's
    // shape; `?dock=bar` asks for the horizontal one. The page cannot work
    // this out for itself - it has no idea which edge its window is on.
    //
    // It is the first word on the subject rather than the last one now that a
    // drop can change the layout while the page is running: after this, the
    // page learns the layout from the `widget-layout` event `snap` emits.
    // `edge` as well as `dock`: the page squares off the corners that sit
    // against the screen, and a rounded corner flush with the bezel reads as a
    // rendering fault rather than a style. Knowing "rail" is not enough for
    // that - a rail is either the left edge or the right one.
    let url = format!(
        "index.html?dock={}&edge={}",
        placement.dock.layout(),
        placement.dock
    );

    let mut builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App(url.into()))
        .title("quota-monitor")
        .inner_size(collapsed.0, collapsed.1)
        .decorations(false)
        // The card has 16px corners, so the window has to be transparent or
        // the corners sit on a square opaque block. Nothing else may paint a
        // ground either: no `background_color` on the builder, none in
        // tauri.conf.json, and html/body are `background: transparent` in
        // panel.css. The card element is the only thing that paints.
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .shadow(false)
        // Both matter: `focused` is about this moment, `focusable` is about
        // every moment after it.
        .focused(false)
        .focusable(false)
        .initialization_script(HOVER_BRIDGE);

    // Position in the builder as well as after the fact, so the window is
    // never painted once in the middle of the screen and then yanked away.
    if let Ok(monitor) = &monitor {
        let (position, _) = geometry(monitor, placement, false, panel);
        let logical: LogicalPosition<f64> = position.to_logical(monitor.scale_factor());
        builder = builder.position(logical.x, logical.y);
    }

    let window = builder
        .build()
        .map_err(|error| format!("could not create the strip window: {error}"))?;

    match &monitor {
        Ok(monitor) => place(&window, monitor, placement, false, panel)?,
        Err(error) => log::line(&format!(
            "{error}; the strip is wherever the window manager put it"
        )),
    }

    Ok(window)
}

/// The monitor and the placement the widget should first appear at.
///
/// A saved position is only worth restoring if the monitor it was left on is
/// still attached, so the anchor is checked against the work areas that exist
/// right now. When it matches nothing - a screen unplugged, a laptop undocked,
/// a resolution shrunk out from under it - the saved position describes
/// somewhere that no longer exists and is dropped for `widget.dock` rather
/// than restored blindly onto whatever monitor happens to be there. Restoring
/// it would put the widget off screen, which is indistinguishable from the app
/// failing to start.
fn start_on(app: &AppHandle) -> (Result<Monitor, String>, Placement) {
    let state = app.state::<AppState>();
    let fallback = Placement::centred(state.config_dock);

    let Some(stored) = state.restored else {
        return (primary_monitor(app), fallback);
    };

    let monitors = match app.available_monitors() {
        Ok(monitors) if !monitors.is_empty() => monitors,
        Ok(_) => {
            log::line("no monitors were reported; the saved widget position cannot be checked");
            return (primary_monitor(app), forget(app, fallback));
        }
        Err(error) => {
            log::line(&format!(
                "could not list the monitors ({error}); the saved widget position cannot be checked"
            ));
            return (primary_monitor(app), forget(app, fallback));
        }
    };

    let areas: Vec<_> = monitors.iter().map(|monitor| *monitor.work_area()).collect();
    match placement::monitor_index_for(&areas, stored.anchor) {
        Some(index) => {
            log::line(&format!(
                "restoring the widget to the {} edge, {:.0}px along, on the monitor at {},{}",
                stored.placement.dock,
                stored.placement.offset.unwrap_or(0.0),
                areas[index].position.x,
                areas[index].position.y
            ));
            (Ok(monitors[index].clone()), stored.placement)
        }
        None => {
            log::line(&format!(
                "the saved widget position ({},{}) is on no monitor that is attached now; re-docking to widget.dock: {}",
                stored.anchor.x, stored.anchor.y, state.config_dock
            ));
            (primary_monitor(app), forget(app, fallback))
        }
    }
}

/// Throw the restored placement away and go back to `widget.dock`.
///
/// Returns the fallback so callers can use it in the same breath. The stored
/// file is left alone: the next drop overwrites it, and until then a monitor
/// that comes back is a monitor the position is valid on again.
fn forget(app: &AppHandle, fallback: Placement) -> Placement {
    if let Ok(mut current) = app.state::<AppState>().placement.lock() {
        *current = fallback;
    }
    fallback
}

/// Grow to the panel or shrink back to the sliver.
///
/// Returns as soon as the animation is scheduled: the frontend calls this from
/// a mouseenter handler and must not be blocked for the length of an easing
/// curve.
pub fn set_expanded(app: &AppHandle, expanded: bool) -> Result<(), String> {
    let window = app.get_webview_window(LABEL).ok_or_else(|| {
        "the strip window is not running - widget.mode is not strip or both, so there is nothing to resize"
            .to_string()
    })?;

    let state = app.state::<AppState>();
    if !honours_request(state.strip_pinned.load(Ordering::SeqCst), expanded) {
        // Not a failure: the pin is doing exactly its job. The page fires this
        // collapse from a 350ms timer it cannot always cancel in time, and
        // refusing it here is cheaper than making the page track focus.
        return Ok(());
    }
    state.strip_expanded.store(expanded, Ordering::SeqCst);
    // Claim this animation. Any frame belonging to an older one stops.
    let generation = state.strip_generation.fetch_add(1, Ordering::SeqCst) + 1;

    let monitor = strip_monitor(app)?;
    let (to_position, to_size) = geometry(&monitor, placement(app), expanded, panel_size(app));

    let from_position = window
        .outer_position()
        .map_err(|error| format!("could not read the strip position: {error}"))?;
    let from_size = window
        .inner_size()
        .map_err(|error| format!("could not read the strip size: {error}"))?;

    if from_position == to_position && from_size == to_size {
        return Ok(());
    }

    let app = app.clone();
    std::thread::Builder::new()
        .name("strip-resize".to_string())
        .spawn(move || {
            let state = app.state::<AppState>();
            let mut complained = false;

            for step in 1..=STEPS {
                if state.strip_generation.load(Ordering::SeqCst) != generation {
                    return; // superseded mid-flight
                }

                let t = ease_out(f64::from(step) / f64::from(STEPS));
                let position = PhysicalPosition::new(
                    lerp_i32(from_position.x, to_position.x, t),
                    lerp_i32(from_position.y, to_position.y, t),
                );
                let size = PhysicalSize::new(
                    lerp_u32(from_size.width, to_size.width, t),
                    lerp_u32(from_size.height, to_size.height, t),
                );

                // Keep the docked edge still. An OS window cannot change
                // position and size in one atomic step, so every frame is
                // briefly the old size at the new position, or the new size at
                // the old one. Only one of those two can overhang the screen
                // edge the window is glued to: grow only after moving, and
                // shrink before moving. That holds for all four edges - what
                // would overhang is always the far side of the window, and
                // enlarging in place is the only way to push it there.
                let outcome = if move_before_resize(expanded) {
                    window.set_position(position).and_then(|()| window.set_size(size))
                } else {
                    window.set_size(size).and_then(|()| window.set_position(position))
                };

                if let Err(error) = outcome {
                    if !complained {
                        complained = true;
                        log::line(&format!("could not resize the strip: {error}"));
                    }
                }

                if step < STEPS {
                    std::thread::sleep(FRAME);
                }
            }
        })
        .map_err(|error| format!("could not start the strip animation: {error}"))?;

    Ok(())
}

/// Pin the panel open, or let it go again.
///
/// Pinning is the sanctioned exception to "the strip never takes focus" - see
/// the note at the top of this file. `focusable(true)` plus `set_focus` are
/// what let a later blur in the page mean "the user clicked somewhere else";
/// unpinning takes both away again immediately.
pub fn set_pinned(app: &AppHandle, pinned: bool) -> Result<(), String> {
    let window = app.get_webview_window(LABEL).ok_or_else(|| {
        "the strip window is not running - widget.mode is not strip or both, so there is nothing to pin"
            .to_string()
    })?;

    // Stored before the window calls, so a collapse racing in behind an unpin
    // is honoured and one racing in behind a pin is not.
    app.state::<AppState>().strip_pinned.store(pinned, Ordering::SeqCst);

    window
        .set_focusable(pinned)
        .map_err(|error| format!("could not set focusable({pinned}) on the strip: {error}"))?;

    if pinned {
        window
            .set_focus()
            .map_err(|error| format!("could not focus the pinned strip: {error}"))?;
    }

    Ok(())
}

/// Fit the expanded panel to the content the page just measured.
///
/// The page reports `scrollWidth`/`scrollHeight` in CSS pixels after every
/// paint. Anything that is not a size at all is refused; anything merely
/// implausible is clamped. When the panel is already open the new geometry is
/// applied at once - snapped, not animated, because this is a correction to a
/// window the user is already looking at rather than a transition.
pub fn set_panel_size(app: &AppHandle, width: f64, height: f64) -> Result<(), String> {
    let monitor = strip_monitor(app);
    let work_height = match &monitor {
        Ok(monitor) => logical_work_height(monitor),
        Err(error) => {
            log::line(&format!(
                "{error}; clamping the panel height against a {FALLBACK_WORK_HEIGHT}px fallback"
            ));
            FALLBACK_WORK_HEIGHT
        }
    };

    let size = clamp_panel_size(width, height, work_height)?;

    let state = app.state::<AppState>();
    {
        let mut stored = state
            .strip_panel_size
            .lock()
            .map_err(|_| "the stored panel size is poisoned".to_string())?;
        // Deliberately NOT `if *stored == size { return }`.
        //
        // That early-out assumed the window is at the stored size, and it is
        // not always: an expand animation that gets superseded stops wherever
        // it had reached and nothing writes a final frame. Skipping the
        // re-place because the STORED value already looked right then left the
        // window frozen at frame 1 of 8 - 154px wide, content clipped, both
        // scrollbars showing - and it never recovered, because every later
        // measurement matched the store and skipped too.
        //
        // Measured after a tray visibility toggle: 10 freezes in 12 trials, all
        // exactly `ease_out(1/8)` of the way from the rail to the panel.
        //
        // So the store is now just a record, and the re-place below is what
        // makes it true. Placing is idempotent and costs one Win32 call on a
        // path that already runs at most once per paint.
        *stored = size;
    }

    // Nothing on screen to correct: the sliver is the same six pixels wide
    // whatever the panel would have measured.
    if !state.strip_expanded.load(Ordering::SeqCst) {
        return Ok(());
    }

    // A re-place snaps the window back to its docked geometry, which is the
    // one place the widget must not be while the user is holding it somewhere
    // else. The size is recorded above either way, and the drop re-places with
    // it a moment later.
    if dragging_now(app) {
        return Ok(());
    }

    let window = app.get_webview_window(LABEL).ok_or_else(|| {
        "the strip window is not running - widget.mode is not strip or both, so there is nothing to resize"
            .to_string()
    })?;
    let monitor = monitor?;
    // Any grow still in flight is animating toward the size just replaced.
    state.strip_generation.fetch_add(1, Ordering::SeqCst);
    place(&window, &monitor, placement(app), true, size)
}

/// Move the widget while the pointer drags it.
///
/// `dx`/`dy` are the total offset in CSS pixels from where the press started,
/// not a step since the last frame, so a dropped or reordered frame costs
/// nothing and rounding never accumulates. `gesture` counts presses: the first
/// frame of a new one is what captures the origin, which means a gesture that
/// ended without saying so - the pointer capture broke, the page reloaded -
/// cannot leave a stale origin for the next drag to jump from.
pub fn drag_move(app: &AppHandle, gesture: u64, dx: f64, dy: f64) -> Result<(), String> {
    let window = app.get_webview_window(LABEL).ok_or_else(|| {
        "the strip window is not running - widget.mode is not strip or both, so there is nothing to drag"
            .to_string()
    })?;

    if !dx.is_finite() || !dy.is_finite() {
        return Err(format!("{dx},{dy} is not a drag offset"));
    }

    let state = app.state::<AppState>();
    // A drag beats an animation. Without this the tail of a hover expand keeps
    // stepping the window back toward the edge it is being dragged away from.
    state.strip_generation.fetch_add(1, Ordering::SeqCst);

    let origin = {
        let mut drag = state
            .drag
            .lock()
            .map_err(|_| "the drag state is poisoned".to_string())?;
        let origin = match *drag {
            Some(current) if current.gesture == gesture => current.origin,
            _ => window
                .outer_position()
                .map_err(|error| format!("could not read the strip position: {error}"))?,
        };
        *drag = Some(Drag { gesture, origin, last_frame: Instant::now() });
        origin
    };

    // The pointer's offset is in CSS pixels of whichever monitor the pointer
    // is over; the window's position is physical. The scale factor of the
    // window's own monitor is the only one we can ask for, and on a mixed-DPI
    // desktop it is right for the screen the widget is still on and slightly
    // off for the one it is being dragged toward. It self-corrects the moment
    // the window crosses over, and the drop snaps regardless.
    let scale = monitor_scale(&window);
    let position = PhysicalPosition::new(
        origin.x.saturating_add(round_i32(dx * scale)),
        origin.y.saturating_add(round_i32(dy * scale)),
    );

    window
        .set_position(position)
        .map_err(|error| format!("could not move the strip: {error}"))
}

/// The pointer came up: put the widget on the nearest edge and remember it.
pub fn drag_end(app: &AppHandle, gesture: u64, dx: f64, dy: f64) -> Result<(), String> {
    // The last frame first, so a drop is exactly where the pointer let go
    // rather than one mousemove behind it.
    let moved = drag_move(app, gesture, dx, dy);

    if let Ok(mut drag) = app.state::<AppState>().drag.lock() {
        *drag = None;
    }

    moved?;
    snap(app)
}

/// Snap the widget to the nearest edge of the monitor it is now on.
///
/// The drop point is the window's own centre rather than the pointer: the
/// pointer is wherever on the handle the user happened to grab, and a widget
/// dragged by the right-hand end of its header would otherwise dock to a
/// different edge than the one it visibly sits nearest.
fn snap(app: &AppHandle) -> Result<(), String> {
    let window = app.get_webview_window(LABEL).ok_or_else(|| {
        "the strip window is not running - widget.mode is not strip or both, so there is nothing to snap"
            .to_string()
    })?;

    let position = window
        .outer_position()
        .map_err(|error| format!("could not read the strip position: {error}"))?;
    let size = window
        .outer_size()
        .map_err(|error| format!("could not read the strip size: {error}"))?;
    let centre = PhysicalPosition::new(
        position.x.saturating_add(size.width as i32 / 2),
        position.y.saturating_add(size.height as i32 / 2),
    );

    let monitor = monitor_at(app, &window, centre)?;
    let area = monitor.work_area();
    let dock = placement::nearest_edge(centre, area);
    let offset = placement::offset_along(dock, area, position, monitor.scale_factor());
    let chosen = Placement { dock, offset: Some(offset) };

    let state = app.state::<AppState>();
    let was = {
        let mut current = state
            .placement
            .lock()
            .map_err(|_| "the stored placement is poisoned".to_string())?;
        let was = *current;
        *current = chosen;
        was
    };

    // Re-place before telling anyone: switching between the rail and the bar
    // changes the collapsed size, so the window left where the drag ended is
    // the wrong shape in the wrong spot until this runs.
    let expanded = state.strip_expanded.load(Ordering::SeqCst);
    state.strip_generation.fetch_add(1, Ordering::SeqCst);
    place(&window, &monitor, chosen, expanded, panel_size(app))?;

    // Where that put it, computed rather than read back. `geometry` clamps
    // into the work area, so this point is guaranteed to be on the monitor the
    // widget was dropped on - which is the whole job of the anchor, and is not
    // guaranteed by a raw drop position near a corner.
    let (anchor, _) = geometry(&monitor, chosen, expanded, panel_size(app));

    // The page renders whichever collapsed shape it was told to at startup, so
    // an edge that changed the layout has to reach it. An event rather than a
    // getter: the page has no reason to poll for something that changes only
    // when the user drags the thing, and an event arrives before the window is
    // next collapsed rather than after.
    // Emit on ANY edge change, not only when the layout changes. Right to left
    // keeps the rail but moves which side is flush against the screen, and the
    // page cannot square the correct corners without being told.
    if was.dock != chosen.dock {
        if let Err(error) = app.emit_to(
            LABEL,
            LAYOUT_EVENT,
            serde_json::json!({
                "dock": dock.to_string(),
                "layout": dock.layout().to_string(),
            }),
        ) {
            log::line(&format!(
                "could not tell the widget it is now a {} ({error}); it will redraw as a {} on the next restart",
                dock.layout(),
                was.dock.layout()
            ));
        }
    }

    remember(app, chosen, anchor);
    Ok(())
}

/// Whether the pointer is dragging the widget at this moment.
///
/// Deliberately a recent-frame test rather than a flag. The frontend clears
/// the flag when the button comes up, and the one case where it cannot - the
/// page reloaded with the button still down - must not leave the widget stuck
/// refusing to re-place itself forever.
fn dragging_now(app: &AppHandle) -> bool {
    match app.state::<AppState>().drag.lock() {
        Ok(drag) => drag.is_some_and(|drag| drag.last_frame.elapsed() < DRAG_QUIET),
        Err(_) => false,
    }
}

/// Write the placement down, if there is anywhere to write it.
fn remember(app: &AppHandle, chosen: Placement, anchor: PhysicalPosition<i32>) {
    let Some(path) = app.state::<AppState>().placement_path.clone() else {
        // Logged once already, at startup. Saying it again on every drop would
        // bury the log in the one message the user can do nothing about.
        return;
    };
    placement::store(&path, Stored { placement: chosen, anchor });
}

/// Whether a `set_expanded` request should be acted on.
///
/// Expanding is always honoured. Collapsing is refused while pinned, which is
/// the whole reason the pin exists: the panel has to survive the pointer
/// leaving it, or it can never be clicked into.
fn honours_request(pinned: bool, expanded: bool) -> bool {
    expanded || !pinned
}

/// Fit a measured panel size into the bounds above.
///
/// `work_height` is the logical height of the monitor work area. A measurement
/// that is not a size at all - NaN, infinity, zero, negative - comes back as
/// an error rather than a clamped value: that is a bug in the caller, and
/// quietly substituting a default would hide it.
fn clamp_panel_size(width: f64, height: f64, work_height: f64) -> Result<(f64, f64), String> {
    if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
        return Err(format!("{width}x{height} is not a panel size"));
    }

    // `max` keeps the ceiling above the floor however small - or however
    // broken - the reported work area is. `f64::clamp` panics on crossed
    // bounds, and a NaN work area would otherwise get that far.
    let max_height = (work_height * PANEL_MAX_HEIGHT_FRACTION).max(PANEL_MIN.1);

    Ok((
        width.clamp(PANEL_MIN.0, PANEL_MAX_WIDTH),
        height.clamp(PANEL_MIN.1, max_height),
    ))
}

/// Where the widget is: the edge and the offset along it.
///
/// A poisoned lock means another thread panicked holding it. Falling back to
/// the configured edge, centred, puts the widget somewhere visible - which
/// beats refusing to place it at all.
fn placement(app: &AppHandle) -> Placement {
    let state = app.state::<AppState>();
    let current = match state.placement.lock() {
        Ok(placement) => *placement,
        Err(_) => Placement::centred(state.config_dock),
    };
    current
}

/// Which edge the strip is on right now.
///
/// Public because a page that has just loaded has to be told: the edge reaches
/// it in the URL at creation, and a drag to another edge afterwards does not
/// rewrite that URL. See `widget_state` in main.rs.
pub fn current_dock(app: &AppHandle) -> Dock {
    placement(app).dock
}

/// Logical size of the collapsed window for a given layout.
fn collapsed_size(layout: Layout) -> (f64, f64) {
    match layout {
        Layout::Rail => RAIL,
        Layout::Bar => BAR,
    }
}

/// Whether a frame of the animation should move the window before resizing it.
///
/// See the note at the call site: growing in place is what pushes a window
/// past the edge it is docked against, so grow only after moving and shrink
/// before moving. Depends on the direction alone, not on which edge - the
/// overhang is always on the window's far side, whichever side that is.
fn move_before_resize(expanded: bool) -> bool {
    expanded
}

/// The measured panel size, or the default when nothing has measured yet.
///
/// A poisoned lock means another thread panicked while holding it; falling
/// back to the default beats refusing to move the window over it.
fn panel_size(app: &AppHandle) -> (f64, f64) {
    match app.state::<AppState>().strip_panel_size.lock() {
        Ok(size) => *size,
        Err(_) => PANEL_DEFAULT,
    }
}

/// Height of the monitor work area in logical pixels.
fn logical_work_height(monitor: &Monitor) -> f64 {
    let scale = monitor.scale_factor();
    let height = f64::from(monitor.work_area().size.height);
    if scale > 0.0 && height > 0.0 {
        height / scale
    } else {
        FALLBACK_WORK_HEIGHT
    }
}

/// Snap the strip to its docked geometry with no animation. Used at startup
/// and when something external (a second launch, a resolution change) means
/// the window may no longer be where we left it.
pub fn redock(app: &AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window(LABEL) else {
        return Ok(());
    };
    let monitor = strip_monitor(app)?;
    let expanded = app.state::<AppState>().strip_expanded.load(Ordering::SeqCst);
    // Cancel any animation that is mid-flight, or it will undo this.
    app.state::<AppState>()
        .strip_generation
        .fetch_add(1, Ordering::SeqCst);
    place(&window, &monitor, placement(app), expanded, panel_size(app))
}

fn place(
    window: &WebviewWindow,
    monitor: &Monitor,
    placement: Placement,
    expanded: bool,
    panel: (f64, f64),
) -> Result<(), String> {
    let (position, size) = geometry(monitor, placement, expanded, panel);
    window
        .set_position(position)
        .map_err(|error| format!("could not move the strip: {error}"))?;
    window
        .set_size(size)
        .map_err(|error| format!("could not size the strip: {error}"))
}

/// Where the strip belongs, in physical pixels.
///
/// Uses the monitor's work area rather than its full size, so a taskbar - on
/// any edge, including the one we are docking to - does not end up sitting on
/// top of the widget or the widget on top of it.
fn geometry(
    monitor: &Monitor,
    placement: Placement,
    expanded: bool,
    panel: (f64, f64),
) -> (PhysicalPosition<i32>, PhysicalSize<u32>) {
    geometry_in(
        monitor.work_area(),
        monitor.scale_factor(),
        placement,
        expanded,
        panel,
    )
}

/// The geometry calculation itself, with the monitor taken out of it.
///
/// A `Monitor` cannot be constructed without a window manager, so the rule
/// that actually matters - the docked edge does not move, and the window never
/// lands off screen - would otherwise be untestable. Everything here is
/// arithmetic on a work area, and every test below drives this function.
fn geometry_in(
    area: &PhysicalRect<i32, u32>,
    scale: f64,
    placement: Placement,
    expanded: bool,
    panel: (f64, f64),
) -> (PhysicalPosition<i32>, PhysicalSize<u32>) {
    let dock = placement.dock;
    let (logical_width, logical_height) = if expanded {
        panel
    } else {
        collapsed_size(dock.layout())
    };

    // A widget wider or taller than the screen it is docked to is not a widget
    // any more. The clamp is what makes the "never off screen" guarantee below
    // hold rather than merely usually hold.
    let width = physical(logical_width, scale).min(area.size.width.max(1));
    let height = physical(logical_height, scale).min(area.size.height.max(1));

    let left = area.position.x;
    let top = area.position.y;
    let right = left.saturating_add(area.size.width as i32);
    let bottom = top.saturating_add(area.size.height as i32);

    // The docked edge is fixed; the other axis is wherever the user last
    // dropped it, or centred when they never have. Right and bottom are the
    // two that have to subtract the window's own size, which is exactly the
    // arithmetic that used to be hard-coded for the right edge.
    let (x, y) = match dock {
        Dock::Left => (left, along(top, bottom, height, placement.offset, scale)),
        Dock::Right => (
            right - width as i32,
            along(top, bottom, height, placement.offset, scale),
        ),
        Dock::Top => (along(left, right, width, placement.offset, scale), top),
        Dock::Bottom => (
            along(left, right, width, placement.offset, scale),
            bottom - height as i32,
        ),
    };

    // Belt and braces. The two clamps above should already make this a no-op,
    // but a work area with a negative origin (a monitor left of the primary)
    // or one smaller than the widget is the sort of thing that only shows up
    // on someone else's desk, and a widget parked off screen is invisible with
    // no way to get it back. `max` keeps the bounds from crossing.
    let x = x.clamp(left, (right - width as i32).max(left));
    let y = y.clamp(top, (bottom - height as i32).max(top));

    (PhysicalPosition::new(x, y), PhysicalSize::new(width, height))
}

/// Where the window sits along the edge it is not docked to.
///
/// `None` centres it, which is the config default and what every build before
/// dragging did. An offset is logical pixels from `near`, and is clamped so
/// that a window remembered from a taller screen, or from a monitor whose
/// resolution changed under it, comes back inside the work area rather than
/// hanging off the end of the edge it is glued to.
fn along(near: i32, far: i32, extent: u32, offset: Option<f64>, scale: f64) -> i32 {
    let Some(offset) = offset else {
        return centred(near, far, extent);
    };
    let last = (far - extent as i32).max(near);
    near.saturating_add(physical_offset(offset, scale)).clamp(near, last)
}

/// Centre an `extent` between `near` and `far`, never before `near`.
fn centred(near: i32, far: i32, extent: u32) -> i32 {
    near + ((far - near - extent as i32) / 2).max(0)
}

/// A logical offset in physical pixels, never negative and never big enough to
/// overflow the addition it is about to take part in.
fn physical_offset(logical: f64, scale: f64) -> i32 {
    let scale = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    round_i32(logical * scale).max(0)
}

/// Round to a pixel, saturating rather than wrapping. `as i32` on a float
/// larger than i32::MAX is a saturating cast in Rust, but NaN becomes 0, and
/// 0 is a perfectly plausible-looking wrong answer - so it is spelled out.
fn round_i32(value: f64) -> i32 {
    if !value.is_finite() {
        return 0;
    }
    value.round().clamp(f64::from(i32::MIN) / 2.0, f64::from(i32::MAX) / 2.0) as i32
}

fn physical(logical: f64, scale: f64) -> u32 {
    let value = (logical * scale).round();
    if value < 1.0 {
        1
    } else {
        value as u32
    }
}

fn primary_monitor(app: &AppHandle) -> Result<Monitor, String> {
    match app.primary_monitor() {
        Ok(Some(monitor)) => Ok(monitor),
        Ok(None) => Err("no primary monitor was reported by the system".to_string()),
        Err(error) => Err(format!("could not query the primary monitor: {error}")),
    }
}

/// The monitor the widget lives on.
///
/// Everything that places the window has to ask this rather than
/// `primary_monitor`: a widget dragged to a second screen must expand into
/// that screen's work area, clamp against that screen's height and dock to
/// that screen's edges. Asking the primary would quietly teleport it home the
/// first time the pointer touched it.
///
/// Falling back to the primary is still better than failing - a widget on the
/// wrong monitor can be dragged back, a widget that refused to move cannot -
/// but it is a degraded answer, so it says so. Once: this runs on every hover.
fn strip_monitor(app: &AppHandle) -> Result<Monitor, String> {
    let Some(window) = app.get_webview_window(LABEL) else {
        return primary_monitor(app);
    };

    if let Ok(Some(monitor)) = window.current_monitor() {
        return Ok(monitor);
    }
    if let Ok(position) = window.outer_position() {
        if let Ok(Some(monitor)) =
            window.monitor_from_point(f64::from(position.x), f64::from(position.y))
        {
            return Ok(monitor);
        }
    }

    static NOTED: std::sync::Once = std::sync::Once::new();
    NOTED.call_once(|| {
        log::line("could not tell which monitor the widget is on; using the primary one");
    });
    primary_monitor(app)
}

/// The monitor a given point is on, for deciding where a drop landed.
///
/// The point comes first because that is the question being asked - which
/// screen did the user let go over - and the window's own monitor is only the
/// answer when the point is somewhere the system does not recognise, such as
/// the gap between two monitors of different heights.
fn monitor_at(
    app: &AppHandle,
    window: &WebviewWindow,
    point: PhysicalPosition<i32>,
) -> Result<Monitor, String> {
    if let Ok(Some(monitor)) = window.monitor_from_point(f64::from(point.x), f64::from(point.y)) {
        return Ok(monitor);
    }
    log::line(&format!(
        "the drop at {},{} is on no monitor; snapping to the one the widget is on",
        point.x, point.y
    ));
    strip_monitor(app)
}

/// The scale factor of the monitor the widget is on, or 1.0 if it cannot be
/// determined. Used to turn the pointer's CSS-pixel travel into real pixels.
fn monitor_scale(window: &WebviewWindow) -> f64 {
    match window.scale_factor() {
        Ok(scale) if scale.is_finite() && scale > 0.0 => scale,
        _ => 1.0,
    }
}

/// Cubic ease-out: quick off the mark, gentle into place.
fn ease_out(t: f64) -> f64 {
    let t = t.clamp(0.0, 1.0);
    1.0 - (1.0 - t).powi(3)
}

fn lerp_i32(from: i32, to: i32, t: f64) -> i32 {
    (f64::from(from) + (f64::from(to) - f64::from(from)) * t).round() as i32
}

fn lerp_u32(from: u32, to: u32, t: f64) -> u32 {
    let value = f64::from(from) + (f64::from(to) - f64::from(from)) * t;
    if value < 1.0 {
        1
    } else {
        value.round() as u32
    }
}

#[cfg(test)]
mod tests {
    use super::{
        clamp_panel_size, collapsed_size, ease_out, geometry_in, honours_request, lerp_i32,
        lerp_u32, move_before_resize, physical, round_i32, BAR, PANEL_DEFAULT, PANEL_MIN, RAIL,
        STEPS,
    };
    use crate::config::{Dock, Layout};
    use crate::placement::{nearest_edge, offset_along, Placement};
    use tauri::{PhysicalPosition, PhysicalRect, PhysicalSize};

    const EDGES: [Dock; 4] = [Dock::Left, Dock::Right, Dock::Top, Dock::Bottom];

    /// A work area, the way `Monitor::work_area` hands one over.
    fn area(x: i32, y: i32, width: u32, height: u32) -> PhysicalRect<i32, u32> {
        PhysicalRect {
            position: PhysicalPosition::new(x, y),
            size: PhysicalSize::new(width, height),
        }
    }

    /// A 1920x1040 work area on a 1080p screen: a 40px taskbar along the
    /// bottom, which is where this machine's is.
    fn desktop() -> PhysicalRect<i32, u32> {
        area(0, 0, 1920, 1040)
    }

    /// The four sides of a placed window, as absolute coordinates.
    fn sides(placed: (PhysicalPosition<i32>, PhysicalSize<u32>)) -> (i32, i32, i32, i32) {
        let (position, size) = placed;
        (
            position.x,
            position.y,
            position.x + size.width as i32,
            position.y + size.height as i32,
        )
    }

    /// The coordinate of the docked edge: the one that must not move.
    fn docked_edge(dock: Dock, placed: (PhysicalPosition<i32>, PhysicalSize<u32>)) -> i32 {
        let (left, top, right, bottom) = sides(placed);
        match dock {
            Dock::Left => left,
            Dock::Right => right,
            Dock::Top => top,
            Dock::Bottom => bottom,
        }
    }

    /// Where that edge should be, for a given work area.
    fn work_edge(dock: Dock, work: &PhysicalRect<i32, u32>) -> i32 {
        match dock {
            Dock::Left => work.position.x,
            Dock::Right => work.position.x + work.size.width as i32,
            Dock::Top => work.position.y,
            Dock::Bottom => work.position.y + work.size.height as i32,
        }
    }

    fn assert_on_screen(
        work: &PhysicalRect<i32, u32>,
        placed: (PhysicalPosition<i32>, PhysicalSize<u32>),
        what: &str,
    ) {
        let (left, top, right, bottom) = sides(placed);
        let work_right = work.position.x + work.size.width as i32;
        let work_bottom = work.position.y + work.size.height as i32;
        // One pixel of slack: position and size are rounded separately, so a
        // fractional scale factor can put an edge a pixel over. A pixel is not
        // "off screen"; a widget is.
        assert!(
            left >= work.position.x - 1
                && top >= work.position.y - 1
                && right <= work_right + 1
                && bottom <= work_bottom + 1,
            "{what}: {left},{top}..{right},{bottom} is outside {},{}..{work_right},{work_bottom}",
            work.position.x,
            work.position.y
        );
    }

    #[test]
    fn easing_starts_and_ends_where_it_should() {
        assert_eq!(ease_out(0.0), 0.0);
        assert_eq!(ease_out(1.0), 1.0);
        assert!(ease_out(0.5) > 0.5, "ease-out is ahead of linear at the midpoint");
        assert_eq!(ease_out(2.0), 1.0, "clamped, never overshoots the target");
    }

    #[test]
    fn interpolation_lands_exactly_on_the_target() {
        assert_eq!(lerp_i32(1914, 1614, 1.0), 1614);
        assert_eq!(lerp_u32(6, 300, 1.0), 300);
        assert_eq!(lerp_i32(-100, 100, 0.5), 0);
    }

    #[test]
    fn a_window_is_never_zero_pixels_wide() {
        assert_eq!(lerp_u32(6, 300, 0.0), 6);
        assert_eq!(physical(6.0, 0.01), 1);
        assert_eq!(physical(6.0, 1.5), 9);
    }

    #[test]
    fn a_plausible_measurement_is_taken_as_it_comes() {
        assert_eq!(clamp_panel_size(360.0, 300.0, 1000.0), Ok((360.0, 300.0)));
        // The default has to survive its own clamp, or the very first paint
        // would resize the window for no reason.
        assert_eq!(
            clamp_panel_size(PANEL_DEFAULT.0, PANEL_DEFAULT.1, 1000.0),
            Ok(PANEL_DEFAULT)
        );
    }

    #[test]
    fn a_runaway_measurement_cannot_take_over_the_screen() {
        assert_eq!(clamp_panel_size(4000.0, 300.0, 1000.0), Ok((560.0, 300.0)));
        // 70% of the work area, not of the screen and not of the measurement.
        assert_eq!(clamp_panel_size(360.0, 4000.0, 1000.0), Ok((360.0, 700.0)));
        // 70% of 1440 is 1007.9999999999999 in binary floating point. The
        // clamp does not round, and it does not need to: `physical` rounds
        // once, at the point the number becomes an actual pixel count.
        let (width, height) = clamp_panel_size(9999.0, 9999.0, 1440.0).unwrap();
        assert_eq!(width, 560.0);
        assert!((height - 1008.0).abs() < 0.001, "{height} should be 70% of 1440");
    }

    #[test]
    fn a_cramped_measurement_is_floored() {
        assert_eq!(clamp_panel_size(10.0, 10.0, 1000.0), Ok(PANEL_MIN));
    }

    #[test]
    fn the_height_bounds_never_cross() {
        // 70% of a 100px work area is below the floor: the floor wins, and
        // nothing panics on an inverted clamp.
        assert_eq!(clamp_panel_size(360.0, 300.0, 100.0), Ok((360.0, PANEL_MIN.1)));
        assert_eq!(clamp_panel_size(360.0, 300.0, 0.0), Ok((360.0, PANEL_MIN.1)));
        assert_eq!(clamp_panel_size(360.0, 300.0, f64::NAN), Ok((360.0, PANEL_MIN.1)));
    }

    #[test]
    fn a_measurement_that_is_not_a_size_is_refused() {
        for (width, height) in [
            (0.0, 260.0),
            (340.0, 0.0),
            (-340.0, 260.0),
            (340.0, -260.0),
            (f64::NAN, 260.0),
            (340.0, f64::NAN),
            (f64::INFINITY, 260.0),
            (340.0, f64::INFINITY),
        ] {
            assert!(
                clamp_panel_size(width, height, 1000.0).is_err(),
                "{width}x{height} should be refused, not clamped"
            );
        }
    }

    #[test]
    fn a_pinned_panel_ignores_collapse_but_not_expansion() {
        // The bug the pin exists to fix: a mouseleave arriving after a click
        // must not shrink the panel out from under the user.
        assert!(!honours_request(true, false));
        assert!(honours_request(true, true));
        // Unpinned, hover behaves exactly as it always did.
        assert!(honours_request(false, false));
        assert!(honours_request(false, true));
    }

    #[test]
    fn the_edge_decides_the_collapsed_shape() {
        // Left and right stand the dock up; top and bottom lay it down. The
        // shell must not be able to ask the page for a rail and then hand it a
        // 300x44 window to draw one in.
        assert_eq!(collapsed_size(Layout::Rail), RAIL);
        assert_eq!(collapsed_size(Layout::Bar), BAR);

        let work = desktop();
        for dock in EDGES {
            let (_, size) = geometry_in(&work, 1.0, Placement::centred(dock), false, PANEL_DEFAULT);
            let expected = collapsed_size(dock.layout());
            assert_eq!(
                (size.width, size.height),
                (expected.0 as u32, expected.1 as u32),
                "{dock} collapsed"
            );
        }
    }

    #[test]
    fn every_edge_stays_glued_to_its_edge_across_collapse_and_expand() {
        // The whole point of the widget: it unfolds out of the edge it lives
        // on. Before this, only a right dock did - a top dock would have grown
        // upward, off the top of the screen.
        for work in [desktop(), area(0, 0, 1080, 1920), area(-1920, -200, 1600, 900)] {
            for dock in EDGES {
                let edge = work_edge(dock, &work);
                for scale in [1.0, 1.25, 1.5, 2.0] {
                    let collapsed = geometry_in(&work, scale, Placement::centred(dock), false, PANEL_DEFAULT);
                    let expanded = geometry_in(&work, scale, Placement::centred(dock), true, PANEL_DEFAULT);
                    assert_eq!(
                        docked_edge(dock, collapsed),
                        edge,
                        "{dock} collapsed at {scale}x came unglued"
                    );
                    assert_eq!(
                        docked_edge(dock, expanded),
                        edge,
                        "{dock} expanded at {scale}x came unglued"
                    );
                }
            }
        }
    }

    #[test]
    fn the_free_axis_is_centred_in_the_work_area() {
        let work = desktop();

        // Derived from the constants, never retyped. This test pinned a literal
        // 190 and 300, so widening the rail to fit its own badges broke a test
        // about CENTRING, which has nothing to do with how wide the rail is.
        let rail_h = RAIL.1 as i32;
        let bar_w = BAR.0 as i32;

        // A rail on the right, centred down a 1040 work area.
        let (position, size) = geometry_in(&work, 1.0, Placement::centred(Dock::Right), false, PANEL_DEFAULT);
        assert_eq!(position.x, 1920 - size.width as i32);
        assert_eq!(position.y, (1040 - rail_h) / 2);

        // A bar along the bottom, sitting on the work area's floor, which is
        // above the taskbar rather than under it.
        let (position, size) = geometry_in(&work, 1.0, Placement::centred(Dock::Bottom), false, PANEL_DEFAULT);
        assert_eq!(position.x, (1920 - bar_w) / 2);
        assert_eq!(position.y + size.height as i32, 1040);

        // Top and left are the same sum without the subtraction.
        let (position, _) = geometry_in(&work, 1.0, Placement::centred(Dock::Top), false, PANEL_DEFAULT);
        assert_eq!((position.x, position.y), ((1920 - bar_w) / 2, 0));
        let (position, _) = geometry_in(&work, 1.0, Placement::centred(Dock::Left), false, PANEL_DEFAULT);
        assert_eq!((position.x, position.y), (0, (1040 - rail_h) / 2));
    }

    #[test]
    fn a_taskbar_moves_the_widget_rather_than_being_covered_by_it() {
        // Work area inset on every side: something docked left and something
        // docked at the top. Every edge follows the work area, not the screen.
        let work = area(60, 30, 1800, 1000);
        for dock in EDGES {
            for expanded in [false, true] {
                let placed = geometry_in(&work, 1.0, Placement::centred(dock), expanded, PANEL_DEFAULT);
                assert_eq!(docked_edge(dock, placed), work_edge(dock, &work), "{dock}");
                assert_on_screen(&work, placed, "inset work area");
            }
        }
    }

    #[test]
    fn the_widget_never_lands_off_screen_on_any_edge() {
        let areas = [
            desktop(),
            // A secondary monitor left of and above the primary: negative
            // origin on both axes.
            area(-1920, -300, 1920, 1080),
            // A monitor turned on its side.
            area(0, 0, 1080, 1920),
            // Narrower than the collapsed bar and shorter than the rail.
            // Nonsense, but a projector at 640x480 with a scale factor is not.
            area(0, 0, 200, 120),
            // Absurd, and still not allowed to produce an invisible window.
            area(0, 0, 1, 1),
        ];

        for work in areas {
            for dock in EDGES {
                for expanded in [false, true] {
                    for scale in [1.0, 1.5, 2.0, 3.0] {
                        let placed = geometry_in(&work, scale, Placement::centred(dock), expanded, PANEL_DEFAULT);
                        assert!(placed.1.width >= 1 && placed.1.height >= 1);
                        assert_on_screen(
                            &work,
                            placed,
                            &format!("{dock} expanded={expanded} at {scale}x"),
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn a_measured_panel_still_unfolds_out_of_its_own_edge() {
        // set_panel_size can make the panel taller than the collapsed bar is
        // wide, or wider than the rail. Neither may drag the dock off its edge.
        let work = desktop();
        for panel in [PANEL_MIN, (560.0, 700.0), PANEL_DEFAULT] {
            for dock in EDGES {
                let placed = geometry_in(&work, 1.0, Placement::centred(dock), true, panel);
                assert_eq!(docked_edge(dock, placed), work_edge(dock, &work), "{dock}");
                assert_on_screen(&work, placed, "measured panel");
            }
        }
    }

    #[test]
    fn every_frame_of_the_unfold_stays_glued_and_on_screen() {
        // The animation interpolates position and size independently and
        // applies them in two separate calls. Both the interpolated frame and
        // the half-applied state between those two calls have to behave, on
        // every edge and in both directions.
        let work = desktop();

        for dock in EDGES {
            let edge = work_edge(dock, &work);

            for expanded in [true, false] {
                let shut = geometry_in(&work, 1.0, Placement::centred(dock), false, PANEL_DEFAULT);
                let open = geometry_in(&work, 1.0, Placement::centred(dock), true, PANEL_DEFAULT);
                let (from, to) = if expanded { (shut, open) } else { (open, shut) };

                let mut applied = from;

                for step in 1..=STEPS {
                    let t = ease_out(f64::from(step) / f64::from(STEPS));
                    let position = PhysicalPosition::new(
                        lerp_i32(from.0.x, to.0.x, t),
                        lerp_i32(from.0.y, to.0.y, t),
                    );
                    let size = PhysicalSize::new(
                        lerp_u32(from.1.width, to.1.width, t),
                        lerp_u32(from.1.height, to.1.height, t),
                    );

                    // The half-applied state, in the order set_expanded uses.
                    let between = if move_before_resize(expanded) {
                        (position, applied.1)
                    } else {
                        (applied.0, size)
                    };
                    assert_on_screen(
                        &work,
                        between,
                        &format!("{dock} mid-frame {step} expanded={expanded}"),
                    );

                    applied = (position, size);
                    assert_on_screen(
                        &work,
                        applied,
                        &format!("{dock} frame {step} expanded={expanded}"),
                    );
                    assert!(
                        (docked_edge(dock, applied) - edge).abs() <= 1,
                        "{dock} frame {step} slid {}px off its edge",
                        docked_edge(dock, applied) - edge
                    );
                }

                // And it lands exactly, not near enough.
                assert_eq!(applied.0.x, to.0.x, "{dock}");
                assert_eq!(applied.0.y, to.0.y, "{dock}");
                assert_eq!(applied.1.width, to.1.width, "{dock}");
                assert_eq!(applied.1.height, to.1.height, "{dock}");
                assert_eq!(docked_edge(dock, applied), edge, "{dock}");
            }
        }
    }

    #[test]
    fn growing_moves_first_and_shrinking_resizes_first() {
        // Enlarging a window that is already against its edge is the only way
        // to push it over that edge, so it must never happen in place.
        assert!(move_before_resize(true));
        assert!(!move_before_resize(false));
    }

    /* ------------------------------------------------------- dragging -- */

    #[test]
    fn an_offset_puts_the_widget_where_it_was_dropped_along_the_edge() {
        let work = desktop();

        // A rail 300 logical pixels down the left edge stays glued to x=0.
        let placement = Placement { dock: Dock::Left, offset: Some(300.0) };
        let (position, size) = geometry_in(&work, 1.0, placement, false, PANEL_DEFAULT);
        assert_eq!((position.x, position.y), (0, 300));
        assert_eq!(size.width, RAIL.0 as u32);

        // A bar 700 along the top edge stays glued to y=0.
        let placement = Placement { dock: Dock::Top, offset: Some(700.0) };
        let (position, size) = geometry_in(&work, 1.0, placement, false, PANEL_DEFAULT);
        assert_eq!((position.x, position.y), (700, 0));
        assert_eq!(size.width, BAR.0 as u32);

        // The offset is logical, so the same drop is the same place at 2x.
        let placement = Placement { dock: Dock::Left, offset: Some(300.0) };
        let (position, _) = geometry_in(&work, 2.0, placement, false, PANEL_DEFAULT);
        assert_eq!(position.y, 600);
    }

    #[test]
    fn no_offset_is_still_centred() {
        // The config default has to keep behaving exactly as it did before any
        // of this existed.
        let work = desktop();
        for dock in EDGES {
            let placed = geometry_in(&work, 1.0, Placement::centred(dock), false, PANEL_DEFAULT);
            let sized = geometry_in(&work, 1.0, Placement::centred(dock), false, PANEL_DEFAULT).1;
            let expected = match dock {
                Dock::Left | Dock::Right => (1040 - sized.height as i32) / 2,
                Dock::Top | Dock::Bottom => (1920 - sized.width as i32) / 2,
            };
            let actual = match dock {
                Dock::Left | Dock::Right => placed.0.y,
                Dock::Top | Dock::Bottom => placed.0.x,
            };
            assert_eq!(actual, expected, "{dock} should still be centred");
        }
    }

    #[test]
    fn a_remembered_offset_can_never_put_the_widget_off_the_screen() {
        // Every one of these is a real way a saved offset goes stale: a taller
        // screen last time, a monitor rotated, a scale factor change, or a
        // file someone edited by hand.
        let areas = [desktop(), area(0, 0, 1080, 1920), area(-1920, -300, 1600, 900)];
        let offsets = [0.0, 900.0, 4000.0, 1.0e9, f64::MAX];

        for work in areas {
            for dock in EDGES {
                for offset in offsets {
                    for scale in [1.0, 1.5, 2.0] {
                        for expanded in [false, true] {
                            let placement = Placement { dock, offset: Some(offset) };
                            let placed =
                                geometry_in(&work, scale, placement, expanded, PANEL_DEFAULT);
                            assert_on_screen(
                                &work,
                                placed,
                                &format!("{dock} offset {offset} at {scale}x"),
                            );
                            // And it is still glued to the edge it chose.
                            assert_eq!(
                                docked_edge(dock, placed),
                                work_edge(dock, &work),
                                "{dock} offset {offset} came unglued"
                            );
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn a_nonsense_offset_does_not_panic_or_wrap() {
        let work = desktop();
        for offset in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -1.0, -1.0e9] {
            let placement = Placement { dock: Dock::Left, offset: Some(offset) };
            let placed = geometry_in(&work, 1.0, placement, false, PANEL_DEFAULT);
            assert_on_screen(&work, placed, &format!("offset {offset}"));
        }
        assert_eq!(round_i32(f64::NAN), 0);
        assert_eq!(round_i32(2.6), 3);
        assert_eq!(round_i32(-2.6), -3);
        assert!(round_i32(f64::MAX) > 0, "saturates rather than wrapping negative");
        assert!(round_i32(f64::MIN) < 0);
    }

    #[test]
    fn a_drop_snaps_to_an_edge_and_takes_that_edge_s_shape() {
        // The whole round trip, with the window manager taken out of it: a
        // drop point picks an edge, the edge picks the collapsed size, and the
        // placement lands glued to that edge.
        let work = desktop();

        for (drop, edge, shape) in [
            (PhysicalPosition::new(30, 700), Dock::Left, RAIL),
            (PhysicalPosition::new(1890, 700), Dock::Right, RAIL),
            (PhysicalPosition::new(1000, 30), Dock::Top, BAR),
            (PhysicalPosition::new(1000, 1010), Dock::Bottom, BAR),
        ] {
            let dock = nearest_edge(drop, &work);
            assert_eq!(dock, edge, "dropped at {},{}", drop.x, drop.y);

            let placement = Placement { dock, offset: Some(200.0) };
            let (position, size) = geometry_in(&work, 1.0, placement, false, PANEL_DEFAULT);
            assert_eq!(
                (size.width, size.height),
                (shape.0 as u32, shape.1 as u32),
                "{dock} should collapse to its own shape"
            );
            assert_eq!(docked_edge(dock, (position, size)), work_edge(dock, &work));
            assert_on_screen(&work, (position, size), "after a drop");
        }
    }

    #[test]
    fn a_drop_keeps_its_place_along_the_new_edge() {
        // Drag the rail from the right edge to the top one: it becomes a bar,
        // and it stays roughly where it was dropped horizontally rather than
        // jumping back to the middle.
        let work = desktop();
        let dropped_at = PhysicalPosition::new(1200, 60);

        let dock = nearest_edge(dropped_at, &work);
        assert_eq!(dock, Dock::Top);

        let offset = offset_along(dock, &work, dropped_at, 1.0);
        assert_eq!(offset, 1200.0);

        let placement = Placement { dock, offset: Some(offset) };
        let (position, _) = geometry_in(&work, 1.0, placement, false, PANEL_DEFAULT);
        assert_eq!(position.x, 1200);
        assert_eq!(position.y, 0, "the new edge still owns the other axis");
    }

    #[test]
    fn a_drop_near_the_end_of_an_edge_slides_back_into_the_work_area() {
        // Let go with the widget hanging off the bottom right. The offset is
        // honest about where it was dropped; the placement is honest about
        // where a 190px rail can actually sit on a 1040px edge.
        let work = desktop();
        let dropped_at = PhysicalPosition::new(1900, 1000);

        let dock = nearest_edge(dropped_at, &work);
        assert_eq!(dock, Dock::Right);

        let offset = offset_along(dock, &work, dropped_at, 1.0);
        let placement = Placement { dock, offset: Some(offset) };
        let placed = geometry_in(&work, 1.0, placement, false, PANEL_DEFAULT);

        assert_eq!(placed.0.y, 1040 - RAIL.1 as i32);
        assert_on_screen(&work, placed, "dropped past the end of the edge");
    }
}
