//! Where the widget sits on the desktop, and remembering it between runs.
//!
//! `widget.dock` in the config file says which edge the widget starts on. Once
//! the user drags it somewhere else that answer is stale, so this module owns
//! the runtime answer instead: a `Placement` is an edge plus how far along that
//! edge the widget's near corner sits.
//!
//! Two coordinate systems meet here, on purpose:
//!
//!   - the **anchor** is physical, in absolute desktop coordinates. It exists
//!     for exactly one question - which monitor was the widget on? - and that
//!     question is asked against monitor work areas, which the window manager
//!     reports in physical pixels.
//!   - the **offset** is logical. A monitor whose scale factor changed between
//!     runs (a laptop docked to a 4K screen) should put the widget back at the
//!     same apparent place, not at half or double the distance down the edge.
//!
//! Nothing here writes to the user's config file. That file is hand-written and
//! commented, and rewriting it to store a window position would destroy those
//! comments - so the position lives in its own small JSON file in the app data
//! directory, and a missing, unreadable, corrupt or stale one costs a log line
//! and falls back to `widget.dock`.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{PhysicalPosition, PhysicalRect};

use crate::config::Dock;
use crate::log;

/// File name under the app data directory. Deliberately not `config.yaml`:
/// this is state the app maintains, not settings the user writes.
pub const FILE: &str = "widget-position.json";

/// Bumped only if the shape below changes incompatibly. A file from the future
/// is treated exactly like a corrupt one - discarded, with a note.
const VERSION: u32 = 1;

/// An edge, and how far along it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Placement {
    pub dock: Dock,
    /// Logical pixels from the near end of the docked edge to the window's
    /// near corner along that edge. `None` centres it, which is what every
    /// build before dragging existed did and still the default.
    pub offset: Option<f64>,
}

impl Placement {
    /// The config default: glued to `dock`, centred on the free axis.
    pub const fn centred(dock: Dock) -> Self {
        Self { dock, offset: None }
    }
}

/// A placement plus the point that says which monitor it belongs to.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Stored {
    pub placement: Placement,
    /// The window's top-left corner when it was saved, in physical desktop
    /// coordinates. Always inside the work area it was docked to, because
    /// `geometry_in` clamps it there before it is ever written down.
    pub anchor: PhysicalPosition<i32>,
}

/// The on-disk shape. Separate from `Stored` so the file format and the
/// in-memory value can move independently, and so `Dock` needs no serde
/// derive: it is written as the same word the config file uses.
#[derive(Debug, Deserialize, Serialize)]
struct Document {
    version: u32,
    dock: String,
    offset: f64,
    anchor: Anchor,
}

#[derive(Debug, Deserialize, Serialize)]
struct Anchor {
    x: i32,
    y: i32,
}

/// Which edge of `area` the point is closest to.
///
/// Straight-line distance to each of the four edges, smallest wins. That is
/// not an arbitrary rule: comparing raw distances splits the rectangle along
/// its diagonals, so the screen becomes four triangles and a drop anywhere in
/// one of them snaps to that triangle's edge. It is what every window snapping
/// UI does, and it is what a user expects when they let go near a corner.
///
/// Ties go to the earliest edge in left, right, top, bottom order. A tie means
/// the drop was exactly on a diagonal, so any answer is as good as any other;
/// what matters is that the same drop always gives the same answer.
pub fn nearest_edge(point: PhysicalPosition<i32>, area: &PhysicalRect<i32, u32>) -> Dock {
    let left = i64::from(point.x) - i64::from(area.position.x);
    let top = i64::from(point.y) - i64::from(area.position.y);
    let right = i64::from(area.position.x) + i64::from(area.size.width) - i64::from(point.x);
    let bottom = i64::from(area.position.y) + i64::from(area.size.height) - i64::from(point.y);

    let mut best = (Dock::Left, left);
    for candidate in [(Dock::Right, right), (Dock::Top, top), (Dock::Bottom, bottom)] {
        if candidate.1 < best.1 {
            best = candidate;
        }
    }
    best.0
}

/// How far along the docked edge a window at `position` sits, in logical px.
///
/// The free axis is the one the dock does not pin: vertical for a left or
/// right edge, horizontal for a top or bottom one. Never negative - a window
/// above or left of its own work area is a bug elsewhere, and a negative
/// offset would only push it further out.
pub fn offset_along(
    dock: Dock,
    area: &PhysicalRect<i32, u32>,
    position: PhysicalPosition<i32>,
    scale: f64,
) -> f64 {
    let along = match dock {
        Dock::Left | Dock::Right => i64::from(position.y) - i64::from(area.position.y),
        Dock::Top | Dock::Bottom => i64::from(position.x) - i64::from(area.position.x),
    };
    let scale = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    (along as f64 / scale).max(0.0)
}

/// Which of these work areas contains the anchor, if any.
///
/// Half-open on the far edges, so two monitors that share a seam do not both
/// claim a point on it. `None` is the answer that matters: the monitor the
/// widget was left on is not attached any more, the saved position describes
/// nowhere, and the caller must re-dock rather than restore it.
pub fn monitor_index_for(
    areas: &[PhysicalRect<i32, u32>],
    anchor: PhysicalPosition<i32>,
) -> Option<usize> {
    areas.iter().position(|area| {
        let right = i64::from(area.position.x) + i64::from(area.size.width);
        let bottom = i64::from(area.position.y) + i64::from(area.size.height);
        i64::from(anchor.x) >= i64::from(area.position.x)
            && i64::from(anchor.y) >= i64::from(area.position.y)
            && i64::from(anchor.x) < right
            && i64::from(anchor.y) < bottom
    })
}

/// The file the position lives in, under the app data directory.
pub fn file_in(data_dir: &Path) -> PathBuf {
    data_dir.join(FILE)
}

/// Read a saved position, or explain in the log why we are ignoring one.
///
/// Every failure has the same shape and the same consequence: a line saying
/// what was wrong with the file, and `None` so the caller falls back to
/// `widget.dock`. Never an error the caller has to handle - a widget that
/// refuses to start because it cannot remember where it was would be worse
/// than one that starts in the default corner.
pub fn load(path: &Path) -> Option<Stored> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        // No file yet is the normal first run, and worth no note at all.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => {
            log::line(&format!(
                "could not read the saved widget position {} ({error}); using widget.dock",
                path.display()
            ));
            return None;
        }
    };

    match parse(&raw) {
        Ok(stored) => Some(stored),
        Err(reason) => {
            log::line(&format!(
                "ignoring the saved widget position in {} ({reason}); using widget.dock",
                path.display()
            ));
            None
        }
    }
}

/// Write the position down. Failure is logged and otherwise survivable: the
/// widget is already where the user put it, it just will not be there again
/// after a restart.
pub fn store(path: &Path, stored: Stored) {
    if let Some(parent) = path.parent() {
        if let Err(error) = std::fs::create_dir_all(parent) {
            log::line(&format!(
                "could not create {} for the widget position ({error}); this drop will not be remembered",
                parent.display()
            ));
            return;
        }
    }

    let encoded = match encode(stored) {
        Ok(encoded) => encoded,
        Err(reason) => {
            log::line(&format!("could not encode the widget position ({reason})"));
            return;
        }
    };

    if let Err(error) = std::fs::write(path, encoded) {
        log::line(&format!(
            "could not write {} ({error}); this drop will not be remembered",
            path.display()
        ));
    }
}

/// Decode one file's worth of JSON, refusing anything that is not a position.
///
/// Strict on purpose. A half-written file, a hand-edited one, or one from a
/// future version all come back as an error, and the caller's answer to an
/// error is the config default - which is always usable. Being lenient here
/// would mean restoring a position assembled out of guesses.
fn parse(raw: &str) -> Result<Stored, String> {
    // A leading byte order mark is not corruption, it is Notepad. This file is
    // not meant to be hand-edited, but someone who opens it to see what the
    // widget remembers should not have their position silently thrown away by
    // the act of saving it back. serde_json refuses a BOM outright.
    let raw = raw.trim_start_matches('\u{feff}');

    let document: Document =
        serde_json::from_str(raw).map_err(|error| format!("not valid JSON: {error}"))?;

    if document.version != VERSION {
        return Err(format!(
            "version {} is not {VERSION}",
            document.version
        ));
    }

    let dock = Dock::parse(&document.dock)
        .ok_or_else(|| format!("\"{}\" is not one of left, right, top, bottom", document.dock))?;

    // serde_json will not hand back a NaN or an infinity from a plain JSON
    // document, but it will hand back anything finite, and a negative offset
    // is not a position on an edge.
    if !document.offset.is_finite() || document.offset < 0.0 {
        return Err(format!("{} is not an offset along an edge", document.offset));
    }

    Ok(Stored {
        placement: Placement { dock, offset: Some(document.offset) },
        anchor: PhysicalPosition::new(document.anchor.x, document.anchor.y),
    })
}

fn encode(stored: Stored) -> Result<String, String> {
    let document = Document {
        version: VERSION,
        dock: stored.placement.dock.to_string(),
        // A centred placement has nothing to remember along the edge; writing
        // the anchor's own offset keeps the file well-formed either way.
        offset: stored.placement.offset.unwrap_or(0.0).max(0.0),
        anchor: Anchor { x: stored.anchor.x, y: stored.anchor.y },
    };
    serde_json::to_string_pretty(&document).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        encode, monitor_index_for, nearest_edge, offset_along, parse, Placement, Stored, VERSION,
    };
    use crate::config::{Dock, Layout};
    use tauri::{PhysicalPosition, PhysicalRect, PhysicalSize};

    fn area(x: i32, y: i32, width: u32, height: u32) -> PhysicalRect<i32, u32> {
        PhysicalRect {
            position: PhysicalPosition::new(x, y),
            size: PhysicalSize::new(width, height),
        }
    }

    fn at(x: i32, y: i32) -> PhysicalPosition<i32> {
        PhysicalPosition::new(x, y)
    }

    #[test]
    fn a_drop_snaps_to_the_edge_it_was_dropped_nearest() {
        let work = area(0, 0, 1920, 1040);

        // Hard against each side, and unambiguously so.
        assert_eq!(nearest_edge(at(20, 500), &work), Dock::Left);
        assert_eq!(nearest_edge(at(1900, 500), &work), Dock::Right);
        assert_eq!(nearest_edge(at(900, 12), &work), Dock::Top);
        assert_eq!(nearest_edge(at(900, 1030), &work), Dock::Bottom);

        // Near a corner the closer of the two edges wins, not whichever one
        // happens to be checked first: 100 from the left, 40 from the top.
        assert_eq!(nearest_edge(at(100, 40), &work), Dock::Top);
        assert_eq!(nearest_edge(at(40, 100), &work), Dock::Left);

        // Dead centre of a 16:9 screen really is nearer the top than the side,
        // and the diagonals are where the answer changes.
        assert_eq!(nearest_edge(at(960, 520), &work), Dock::Top);
    }

    #[test]
    fn a_drop_on_a_monitor_that_does_not_start_at_the_origin_still_snaps_locally() {
        // Second monitor, left of and above the primary. Absolute coordinates
        // are negative; the edges are still its own.
        let work = area(-1920, -300, 1920, 1080);
        assert_eq!(nearest_edge(at(-1910, 200), &work), Dock::Left);
        assert_eq!(nearest_edge(at(-10, 200), &work), Dock::Right);
        assert_eq!(nearest_edge(at(-900, -290), &work), Dock::Top);
        assert_eq!(nearest_edge(at(-900, 770), &work), Dock::Bottom);
    }

    #[test]
    fn a_tie_always_answers_the_same_way() {
        // Exactly the centre of a square: all four distances equal.
        let square = area(0, 0, 1000, 1000);
        assert_eq!(nearest_edge(at(500, 500), &square), Dock::Left);
        assert_eq!(nearest_edge(at(500, 500), &square), Dock::Left);
    }

    #[test]
    fn the_snapped_edge_decides_the_layout() {
        // The mapping the drop depends on: a side is a rail, a top or bottom
        // is a bar. Snapping picks the edge; the edge picks the shape.
        let work = area(0, 0, 1920, 1040);
        for (point, edge, layout) in [
            (at(4, 500), Dock::Left, Layout::Rail),
            (at(1916, 500), Dock::Right, Layout::Rail),
            (at(900, 4), Dock::Top, Layout::Bar),
            (at(900, 1036), Dock::Bottom, Layout::Bar),
        ] {
            let snapped = nearest_edge(point, &work);
            assert_eq!(snapped, edge);
            assert_eq!(snapped.layout(), layout);
        }
    }

    #[test]
    fn the_offset_is_measured_along_the_free_axis_only() {
        let work = area(0, 0, 1920, 1040);
        // A rail keeps its distance down the side.
        assert_eq!(offset_along(Dock::Left, &work, at(0, 300), 1.0), 300.0);
        assert_eq!(offset_along(Dock::Right, &work, at(1856, 300), 1.0), 300.0);
        // A bar keeps its distance across the top.
        assert_eq!(offset_along(Dock::Top, &work, at(700, 0), 1.0), 700.0);
        assert_eq!(offset_along(Dock::Bottom, &work, at(700, 996), 1.0), 700.0);
    }

    #[test]
    fn the_offset_is_stored_in_logical_pixels() {
        // 600 physical pixels down a 2x screen is 300 logical ones, which is
        // what the same apparent position on a 1x screen would be.
        let work = area(0, 0, 3840, 2080);
        assert_eq!(offset_along(Dock::Left, &work, at(0, 600), 2.0), 300.0);
        // A nonsense scale factor must not produce a nonsense offset.
        assert_eq!(offset_along(Dock::Left, &work, at(0, 600), 0.0), 600.0);
        assert_eq!(offset_along(Dock::Left, &work, at(0, 600), f64::NAN), 600.0);
    }

    #[test]
    fn the_offset_is_relative_to_the_work_area_not_the_desktop() {
        // Monitor two, and a taskbar. 340 down from the work area's own top.
        let work = area(1920, 40, 1920, 1000);
        assert_eq!(offset_along(Dock::Left, &work, at(1920, 380), 1.0), 340.0);
        // Above its own work area is not a negative offset, it is zero.
        assert_eq!(offset_along(Dock::Left, &work, at(1920, 0), 1.0), 0.0);
    }

    #[test]
    fn a_saved_position_finds_the_monitor_it_was_left_on() {
        let monitors = [area(0, 0, 1920, 1040), area(1920, 0, 2560, 1400)];
        assert_eq!(monitor_index_for(&monitors, at(10, 500)), Some(0));
        assert_eq!(monitor_index_for(&monitors, at(4400, 500)), Some(1));
        // The seam belongs to exactly one of them.
        assert_eq!(monitor_index_for(&monitors, at(1920, 500)), Some(1));
        assert_eq!(monitor_index_for(&monitors, at(1919, 500)), Some(0));
    }

    #[test]
    fn a_saved_position_off_every_monitor_is_rejected() {
        // The second screen was unplugged: everything the widget remembers
        // describes coordinates that no longer exist.
        let monitors = [area(0, 0, 1920, 1040)];
        assert_eq!(monitor_index_for(&monitors, at(2400, 500)), None);
        // Or the resolution shrank under it.
        assert_eq!(monitor_index_for(&monitors, at(500, 1900)), None);
        // Or the screen it was on was to the left.
        assert_eq!(monitor_index_for(&monitors, at(-40, 500)), None);
        // With no monitors at all there is nothing to restore onto either.
        assert_eq!(monitor_index_for(&[], at(10, 10)), None);
    }

    #[test]
    fn a_position_survives_the_round_trip() {
        let stored = Stored {
            placement: Placement { dock: Dock::Bottom, offset: Some(742.5) },
            anchor: PhysicalPosition::new(742, 996),
        };
        let raw = encode(stored).expect("encodes");
        assert_eq!(parse(&raw), Ok(stored));
    }

    #[test]
    fn a_corrupt_file_is_refused_rather_than_half_read() {
        for (raw, what) in [
            ("", "empty"),
            ("{", "truncated mid-write"),
            ("not json at all", "not json"),
            ("[]", "the wrong kind of document"),
            (r#"{"version":1,"dock":"left"}"#, "missing the offset"),
            (r#"{"version":1,"dock":"left","offset":10}"#, "missing the anchor"),
            (
                r#"{"version":1,"dock":"left","offset":"far","anchor":{"x":0,"y":0}}"#,
                "an offset that is not a number",
            ),
            (
                r#"{"version":1,"dock":"middle","offset":10,"anchor":{"x":0,"y":0}}"#,
                "an edge that is not an edge",
            ),
            (
                r#"{"version":1,"dock":"left","offset":-10,"anchor":{"x":0,"y":0}}"#,
                "a negative offset",
            ),
            (
                r#"{"version":99,"dock":"left","offset":10,"anchor":{"x":0,"y":0}}"#,
                "a version from the future",
            ),
        ] {
            assert!(parse(raw).is_err(), "{what} should be refused: {raw}");
        }
    }

    /// A scratch path of our own. No temp-file crate for one test module.
    fn scratch(name: &str) -> std::path::PathBuf {
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let unique = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        std::env::temp_dir()
            .join(format!("quota-monitor-test-{}-{unique}", std::process::id()))
            .join(name)
    }

    #[test]
    fn a_position_written_to_disk_is_the_position_read_back() {
        let path = scratch(super::FILE);
        let stored = Stored {
            placement: Placement { dock: Dock::Left, offset: Some(275.0) },
            anchor: PhysicalPosition::new(0, 275),
        };

        // The directory does not exist yet either; storing makes it.
        super::store(&path, stored);
        assert_eq!(super::load(&path), Some(stored));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn no_file_at_all_is_the_normal_first_run() {
        assert_eq!(super::load(&scratch("never-written.json")), None);
    }

    #[test]
    fn a_corrupt_file_on_disk_falls_back_rather_than_failing() {
        // Exactly what a crash mid-write leaves behind.
        let path = scratch("truncated.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, r#"{"version":1,"dock":"le"#).unwrap();

        assert_eq!(super::load(&path), None, "a half-written file is not a position");

        // And the next drop overwrites it with something readable.
        let stored = Stored {
            placement: Placement { dock: Dock::Top, offset: Some(0.0) },
            anchor: PhysicalPosition::new(0, 0),
        };
        super::store(&path, stored);
        assert_eq!(super::load(&path), Some(stored));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_byte_order_mark_is_not_corruption() {
        // What a Windows editor leaves behind if the file is ever opened and
        // saved. Found by planting a position by hand and watching the widget
        // refuse it.
        let raw = format!(
            "\u{feff}{{\"version\":{VERSION},\"dock\":\"top\",\"offset\":1200.0,\"anchor\":{{\"x\":1200,\"y\":0}}}}"
        );
        let stored = parse(&raw).expect("a BOM is not a corrupt file");
        assert_eq!(stored.placement.dock, Dock::Top);
        assert_eq!(stored.placement.offset, Some(1200.0));
    }

    #[test]
    fn a_file_with_extra_keys_still_reads() {
        // Forward compatibility in the one direction that is safe: a newer
        // build of the same version adding a key must not brick an older one.
        let raw = format!(
            r#"{{"version":{VERSION},"dock":"top","offset":12.5,"anchor":{{"x":12,"y":0}},"mood":"blue"}}"#
        );
        let stored = parse(&raw).expect("extra keys are ignored");
        assert_eq!(stored.placement.dock, Dock::Top);
        assert_eq!(stored.placement.offset, Some(12.5));
    }
}
