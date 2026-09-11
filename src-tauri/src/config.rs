//! The two settings the desktop shell reads for itself: `widget.mode` and
//! `widget.dock`.
//!
//! Everything else about quota-monitor is decided by the CLI, which owns the
//! config file (`src/core/config.ts`). The shell deliberately reads the *same*
//! file rather than inventing a second one, so a user has exactly one place to
//! configure the tool. It reads only those two keys and ignores the rest.
//!
//! Fail-soft, in the same spirit as the CLI: a missing file, unparseable YAML,
//! a wrong-typed value or an unrecognised mode all fall back to the default
//! and leave a note behind. Nothing here panics, and nothing here writes.

use std::fmt;
use std::path::{Path, PathBuf};

use serde_yaml_ng::Value;

/// Same environment variable the CLI honours, so `QUOTA_MONITOR_CONFIG=...`
/// points both halves of the tool at one file.
pub const CONFIG_ENV_VAR: &str = "QUOTA_MONITOR_CONFIG";

/// Which of the two window modes to run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WidgetMode {
    /// Only the sliver docked to the screen edge.
    Strip,
    /// Only the tray icon and its popover.
    Tray,
    /// Both. The default: they answer different questions.
    Both,
}

impl WidgetMode {
    pub const DEFAULT: Self = Self::Both;

    pub fn wants_strip(self) -> bool {
        matches!(self, Self::Strip | Self::Both)
    }

    pub fn wants_tray(self) -> bool {
        matches!(self, Self::Tray | Self::Both)
    }

    fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "strip" => Some(Self::Strip),
            "tray" => Some(Self::Tray),
            "both" => Some(Self::Both),
            _ => None,
        }
    }
}

impl fmt::Display for WidgetMode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Strip => "strip",
            Self::Tray => "tray",
            Self::Both => "both",
        })
    }
}

/// Which screen edge the collapsed widget lives on.
///
/// The edge implies the layout, so there is no second key to disagree with
/// this one: a left or right edge gets the upright `rail`, a top or bottom
/// edge gets the horizontal `bar`. A 300x44 bar standing on its end down the
/// side of the screen is not a thing anyone wants, and a 64px rail lying
/// across the top is not either.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dock {
    Left,
    Right,
    Top,
    Bottom,
}

/// The shape the collapsed widget takes, decided entirely by `Dock`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Layout {
    /// Upright: badges across the top, vertical bars, bare numbers beneath.
    Rail,
    /// On its side: badge, bar, percentage, repeated.
    Bar,
}

impl Dock {
    /// The right edge, which is where the widget has always been.
    pub const DEFAULT: Self = Self::Right;

    pub fn layout(self) -> Layout {
        match self {
            Self::Left | Self::Right => Layout::Rail,
            Self::Top | Self::Bottom => Layout::Bar,
        }
    }

    /// Also used by `placement`, which reads the same four words back out of
    /// the saved-position file so that file and the config agree on spelling.
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "left" => Some(Self::Left),
            "right" => Some(Self::Right),
            "top" => Some(Self::Top),
            "bottom" => Some(Self::Bottom),
            _ => None,
        }
    }
}

impl fmt::Display for Dock {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Left => "left",
            Self::Right => "right",
            Self::Top => "top",
            Self::Bottom => "bottom",
        })
    }
}

impl fmt::Display for Layout {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Rail => "rail",
            Self::Bar => "bar",
        })
    }
}

/// What the shell learned from the config file, plus everything it wants the
/// user to know about how it got there.
pub struct Settings {
    pub mode: WidgetMode,
    pub dock: Dock,
    /// The file we looked at, whether or not it existed.
    pub path: PathBuf,
    /// Lines for the log. Empty on the happy path.
    pub notes: Vec<String>,
}

/// Where the config file lives. Mirrors `configPath()` in src/core/config.ts.
pub fn config_path(home: Option<&Path>) -> PathBuf {
    if let Some(value) = std::env::var_os(CONFIG_ENV_VAR) {
        if !value.is_empty() {
            return PathBuf::from(value);
        }
    }
    let base = home.map(Path::to_path_buf).unwrap_or_default();
    base.join(".config").join("quota-monitor").join("config.yaml")
}

/// Read the widget settings, or explain why we are using the defaults instead.
pub fn load(home: Option<&Path>) -> Settings {
    let path = config_path(home);
    let mut notes = Vec::new();

    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // Not an error. Running with no config file is the normal case.
            return Settings {
                mode: WidgetMode::DEFAULT,
                dock: Dock::DEFAULT,
                path,
                notes,
            };
        }
        Err(error) => {
            notes.push(format!(
                "could not read {} ({error}); using widget.mode: {} and widget.dock: {}",
                path.display(),
                WidgetMode::DEFAULT,
                Dock::DEFAULT
            ));
            return Settings {
                mode: WidgetMode::DEFAULT,
                dock: Dock::DEFAULT,
                path,
                notes,
            };
        }
    };

    let (mode, dock) = widget_from_yaml(&raw, &mut notes);
    Settings { mode, dock, path, notes }
}

/// Pull the `widget` section out of a YAML document, complaining in `notes`
/// about anything it had to ignore.
///
/// One parse for both keys: a broken file should say so once, not once per
/// setting the shell happens to look for.
fn widget_from_yaml(raw: &str, notes: &mut Vec<String>) -> (WidgetMode, Dock) {
    let defaults = (WidgetMode::DEFAULT, Dock::DEFAULT);

    if raw.trim().is_empty() {
        return defaults;
    }

    let document: Value = match serde_yaml_ng::from_str(raw) {
        Ok(value) => value,
        Err(error) => {
            notes.push(format!(
                "config is not valid YAML ({error}); using widget.mode: {} and widget.dock: {}",
                WidgetMode::DEFAULT,
                Dock::DEFAULT
            ));
            return defaults;
        }
    };

    // An all-comments file parses to null, and a file with no widget section
    // is just as normal. Neither is worth a note.
    let Some(widget) = document.get("widget") else {
        return defaults;
    };
    if widget.is_null() {
        return defaults;
    }
    if !widget.is_mapping() {
        notes.push(format!(
            "widget: expected a mapping; using widget.mode: {} and widget.dock: {}",
            WidgetMode::DEFAULT,
            Dock::DEFAULT
        ));
        return defaults;
    }

    (
        choice(widget, "mode", "strip, tray, both", WidgetMode::DEFAULT, WidgetMode::parse, notes),
        choice(widget, "dock", "left, right, top, bottom", Dock::DEFAULT, Dock::parse, notes),
    )
}

/// Read one string-valued key out of the widget mapping.
///
/// Absent is silent - not configuring something is not a mistake. Present but
/// wrong is loud, in the same shape for every key: say what was found, say
/// what was allowed, and say what is being used instead. Nothing here can
/// fail, because the default is always a usable answer.
fn choice<T: Copy + fmt::Display>(
    widget: &Value,
    key: &str,
    allowed: &str,
    default: T,
    parse: fn(&str) -> Option<T>,
    notes: &mut Vec<String>,
) -> T {
    let Some(value) = widget.get(key) else {
        return default;
    };

    let Some(text) = value.as_str() else {
        notes.push(format!(
            "widget.{key}: expected one of {allowed}; using {default}"
        ));
        return default;
    };

    match parse(text) {
        Some(parsed) => parsed,
        None => {
            notes.push(format!(
                "widget.{key}: \"{text}\" is not one of {allowed}; using {default}"
            ));
            default
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{widget_from_yaml, Dock, Layout, WidgetMode};

    fn parse(raw: &str) -> (WidgetMode, Vec<String>) {
        let mut notes = Vec::new();
        let (mode, _) = widget_from_yaml(raw, &mut notes);
        (mode, notes)
    }

    fn parse_dock(raw: &str) -> (Dock, Vec<String>) {
        let mut notes = Vec::new();
        let (_, dock) = widget_from_yaml(raw, &mut notes);
        (dock, notes)
    }

    #[test]
    fn reads_the_mode() {
        let (mode, notes) = parse("widget:\n  mode: tray\n");
        assert_eq!(mode, WidgetMode::Tray);
        assert!(notes.is_empty());
    }

    #[test]
    fn accepts_flow_style_and_odd_casing() {
        assert_eq!(parse("widget: {mode: STRIP}").0, WidgetMode::Strip);
    }

    #[test]
    fn ignores_the_rest_of_the_config() {
        let raw =
            "refreshSeconds: 30\nproviders:\n  codex: false\nwidget:\n  ascii: true\n  mode: strip\n";
        let (mode, notes) = parse(raw);
        assert_eq!(mode, WidgetMode::Strip);
        assert!(notes.is_empty());
    }

    #[test]
    fn defaults_quietly_when_the_key_is_absent() {
        assert_eq!(parse("widget:\n  ascii: true\n"), (WidgetMode::Both, vec![]));
        assert_eq!(parse("# nothing but a comment\n"), (WidgetMode::Both, vec![]));
        assert_eq!(parse(""), (WidgetMode::Both, vec![]));
    }

    #[test]
    fn defaults_loudly_when_the_value_is_wrong() {
        let (mode, notes) = parse("widget:\n  mode: sidebar\n");
        assert_eq!(mode, WidgetMode::Both);
        assert_eq!(notes.len(), 1);
        assert!(notes[0].contains("sidebar"));

        let (mode, notes) = parse("widget:\n  mode: 3\n");
        assert_eq!(mode, WidgetMode::Both);
        assert_eq!(notes.len(), 1);
    }

    #[test]
    fn defaults_loudly_on_broken_yaml() {
        let (mode, notes) = parse("widget:\n\tmode: tray\n");
        assert_eq!(mode, WidgetMode::Both);
        assert_eq!(notes.len(), 1);
        assert!(notes[0].contains("not valid YAML"));
    }

    #[test]
    fn reads_the_dock() {
        assert_eq!(parse_dock("widget:
  dock: left
"), (Dock::Left, vec![]));
        assert_eq!(parse_dock("widget:
  dock: TOP
"), (Dock::Top, vec![]));
        assert_eq!(parse_dock("widget: {dock: bottom}"), (Dock::Bottom, vec![]));
        assert_eq!(parse_dock("widget:
  dock: right
"), (Dock::Right, vec![]));
    }

    #[test]
    fn the_dock_defaults_to_the_right_edge() {
        assert_eq!(parse_dock("widget:
  mode: strip
"), (Dock::Right, vec![]));
        assert_eq!(parse_dock(""), (Dock::Right, vec![]));
    }

    #[test]
    fn defaults_loudly_on_a_dock_that_is_not_an_edge() {
        let (dock, notes) = parse_dock("widget:
  dock: middle
");
        assert_eq!(dock, Dock::Right);
        assert_eq!(notes.len(), 1);
        assert!(notes[0].contains("middle"), "{}", notes[0]);
        assert!(notes[0].contains("left, right, top, bottom"), "{}", notes[0]);

        // A number is not an edge either, and says so in the same shape.
        let (dock, notes) = parse_dock("widget:
  dock: 4
");
        assert_eq!(dock, Dock::Right);
        assert_eq!(notes.len(), 1);
        assert!(notes[0].contains("widget.dock"), "{}", notes[0]);
    }

    #[test]
    fn both_keys_are_read_from_one_document() {
        let mut notes = Vec::new();
        let (mode, dock) = widget_from_yaml("widget:
  mode: strip
  dock: bottom
", &mut notes);
        assert_eq!((mode, dock), (WidgetMode::Strip, Dock::Bottom));
        assert!(notes.is_empty());

        // One bad key does not take the other down with it.
        let mut notes = Vec::new();
        let (mode, dock) = widget_from_yaml("widget:
  mode: sideways
  dock: top
", &mut notes);
        assert_eq!((mode, dock), (WidgetMode::Both, Dock::Top));
        assert_eq!(notes.len(), 1);
    }

    #[test]
    fn the_edge_decides_the_layout() {
        assert_eq!(Dock::Left.layout(), Layout::Rail);
        assert_eq!(Dock::Right.layout(), Layout::Rail);
        assert_eq!(Dock::Top.layout(), Layout::Bar);
        assert_eq!(Dock::Bottom.layout(), Layout::Bar);
    }
}
