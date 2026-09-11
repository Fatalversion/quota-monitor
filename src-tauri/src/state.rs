//! Process-wide state, managed by Tauri and reachable from any command.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::Mutex;
use std::time::Instant;

use tauri::PhysicalPosition;

use crate::config::{Dock, WidgetMode};
use crate::placement::{Placement, Stored};
use crate::visibility::Visibility;

pub struct AppState {
    /// strip, tray or both, as resolved at startup from widget.mode.
    pub mode: WidgetMode,
    /// The config file we read it from. Also what "Open config folder" opens.
    pub config_path: PathBuf,
    /// The edge `widget.dock` asked for.
    ///
    /// Fixed for the life of the process, and no longer the whole story: it is
    /// the starting point and the fallback, used when nothing has been saved
    /// and whenever a saved position has to be thrown away.
    pub config_dock: Dock,
    /// Where the widget actually is: an edge and how far along it.
    ///
    /// This one does change at runtime. Dragging the widget and letting go
    /// snaps it to the nearest edge, which can switch the collapsed layout
    /// between the rail and the bar, so nothing may cache the edge it read.
    pub placement: Mutex<Placement>,
    /// The position read from disk at startup, before any monitor existed to
    /// check it against, or `None` when there was nothing usable to read.
    ///
    /// Only the strip's first placement looks at this; it is what carries the
    /// anchor that says which monitor the widget was left on.
    pub restored: Option<Stored>,
    /// Where to write the position when the user drops the widget somewhere.
    /// `None` if the app data directory could not be resolved at all, which is
    /// logged once at startup and costs only the memory of the drop.
    pub placement_path: Option<PathBuf>,
    /// The drag gesture in progress, if any. See `strip::drag_move`.
    pub drag: Mutex<Option<Drag>>,
    /// Bumped by every `set_expanded`. An in-flight resize whose generation is
    /// no longer current stops on its next frame, so a fast hover in-out-in
    /// does not leave two animations fighting over the same window.
    pub strip_generation: AtomicU64,
    /// Serialises "check the generation, then move the window".
    ///
    /// The generation counter alone is not enough, because the check and the
    /// resize that follows it are two separate steps. A frame that read a
    /// still-current generation, was then superseded, and only afterwards
    /// called `set_size` would land ON TOP of whatever superseded it. Measured:
    /// a correcting re-place put the strip at 320x288, and one millisecond
    /// later a stale animation frame overwrote it with 154x226 and exited,
    /// leaving the widget clipped until the next 60-second poll.
    ///
    /// Holding this across both steps makes them atomic with respect to each
    /// other, so the last writer is always the newest one.
    pub placing: Mutex<()>,
    /// Last state asked for, so a re-place after a monitor change knows which
    /// geometry to restore.
    pub strip_expanded: AtomicBool,
    /// Whether the user pinned the panel open with a deliberate click.
    ///
    /// A pin is the one thing that lets the strip take focus, and while it is
    /// set a `set_expanded(false)` is ignored: a mouseleave from crossing the
    /// seam, or from simply moving the pointer away while reading, must not
    /// shrink a panel the user asked to stay open.
    pub strip_pinned: AtomicBool,
    /// Logical size of the expanded panel, in CSS pixels.
    ///
    /// Not a constant, because the shell cannot know how tall the readout is:
    /// the number of providers varies and an error row is taller than a good
    /// one. The frontend measures its own content after every paint and
    /// reports it through `set_panel_size`, which clamps it hard before it
    /// lands here.
    pub strip_panel_size: Mutex<(f64, f64)>,
    /// Where the tray icon was last seen. The tray menu's Show/Hide uses it to
    /// put the popover where a click on the icon would have put it.
    pub tray_anchor: Mutex<Option<PhysicalPosition<f64>>>,
    /// When the popover last hid itself because it lost focus.
    ///
    /// Clicking the tray icon while the popover is open takes focus away from
    /// it first, so by the time the click arrives the popover has already
    /// hidden and a naive toggle would immediately re-open it - the icon would
    /// never close anything. This timestamp lets the toggle tell "the user
    /// wants it open" from "the user just clicked it shut".
    pub popover_dismissed_at: Mutex<Option<Instant>>,
    /// Whether a tray icon exists. Without one there is no way back to a
    /// hidden app, so the shell must not keep itself alive after its last
    /// window closes.
    pub has_tray: AtomicBool,
    /// Which providers the widget DRAWS, and which ones it knows about.
    ///
    /// Presentation only. It is not `providers.<id>.enabled` from the config
    /// file, which stops an adapter reading at all - a provider hidden here is
    /// still read, still counted and still in the JSON. See visibility.rs.
    pub visibility: Mutex<Visibility>,
    /// Where to write that set. `None` if the app data directory could not be
    /// resolved, which is logged once at startup and costs only the memory of
    /// the choice.
    pub visibility_path: Option<PathBuf>,
}

/// One press-and-drag of the widget, from the moment it passed the slop
/// threshold to the moment the button came up.
///
/// The origin is captured once, when the gesture is first seen, and every
/// later frame is the press point plus a total offset - never the previous
/// frame plus a step. Accumulating steps would round to whole pixels once per
/// mouse move and drift the window away from the pointer over a long drag.
#[derive(Clone, Copy, Debug)]
pub struct Drag {
    /// Which gesture this is. The frontend increments it per press, so a
    /// gesture that never sent its last frame cannot poison the next one.
    pub gesture: u64,
    /// Where the window was when the gesture began, in physical pixels.
    pub origin: PhysicalPosition<i32>,
    /// When the last frame of it arrived.
    ///
    /// Anything that would move the window out from under the pointer asks
    /// "is a drag happening right now", and the honest answer has to expire.
    /// A page reloaded mid-drag never sends its release, and a flag with no
    /// timestamp would leave the widget refusing to re-place itself for the
    /// rest of the session over a gesture that ended minutes ago.
    pub last_frame: Instant,
}

impl AppState {
    pub fn new(
        mode: WidgetMode,
        config_dock: Dock,
        config_path: PathBuf,
        restored: Option<Stored>,
        placement_path: Option<PathBuf>,
        visibility: Visibility,
        visibility_path: Option<PathBuf>,
    ) -> Self {
        Self {
            mode,
            config_path,
            config_dock,
            placement: Mutex::new(
                restored.map_or(Placement::centred(config_dock), |stored| stored.placement),
            ),
            restored,
            placement_path,
            drag: Mutex::new(None),
            strip_generation: AtomicU64::new(0),
            placing: Mutex::new(()),
            strip_expanded: AtomicBool::new(false),
            strip_pinned: AtomicBool::new(false),
            strip_panel_size: Mutex::new(crate::strip::PANEL_DEFAULT),
            tray_anchor: Mutex::new(None),
            popover_dismissed_at: Mutex::new(None),
            has_tray: AtomicBool::new(false),
            visibility: Mutex::new(visibility),
            visibility_path,
        }
    }
}
