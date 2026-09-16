// A release build must not open a console window behind the widget. In debug
// it keeps one, which is where the log below also goes.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! quota-monitor's desktop shell.
//!
//! The whole application is: run the `quota` CLI, hand its JSON to a webview,
//! and put that webview somewhere useful. There is no provider logic here, no
//! parsing of anyone's transcripts, and no network code of any kind - all of
//! that already exists and is tested in the TypeScript core.
//!
//! What this crate owns is the two ways the readout can live on screen:
//!
//!   - `strip`   a small dock glued to a screen edge that unfolds on hover
//!   - `popover` a tray-anchored panel that opens on demand
//!
//! Both load the same `ui/index.html`, which also runs in a plain browser
//! against `ui/fixture.json`, so the frontend can be worked on without any of
//! this. Which of the two run is `widget.mode` in the user's config file.

mod config;
mod log;
mod placement;
mod popover;
mod sidecar;
mod state;
mod strip;
mod theme;
mod tray;
mod visibility;

use std::sync::atomic::Ordering;

use tauri::{AppHandle, Manager, RunEvent, WebviewWindow};

use crate::state::AppState;
// The frontend-facing theme command. It lives in theme.rs next to the decoding
// and contrast work it depends on, and is named here only so the handler table
// below stays the single place to read what the frontend may call.
use crate::theme::system_theme;

/// Read every enabled provider and return the CLI's JSON envelope verbatim.
///
/// Errors come back as a plain string, which is what index.html renders into
/// an `{ok: false}` row. The widget stays on screen and says what is wrong
/// rather than disappearing.
#[tauri::command]
async fn read_quota(app: AppHandle) -> Result<serde_json::Value, String> {
    let handle = app.clone();
    // Spawning a child and waiting up to 30 seconds for it has no business
    // running on the main thread.
    let payload = tauri::async_runtime::spawn_blocking(move || sidecar::read_quota(&handle))
        .await
        .map_err(|error| format!("the quota reader did not finish: {error}"))?;

    // The tray menu offers one entry per provider, and this is where the shell
    // finds out which providers there are. Deliberately from the data rather
    // than from a list compiled into the shell: adapters live in the
    // TypeScript core and a new one must not need a new build of this crate.
    if let Ok(value) = &payload {
        visibility::note_providers(&app, value);
    }
    payload
}

/// What the shell knows about this window, for a page that has just loaded.
///
/// The page is not allowed to assume anything about its own state after a
/// load. It can be a first load, or it can be a webview that crashed and came
/// back, or a reload nobody asked for - and in the last two the shell's window
/// is still whatever size and shape the page had grown it to. Guessing
/// "collapsed" is what produced the reported bug: a panel-sized window drawing
/// the rail inside it.
///
/// So the shell answers instead of the page guessing. It is the side that owns
/// the window, so it is the side that knows.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WidgetState {
    /// Provider ids the user has unticked in the tray menu. Presentation only:
    /// these are still read and still counted. See visibility.rs.
    hidden: Vec<String>,
    /// Which screen edge the strip is glued to, or `null` for the popover,
    /// which is not docked to anything. Worth answering even though the page
    /// gets it in its URL: the URL was written when the window was created,
    /// and dragging the widget to another edge does not rewrite it.
    dock: Option<String>,
    /// The collapsed shape that edge implies: "rail" or "bar".
    layout: Option<String>,
    /// Whether the strip window is currently grown to its panel.
    expanded: bool,
    /// Whether the user pinned it open.
    pinned: bool,
}

#[tauri::command]
fn widget_state(app: AppHandle, window: WebviewWindow) -> WidgetState {
    let state = app.state::<AppState>();
    let hidden = match state.visibility.lock() {
        Ok(visibility) => visibility.hidden(),
        Err(_) => {
            log::line("the provider visibility is poisoned; this window will draw every provider");
            Vec::new()
        }
    };

    // Only the strip has a dock, a collapsed shape or a hover state. The
    // popover is `?mode=panel`, opened deliberately at a fixed size, and
    // handing it the strip's geometry would be handing it someone else's.
    if window.label() != strip::LABEL {
        return WidgetState { hidden, dock: None, layout: None, expanded: false, pinned: false };
    }

    let dock = strip::current_dock(&app);
    WidgetState {
        hidden,
        dock: Some(dock.to_string()),
        layout: Some(dock.layout().to_string()),
        expanded: state.strip_expanded.load(Ordering::SeqCst),
        pinned: state.strip_pinned.load(Ordering::SeqCst),
    }
}

/// Grow the strip into its panel, or shrink it back to the sliver.
#[tauri::command]
fn set_expanded(app: AppHandle, expanded: bool) -> Result<(), String> {
    strip::set_expanded(&app, expanded)
}

/// Pin the strip open, or release it.
///
/// Hovering is a peek; a click is a commitment. Pinning keeps the panel up
/// while the user reads or selects, and is the one moment the strip is allowed
/// to take focus - which is also what lets a blur mean "clicked away". See the
/// note at the top of strip.rs.
#[tauri::command]
fn set_pinned(app: AppHandle, pinned: bool) -> Result<(), String> {
    strip::set_pinned(&app, pinned)
}

/// Resize the expanded strip to the content the page just measured.
///
/// `width` and `height` are CSS pixels straight out of `scrollWidth` and
/// `scrollHeight`; strip.rs refuses nonsense and clamps the rest.
#[tauri::command]
fn set_panel_size(
    app: AppHandle,
    window: WebviewWindow,
    width: f64,
    height: f64,
) -> Result<(), String> {
    // The popover runs the same page in panel mode and so reports its own
    // measurements too. It is a fixed-size window the user opened on purpose,
    // and letting it drive the strip's geometry would resize a window its
    // measurement says nothing about. Noted once rather than ignored quietly,
    // and once rather than on every poll.
    if window.label() != strip::LABEL {
        static NOTED: std::sync::Once = std::sync::Once::new();
        NOTED.call_once(|| {
            log::line(&format!(
                "ignoring set_panel_size from the {} window: only the strip is sized to fit",
                window.label()
            ));
        });
        return Ok(());
    }
    strip::set_panel_size(&app, width, height)
}

/// Move the widget while the pointer drags it.
///
/// `dx` and `dy` are the total CSS-pixel offset from where the press began,
/// and `gesture` is a counter the page bumps on every press. Both of those
/// choices are what make a dropped, duplicated or reordered frame harmless;
/// see the note on `strip::drag_move`.
#[tauri::command]
fn drag_move(app: AppHandle, gesture: u64, dx: f64, dy: f64) -> Result<(), String> {
    strip::drag_move(&app, gesture, dx, dy)
}

/// Finish a drag: apply the last frame, then snap to the nearest screen edge
/// of the monitor the widget was dropped on and remember where that was.
#[tauri::command]
fn drag_end(app: AppHandle, gesture: u64, dx: f64, dy: f64) -> Result<(), String> {
    strip::drag_end(&app, gesture, dx, dy)
}

/// Dismiss the tray popover. Called by the Escape handler in popover.rs.
#[tauri::command]
fn hide_popover(app: AppHandle) -> Result<(), String> {
    popover::hide(&app)
}

fn main() {
    let context = tauri::generate_context!();

    let app = tauri::Builder::default()
        // First plugin, deliberately: a second launch must be turned away
        // before it can build a rival tray icon.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            on_second_instance(app);
        }))
        // Used for exactly one thing: the tray's "Open config folder".
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            read_quota,
            set_expanded,
            set_pinned,
            set_panel_size,
            drag_move,
            drag_end,
            hide_popover,
            widget_state,
            system_theme
        ])
        .setup(setup)
        .build(context);

    match app {
        Ok(app) => app.run(on_run_event),
        Err(error) => {
            // No window exists yet, so there is nowhere to show this but the
            // console and the exit code.
            eprintln!("[quota-monitor] could not start: {error}");
            std::process::exit(1);
        }
    }
}

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();

    // Open the log before anything that might need to complain.
    let log_path = handle
        .path()
        .app_log_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("quota-monitor.log");
    log::open(&log_path);
    log::line(&format!(
        "quota-monitor shell {} starting",
        env!("CARGO_PKG_VERSION")
    ));

    let home = handle.path().home_dir().ok();
    let setting = config::load(home.as_deref());
    for note in &setting.notes {
        log::line(note);
    }
    log::line(&format!(
        "widget.mode: {}, widget.dock: {} ({} layout) (from {})",
        setting.mode,
        setting.dock,
        setting.dock.layout(),
        setting.path.display()
    ));

    // Two small files of our own in the app data directory: where the widget
    // was left, and which providers the user wants drawn. Deliberately NOT the
    // config file - that one is hand-written and commented, and rewriting it
    // to store window state would throw those comments away. A missing,
    // unreadable or stale file costs a log line and a default.
    let data_dir = match handle.path().app_data_dir() {
        Ok(dir) => Some(dir),
        Err(error) => {
            log::line(&format!(
                "no app data directory ({error}); where you drag the widget and which providers you hide will not be remembered"
            ));
            None
        }
    };
    let placement_path = data_dir.as_deref().map(placement::file_in);
    let restored = placement_path.as_deref().and_then(placement::load);

    // Read before any window exists, so the first paint already knows what to
    // leave out rather than drawing a row and snatching it back.
    let visibility_path = data_dir.as_deref().map(visibility::file_in);
    let visible = visibility_path.as_deref().map_or_else(
        visibility::Visibility::default,
        visibility::load,
    );
    let hidden = visible.hidden();
    if !hidden.is_empty() {
        log::line(&format!(
            "hidden in the widget (still read, still counted): {}",
            hidden.join(", ")
        ));
    }

    let mode = setting.mode;
    app.manage(AppState::new(
        mode,
        setting.dock,
        setting.path,
        restored,
        placement_path,
        visible,
        visibility_path,
    ));

    let mut running = Vec::new();

    if mode.wants_strip() {
        match strip::create(&handle) {
            Ok(_) => running.push("strip"),
            Err(error) => log::line(&format!("the strip did not start: {error}")),
        }
    }

    if mode.wants_tray() {
        // The popover first: the tray icon's very first click may arrive
        // before this function returns.
        match popover::create(&handle) {
            Ok(_) => match tray::create(&handle) {
                Ok(_) => {
                    handle.state::<AppState>().has_tray.store(true, Ordering::SeqCst);
                    running.push("tray");
                }
                Err(error) => log::line(&format!("the tray icon did not start: {error}")),
            },
            Err(error) => log::line(&format!("the tray popover did not start: {error}")),
        }
    }

    if running.is_empty() {
        // Refusing to sit in the background as an invisible process with no
        // way to reach it. The log says why, and the exit code says it failed.
        log::line("nothing could be shown, so there is nothing to run; see the errors above");
        return Err(format!(
            "no widget could be started in mode \"{mode}\"; see {}",
            log_path.display()
        )
        .into());
    }

    log::line(&format!("running: {}", running.join(" + ")));
    if !mode.wants_tray() {
        log::line("no tray icon in this mode: quit with Alt+F4 while the strip has the pointer");
    }

    Ok(())
}

/// Someone launched quota-monitor again. Surface what is already running
/// instead of starting a second copy.
fn on_second_instance(app: &AppHandle) {
    let mode = app.state::<AppState>().mode;
    log::line(&format!(
        "a second launch was folded into the running instance (mode: {mode})"
    ));

    if app.get_webview_window(popover::LABEL).is_some() {
        if let Err(error) = popover::show(app) {
            log::line(&format!("could not show the popover: {error}"));
        }
        return;
    }

    // Strip-only. Re-dock it: the likeliest reason someone launched again is
    // that they cannot see it, and a display change can leave it off screen.
    if let Err(error) = strip::redock(app) {
        log::line(&format!("could not re-dock the strip: {error}"));
    }
    if let Some(window) = app.get_webview_window(strip::LABEL) {
        if let Err(error) = window.show() {
            log::line(&format!("could not show the strip: {error}"));
        }
    }
}

fn on_run_event(app: &AppHandle, event: RunEvent) {
    if let RunEvent::ExitRequested { code, api, .. } = event {
        // `code: None` means the runtime noticed the last window close. With a
        // tray icon that is not a reason to quit - the icon is still there and
        // the popover is meant to be hidden most of the time. With no tray it
        // very much is, because closing the strip would otherwise leave a
        // process running that the user has no way to reach.
        if code.is_none() && app.state::<AppState>().has_tray.load(Ordering::SeqCst) {
            api.prevent_exit();
        }
    }
}
