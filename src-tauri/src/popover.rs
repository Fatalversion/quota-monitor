//! The tray popover: the same page as the strip, forced into panel mode.
//!
//! `index.html?mode=panel` tells the frontend to render the expanded readout
//! and to skip the hover-collapse logic entirely, which is exactly right for a
//! window the user opened deliberately. It never calls `set_expanded`, so this
//! window is a fixed size and this module only ever moves it.
//!
//! Dismissal is the fiddly part. A popover that will not go away is worse than
//! no popover, so there are two independent ways out:
//!
//!   - clicking anywhere else, caught as a focus-lost window event
//!   - Escape, caught by a tiny initialization script, because the frontend is
//!     shared with the strip and is not allowed to grow tray-specific code
//!
//! Both funnel into `hide`, and so does the tray menu.

use std::time::{Duration, Instant};

use tauri::{
    AppHandle, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

use crate::log;
use crate::state::AppState;

pub const LABEL: &str = "popover";

/// Logical size. Slightly taller than the hover panel because it has room to
/// be: it is not covering anything the user is working in.
const SIZE: (f64, f64) = (320.0, 260.0);
/// Logical gap between the popover and the tray icon or screen edge.
const GAP: f64 = 12.0;

/// How long after a focus-loss dismissal a tray click still counts as the
/// click that dismissed it. Long enough to cover the gap between Windows
/// moving focus to the taskbar and delivering the click, short enough that a
/// deliberate second click is never swallowed.
const DISMISS_GRACE: Duration = Duration::from_millis(400);

/// Escape closes the popover.
///
/// This runs in the webview before the document loads, and is the only piece
/// of JavaScript the Rust side contributes. It deliberately does not touch the
/// page: it adds one listener and calls one command. `window.__TAURI__` is
/// looked up at event time rather than at install time, because the global API
/// may not have been injected yet when this runs.
const ESCAPE_SCRIPT: &str = r#"
document.addEventListener('keydown', function (event) {
  if (event.key !== 'Escape') return;
  var tauri = window.__TAURI__;
  if (tauri && tauri.core) tauri.core.invoke('hide_popover').catch(function () {});
});
"#;

/// Build the popover, hidden. Nothing shows it until the user asks.
pub fn create(app: &AppHandle) -> Result<WebviewWindow, String> {
    let window = WebviewWindowBuilder::new(
        app,
        LABEL,
        // The query string is the contract with index.html: panel mode, no
        // hover collapse.
        WebviewUrl::App("index.html?mode=panel".into()),
    )
    .title("quota-monitor")
    .inner_size(SIZE.0, SIZE.1)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .shadow(false)
    .visible(false)
    .focused(false)
    .initialization_script(ESCAPE_SCRIPT)
    .build()
    .map_err(|error| format!("could not create the tray popover: {error}"))?;

    let handle = app.clone();
    window.on_window_event(move |event| match event {
        // Clicking away dismisses it. Looking the window up by label rather
        // than capturing it keeps the handler from holding its own window
        // alive forever.
        WindowEvent::Focused(false) => {
            note_dismissal(&handle);
            if let Err(error) = hide(&handle) {
                log::line(&format!("could not hide the popover on focus loss: {error}"));
            }
        }
        // There is no close button, but Alt+F4 and the window menu still
        // exist. Hide instead of destroying: the tray icon has to be able to
        // bring it back.
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            if let Err(error) = hide(&handle) {
                log::line(&format!("could not hide the popover on close: {error}"));
            }
        }
        _ => {}
    });

    Ok(window)
}

pub fn toggle(app: &AppHandle) -> Result<(), String> {
    let window = window(app)?;
    if window.is_visible().unwrap_or(false) {
        return hide(app);
    }
    // Already hidden - but if it hid itself a moment ago because this very
    // click stole its focus, then this click is the one that closed it and
    // re-opening now would make the tray icon feel broken.
    if take_recent_dismissal(app) {
        return Ok(());
    }
    show(app)
}

pub fn show(app: &AppHandle) -> Result<(), String> {
    let window = window(app)?;
    place(app, &window)?;
    window
        .show()
        .map_err(|error| format!("could not show the popover: {error}"))?;
    // Focus is wanted here, unlike the strip: the user asked for this window,
    // and it needs the keyboard to hear Escape and the focus to notice a click
    // somewhere else.
    window
        .set_focus()
        .map_err(|error| format!("could not focus the popover: {error}"))
}

pub fn hide(app: &AppHandle) -> Result<(), String> {
    let window = window(app)?;
    window
        .hide()
        .map_err(|error| format!("could not hide the popover: {error}"))
}

/// Record that the popover just hid itself on losing focus.
fn note_dismissal(app: &AppHandle) {
    let state: &AppState = app.state::<AppState>().inner();
    if let Ok(mut at) = state.popover_dismissed_at.lock() {
        *at = Some(Instant::now());
    }
}

/// Consume a recent focus-loss dismissal. True when there was one, in which
/// case the caller should leave the popover hidden.
fn take_recent_dismissal(app: &AppHandle) -> bool {
    let state: &AppState = app.state::<AppState>().inner();
    let Ok(mut at) = state.popover_dismissed_at.lock() else {
        return false;
    };
    match at.take() {
        Some(when) => when.elapsed() < DISMISS_GRACE,
        None => false,
    }
}

/// Remember where the tray icon is, so the menu can open the popover in the
/// same place a click on the icon would have.
pub fn remember_anchor(app: &AppHandle, position: PhysicalPosition<f64>) {
    // `inner()` rather than holding the `State` guard in a local: the lock
    // guard would otherwise outlive the borrow it came from.
    let state: &AppState = app.state::<AppState>().inner();
    if let Ok(mut anchor) = state.tray_anchor.lock() {
        *anchor = Some(position);
    }
}

fn window(app: &AppHandle) -> Result<WebviewWindow, String> {
    app.get_webview_window(LABEL).ok_or_else(|| {
        "the tray popover is not running - widget.mode is not tray or both".to_string()
    })
}

/// Put the popover next to the tray icon, fully on screen.
fn place(app: &AppHandle, window: &WebviewWindow) -> Result<(), String> {
    let anchor = app
        .state::<AppState>()
        .tray_anchor
        .lock()
        .ok()
        .and_then(|guard| *guard);

    let monitor = monitor_for(app, anchor)?;
    let scale = monitor.scale_factor();
    let area = monitor.work_area();

    let width = (SIZE.0 * scale).round() as i32;
    let height = (SIZE.1 * scale).round() as i32;
    let gap = (GAP * scale).round() as i32;

    let (x, y) = match anchor {
        // Centred over the icon and above it. On a bottom taskbar - the common
        // case - that is where a notification-area window belongs; on any
        // other edge the clamp below drags it back into view.
        Some(anchor) => (anchor.x.round() as i32 - width / 2, anchor.y.round() as i32 - height - gap),
        // No idea where the tray is: the bottom-right corner is the safest
        // guess on every desktop this runs on.
        None => (
            area.position.x + area.size.width as i32 - width - gap,
            area.position.y + area.size.height as i32 - height - gap,
        ),
    };

    let position = PhysicalPosition::new(
        clamp(x, area.position.x + gap, area.position.x + area.size.width as i32 - width - gap),
        clamp(y, area.position.y + gap, area.position.y + area.size.height as i32 - height - gap),
    );

    // Re-assert the size as well: the popover may have been created on a
    // monitor with a different scale factor than the one it is opening on.
    window
        .set_size(PhysicalSize::new(width.max(1) as u32, height.max(1) as u32))
        .map_err(|error| format!("could not size the popover: {error}"))?;
    window
        .set_position(position)
        .map_err(|error| format!("could not move the popover: {error}"))
}

/// The monitor the tray is on, falling back to the primary one.
fn monitor_for(app: &AppHandle, anchor: Option<PhysicalPosition<f64>>) -> Result<Monitor, String> {
    if let Some(anchor) = anchor {
        if let Ok(Some(monitor)) = app.monitor_from_point(anchor.x, anchor.y) {
            return Ok(monitor);
        }
    }
    match app.primary_monitor() {
        Ok(Some(monitor)) => Ok(monitor),
        Ok(None) => Err("no primary monitor was reported by the system".to_string()),
        Err(error) => Err(format!("could not query the primary monitor: {error}")),
    }
}

/// `i32::clamp` panics when the window is larger than the work area and the
/// bounds cross. Prefer being pinned to the top-left over dying.
fn clamp(value: i32, min: i32, max: i32) -> i32 {
    if max <= min {
        min
    } else {
        value.clamp(min, max)
    }
}

#[cfg(test)]
mod tests {
    use super::clamp;

    #[test]
    fn clamps_into_range() {
        assert_eq!(clamp(50, 0, 100), 50);
        assert_eq!(clamp(-5, 0, 100), 0);
        assert_eq!(clamp(500, 0, 100), 100);
    }

    #[test]
    fn survives_a_window_bigger_than_the_screen() {
        assert_eq!(clamp(40, 12, -80), 12);
    }
}
