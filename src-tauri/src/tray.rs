//! The notification-area icon and its menu.
//!
//! Left click toggles the popover; right click opens the menu. The menu is
//! flat and has no submenus, because a widget's tray menu is not a place to
//! put a preferences dialog - the config file is.
//!
//! It is no longer a fixed list, though. Between the actions and the quit item
//! sits one checkable entry per provider the sidecar actually reported, and
//! the tick decides whether the widget DRAWS that provider. That is
//! presentation only - see the note at the top of visibility.rs for why it is
//! deliberately not the same thing as `providers.<id>.enabled` in the config
//! file. The entries are rebuilt whenever the detected set changes, which is
//! why the menu is built by a function that can be called again rather than
//! once at startup.

use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Wry};
use tauri_plugin_opener::OpenerExt;

use crate::state::AppState;
use crate::{log, popover, strip, visibility};

const ID_TOGGLE: &str = "toggle";
const ID_REFRESH: &str = "refresh";
const ID_CONFIG: &str = "config";
const ID_QUIT: &str = "quit";
/// Prefix on the id of every per-provider check item, so that a provider
/// called "quit" could never be mistaken for the Quit item.
const ID_PROVIDER: &str = "provider:";
/// Stands in for the provider list until the first read comes back on a
/// machine that has never run the widget before. A hole in the menu would look
/// like a bug; this says what is actually happening.
const ID_PENDING: &str = "providers-pending";

/// The tray icon's id, which is also how it is found again to swap its menu.
const TRAY_ID: &str = "quota-monitor";

pub fn create(app: &AppHandle) -> Result<TrayIcon, String> {
    let menu = build_menu(app)?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("quota-monitor")
        .menu(&menu)
        // Left click belongs to the popover; the menu is the right-click job.
        .show_menu_on_left_click(false)
        .on_menu_event(on_menu_event)
        .on_tray_icon_event(|tray, event| on_icon_event(tray.app_handle(), event));

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    } else {
        log::line("no default window icon was compiled in; the tray icon will be blank");
    }

    builder
        .build(app)
        .map_err(|error| format!("could not create the tray icon: {error}"))
}

/// The whole menu, actions and providers together.
///
/// Rebuilt rather than mutated, so what is on screen is always a direct
/// rendering of the saved state - there is no second copy of "which ones are
/// ticked" that could drift away from the file.
fn build_menu(app: &AppHandle) -> Result<Menu<Wry>, String> {
    let item = |id: &str, label: &str, enabled: bool| {
        MenuItem::with_id(app, id, label, enabled, None::<&str>)
            .map_err(|error| format!("could not build the tray menu item {id}: {error}"))
    };
    let separator = || {
        PredefinedMenuItem::separator(app)
            .map_err(|error| format!("could not build the tray menu separator: {error}"))
    };

    let toggle = item(ID_TOGGLE, "Show / Hide", true)?;
    let refresh = item(ID_REFRESH, "Refresh", true)?;
    let config = item(ID_CONFIG, "Open config folder", true)?;
    let quit = item(ID_QUIT, "Quit", true)?;
    let above = separator()?;
    let below = separator()?;
    let before_quit = separator()?;

    // The list is whatever the last read reported, never a hardcoded set: a
    // community adapter the shell has never heard of gets an item like any
    // other, labelled by visibility::label_for.
    let entries = visibility::entries_now(app);
    let mut providers: Vec<CheckMenuItem<Wry>> = Vec::with_capacity(entries.len());
    for entry in &entries {
        providers.push(
            CheckMenuItem::with_id(
                app,
                format!("{ID_PROVIDER}{}", entry.id),
                &entry.label,
                true,
                entry.visible,
                None::<&str>,
            )
            .map_err(|error| {
                format!("could not build the tray menu item for {}: {error}", entry.id)
            })?,
        );
    }

    // Nothing read yet, and nothing remembered from a previous run either.
    let pending = if providers.is_empty() {
        Some(item(ID_PENDING, "Providers appear after the first read", false)?)
    } else {
        None
    };

    // Borrows, so every item above has to outlive this slice.
    let mut items: Vec<&dyn IsMenuItem<Wry>> = vec![&toggle, &refresh, &above];
    match &pending {
        Some(pending) => items.push(pending),
        None => items.extend(providers.iter().map(|p| p as &dyn IsMenuItem<Wry>)),
    }
    items.extend([&below as &dyn IsMenuItem<Wry>, &config, &before_quit, &quit]);

    Menu::with_items(app, &items).map_err(|error| format!("could not build the tray menu: {error}"))
}

/// Swap in a freshly built menu.
///
/// Called when the detected providers change and after every tick, so the
/// checkmarks are exactly what the saved state says rather than whatever the
/// platform drew. Menus are main-thread objects on Windows and this is
/// reachable from the read, which runs on a worker, so the work is posted
/// rather than done wherever the caller happens to be.
pub fn rebuild_menu(app: &AppHandle) {
    let handle = app.clone();
    let posted = app.run_on_main_thread(move || {
        // No tray icon in this mode: there is no menu to rebuild, and that is
        // not a failure.
        let Some(tray) = handle.tray_by_id(TRAY_ID) else { return };

        match build_menu(&handle) {
            Ok(menu) => {
                if let Err(error) = tray.set_menu(Some(menu)) {
                    log::line(&format!(
                        "could not replace the tray menu ({error}); it still lists what it did before"
                    ));
                }
            }
            Err(error) => log::line(&format!(
                "could not rebuild the tray menu ({error}); it still lists what it did before"
            )),
        }
    });
    if let Err(error) = posted {
        log::line(&format!(
            "could not reach the main thread to rebuild the tray menu ({error}); it still lists what it did before"
        ));
    }
}

fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    match event.id.as_ref() {
        ID_TOGGLE => report("toggle the popover", popover::toggle(app)),
        ID_REFRESH => refresh(app),
        ID_CONFIG => open_config_folder(app),
        ID_QUIT => {
            log::line("quitting at the user's request");
            app.exit(0);
        }
        other => match other.strip_prefix(ID_PROVIDER) {
            // The one dynamic item in the menu: show or hide this provider.
            Some(id) => visibility::toggle(app, id),
            None => log::line(&format!("ignored an unknown tray menu id: {other}")),
        },
    }
}

fn on_icon_event(app: &AppHandle, event: TrayIconEvent) {
    // Every event carries the icon's position; remembering it means the menu's
    // Show / Hide can open the popover in the same place a click would.
    match event {
        TrayIconEvent::Click { position, button, button_state, .. } => {
            popover::remember_anchor(app, position);
            if button == MouseButton::Left && button_state == MouseButtonState::Up {
                report("toggle the popover", popover::toggle(app));
            }
        }
        TrayIconEvent::DoubleClick { position, .. }
        | TrayIconEvent::Enter { position, .. }
        | TrayIconEvent::Move { position, .. }
        | TrayIconEvent::Leave { position, .. } => popover::remember_anchor(app, position),
        _ => {}
    }
}

/// Emitted to both windows by Refresh. The page answers it by running the same
/// `load()` its own 60-second timer runs.
pub const REFRESH_EVENT: &str = "quota-refresh";

/// Ask every open window to read again.
///
/// The frontend polls on its own timer and owns the fetch, so "refresh" is
/// asking it to run that fetch now.
///
/// It used to be `window.location.reload()`, and that was wrong in a way that
/// stayed invisible until the widget happened to be open: a reload throws away
/// everything the page holds - expanded, pinned, and which collapsed layout it
/// is drawing - while this side goes on believing the strip is still the size
/// it grew to. What the user saw was a 320x288 window with the 72px rail
/// rattling around inside it. Nothing in the shell may reload a document. See
/// `widget_state` in main.rs for the other half of that fix, which is what
/// makes a reload we did not ask for survivable.
///
/// Emitted to both windows because either may be open - and the popover is a
/// window that exists even while it is hidden.
fn refresh(app: &AppHandle) {
    let mut asked = 0;
    for label in [strip::LABEL, popover::LABEL] {
        if app.get_webview_window(label).is_none() {
            continue;
        }
        match app.emit_to(label, REFRESH_EVENT, ()) {
            Ok(()) => asked += 1,
            Err(error) => log::line(&format!("could not refresh the {label} window: {error}")),
        }
    }
    if asked == 0 {
        log::line("refresh did nothing: no window is open");
    }
}

/// Open the directory holding the config file the CLI reads.
///
/// Creating it when it is missing is the one write this whole application
/// makes, and it is to quota-monitor's own directory, on an explicit request.
/// Nothing here ever touches another tool's files.
fn open_config_folder(app: &AppHandle) {
    let config = app.state::<AppState>().config_path.clone();
    let folder = config.parent().map(std::path::Path::to_path_buf).unwrap_or(config);

    if !folder.is_dir() {
        if let Err(error) = std::fs::create_dir_all(&folder) {
            log::line(&format!(
                "could not create the config folder {}: {error}",
                folder.display()
            ));
            return;
        }
        log::line(&format!("created the config folder {}", folder.display()));
    }

    if let Err(error) = app.opener().open_path(folder.to_string_lossy().to_string(), None::<&str>) {
        log::line(&format!(
            "could not open the config folder {}: {error}",
            folder.display()
        ));
    }
}

/// Tray actions have no caller to return an error to, so failures go to the
/// log rather than nowhere.
fn report(what: &str, outcome: Result<(), String>) {
    if let Err(error) = outcome {
        log::line(&format!("could not {what}: {error}"));
    }
}
