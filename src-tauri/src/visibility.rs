//! Which providers the widget DRAWS, and remembering it between runs.
//!
//! This is presentation, and it is deliberately NOT `providers.<id>.enabled`
//! in the user's config file. The two look alike and mean different things:
//!
//!   - `providers.<id>.enabled: false` in config.yaml stops the adapter from
//!     reading at all. Nothing is scanned, nothing is parsed, and the id never
//!     appears in the CLI's JSON envelope. It is how you tell quota-monitor to
//!     leave a tool alone.
//!   - a provider unticked in the tray menu is still detected, still read on
//!     every poll, still counted in the envelope and still there for
//!     `quota --json`. The widget simply does not draw its row.
//!
//! Keeping them apart matters in both directions: someone who wants
//! quota-monitor to stop touching a tool has to edit the config, and someone
//! who only wants a tidier widget must not have to.
//!
//! The set lives in its own small file in the app data directory, for exactly
//! the reason the window position does - see the note at the top of
//! placement.rs. Nothing here writes to the user's config file.
//!
//! HIDDEN ids are what is stored, not visible ones. That is the difference
//! between "a provider you install tomorrow shows up on its own" and "a
//! provider you install tomorrow is invisible until you go and find the menu
//! item for it". The first is the only defensible default.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::state::AppState;
use crate::{log, popover, strip};

/// File name under the app data directory. Not `config.yaml`: this is state
/// the app maintains, not settings the user writes.
pub const FILE: &str = "provider-visibility.json";

/// Bumped only if the shape below changes incompatibly. A file from the future
/// is treated exactly like a corrupt one - discarded, with a note.
const VERSION: u32 = 1;

/// Emitted to both windows whenever the visible set changes. The payload is
/// `{ hidden: [id, ...] }`, and the page redraws from it and re-measures - the
/// strip is sized to its content, so hiding a row has to shrink the window.
pub const EVENT: &str = "provider-visibility";

/// Longest provider id we will store. Ids come from our own CLI, so this is
/// not a trust boundary; it is a cap on what a broken adapter can write into
/// a state file and into a menu label.
const MAX_ID: usize = 64;

/// The tray menu's answer to "which providers, and which are ticked".
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    /// The provider id, as the sidecar reports it.
    pub id: String,
    /// What to write in the menu: "Claude Code", not "claude-code".
    pub label: String,
    /// Ticked means drawn.
    pub visible: bool,
}

/// What the user has hidden, and which providers there are to hide.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Visibility {
    /// Ids the user has unticked. May name a provider that no longer exists:
    /// see `retain_unknown` on the tests.
    hidden: BTreeSet<String>,
    /// The ids of the most recent read, in the order the CLI reported them.
    /// Saved as well as held in memory so the menu is right on the very first
    /// right-click of a session, before any read has come back.
    known: Vec<String>,
}

impl Visibility {
    pub fn is_hidden(&self, id: &str) -> bool {
        self.hidden.contains(id)
    }

    /// The hidden ids, sorted, for the event payload and the file.
    pub fn hidden(&self) -> Vec<String> {
        self.hidden.iter().cloned().collect()
    }

    /// One menu entry per provider we have actually seen.
    ///
    /// Built from `known`, never from `hidden`, so an id left in the file by a
    /// provider that has since gone away cannot put a phantom item in the
    /// menu. The id stays in the file: an uninstalled tool is often a
    /// reinstalled tool, and forgetting the choice would be its own surprise.
    pub fn entries(&self) -> Vec<Entry> {
        self.known
            .iter()
            .map(|id| Entry {
                id: id.clone(),
                label: label_for(id),
                visible: !self.is_hidden(id),
            })
            .collect()
    }

    /// Hide or show one provider. True when that changed anything.
    pub fn set_hidden(&mut self, id: &str, hidden: bool) -> bool {
        if id.is_empty() || id.len() > MAX_ID {
            return false;
        }
        if hidden {
            self.hidden.insert(id.to_string())
        } else {
            self.hidden.remove(id)
        }
    }

    /// Record the providers the latest read reported. True when the set (or
    /// its order) changed, which is the only time the menu has to be rebuilt
    /// and the file rewritten.
    pub fn note_known(&mut self, ids: Vec<String>) -> bool {
        if self.known == ids {
            return false;
        }
        self.known = ids;
        true
    }
}

/// The file the set lives in, under the app data directory.
pub fn file_in(data_dir: &Path) -> PathBuf {
    data_dir.join(FILE)
}

/// A readable name for a provider id.
///
/// The known ones are spelled the way the panel spells them - the titles in
/// the `MARKS` table in ui/panel.js - so the menu and the widget agree.
/// Anything else is a community adapter we have never heard of, and
/// title-casing its id beats printing the id raw.
pub fn label_for(id: &str) -> String {
    match id {
        "claude-code" => return "Claude Code".to_string(),
        "codex" => return "Codex".to_string(),
        "copilot" => return "GitHub Copilot".to_string(),
        "cursor" => return "Cursor".to_string(),
        "devin" => return "Devin".to_string(),
        _ => {}
    }

    let words: Vec<String> = id
        .split(['-', '_', ' '])
        .filter(|word| !word.is_empty())
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect();

    if words.is_empty() {
        // An id that is nothing but separators. Not a thing our CLI emits, but
        // an empty menu item would be unclickable and unexplainable.
        return id.to_string();
    }
    words.join(" ")
}

/// The provider ids in a CLI envelope, in order and without duplicates.
///
/// Anything that is not the envelope we expect yields an empty list rather
/// than an error: the caller's fallback is "keep the list we already had",
/// which is right for a read that came back malformed.
pub fn ids_from(payload: &Value) -> Vec<String> {
    let Some(results) = payload.get("results").and_then(Value::as_array) else {
        return Vec::new();
    };

    let mut ids: Vec<String> = Vec::new();
    for result in results {
        let Some(id) = result.get("id").and_then(Value::as_str) else { continue };
        let id = id.trim();
        if id.is_empty() || id.len() > MAX_ID {
            continue;
        }
        if ids.iter().any(|seen| seen == id) {
            continue;
        }
        ids.push(id.to_string());
    }
    ids
}

/* ------------------------------------------------------------- on disk -- */

/// The on-disk shape, kept separate from the in-memory value so the two can
/// move independently.
#[derive(Debug, Deserialize, Serialize)]
struct Document {
    version: u32,
    /// The providers the last read reported. Only ever a starting point: the
    /// next read replaces it.
    #[serde(default)]
    providers: Vec<String>,
    /// The ids the user unticked.
    #[serde(default)]
    hidden: Vec<String>,
}

/// Read the saved set, or explain in the log why we are ignoring one.
///
/// Never fails and never returns nothing to work with: a missing, unreadable,
/// corrupt or future-versioned file all mean "everything is visible", which is
/// the state the widget shipped in and is always usable. A hidden provider
/// re-appearing after a corrupt file is a visible, self-explaining degradation
/// - unlike the alternative, a widget that draws nothing and will not say why.
pub fn load(path: &Path) -> Visibility {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        // No file yet is the normal first run, and worth no note at all.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Visibility::default(),
        Err(error) => {
            log::line(&format!(
                "could not read the saved provider visibility {} ({error}); every provider will be shown",
                path.display()
            ));
            return Visibility::default();
        }
    };

    match parse(&raw) {
        Ok(visibility) => visibility,
        Err(reason) => {
            log::line(&format!(
                "ignoring the saved provider visibility in {} ({reason}); every provider will be shown",
                path.display()
            ));
            Visibility::default()
        }
    }
}

/// Write the set down. Failure is logged and otherwise survivable: the widget
/// is already showing what the user asked for, it just will not remember after
/// a restart.
pub fn store(path: &Path, visibility: &Visibility) {
    if let Some(parent) = path.parent() {
        if let Err(error) = std::fs::create_dir_all(parent) {
            log::line(&format!(
                "could not create {} for the provider visibility ({error}); this choice will not be remembered",
                parent.display()
            ));
            return;
        }
    }

    let encoded = match encode(visibility) {
        Ok(encoded) => encoded,
        Err(reason) => {
            log::line(&format!("could not encode the provider visibility ({reason})"));
            return;
        }
    };

    if let Err(error) = std::fs::write(path, encoded) {
        log::line(&format!(
            "could not write {} ({error}); this choice will not be remembered",
            path.display()
        ));
    }
}

/// Decode one file's worth of JSON.
///
/// Strict about the envelope, forgiving about the contents. A wrong version or
/// malformed JSON is refused outright, because the caller's fallback - show
/// everything - is safe. Individual ids are filtered rather than fatal: one
/// junk entry must not cost the user every other choice they made.
fn parse(raw: &str) -> Result<Visibility, String> {
    // A leading byte order mark is not corruption, it is Notepad. Same reason
    // as placement.rs: someone who opens this file to see what the widget
    // remembers should not lose it by saving it back.
    let raw = raw.trim_start_matches('\u{feff}');

    let document: Document =
        serde_json::from_str(raw).map_err(|error| format!("not valid JSON: {error}"))?;

    if document.version != VERSION {
        return Err(format!("version {} is not {VERSION}", document.version));
    }

    let usable = |id: &String| !id.trim().is_empty() && id.len() <= MAX_ID;

    let mut known: Vec<String> = Vec::new();
    for id in document.providers.iter().filter(|id| usable(id)) {
        let id = id.trim().to_string();
        if !known.contains(&id) {
            known.push(id);
        }
    }

    Ok(Visibility {
        hidden: document
            .hidden
            .iter()
            .filter(|id| usable(id))
            .map(|id| id.trim().to_string())
            .collect(),
        known,
    })
}

fn encode(visibility: &Visibility) -> Result<String, String> {
    let document = Document {
        version: VERSION,
        providers: visibility.known.clone(),
        hidden: visibility.hidden(),
    };
    serde_json::to_string_pretty(&document).map_err(|error| error.to_string())
}

/* ------------------------------------------------------------ the app -- */

/// The menu entries to build right now.
pub fn entries_now(app: &AppHandle) -> Vec<Entry> {
    match app.state::<AppState>().visibility.lock() {
        Ok(visibility) => visibility.entries(),
        Err(_) => {
            // A poisoned lock means another thread panicked holding it. An
            // empty menu section is honest here - we genuinely do not know
            // what to tick - and the tray builds its "no read yet" item.
            log::line("the provider visibility is poisoned; the tray menu will list nothing");
            Vec::new()
        }
    }
}

/// Learn which providers exist from a read that just came back.
///
/// The list is whatever the sidecar reported, never a hardcoded set: a
/// community adapter the shell has never heard of gets a menu item like any
/// other. Only a change is acted on, because this runs on every poll.
pub fn note_providers(app: &AppHandle, payload: &Value) {
    let ids = ids_from(payload);
    if ids.is_empty() {
        // A read with no results at all - the CLI failed, or every adapter is
        // disabled in config. Keeping the previous list means the menu still
        // offers the providers the user knows about instead of emptying out
        // for the duration of an outage.
        return;
    }

    let state = app.state::<AppState>();
    let snapshot = {
        let Ok(mut visibility) = state.visibility.lock() else {
            log::line("the provider visibility is poisoned; the tray menu will not be updated");
            return;
        };
        if !visibility.note_known(ids) {
            return;
        }
        visibility.clone()
    };

    log::line(&format!(
        "providers detected: {}",
        snapshot
            .entries()
            .iter()
            .map(|entry| format!("{}{}", entry.id, if entry.visible { "" } else { " (hidden)" }))
            .collect::<Vec<_>>()
            .join(", ")
    ));

    remember(app, &snapshot);
    crate::tray::rebuild_menu(app);
}

/// Tick or untick one provider: persist, tell both windows, redraw the menu.
pub fn toggle(app: &AppHandle, id: &str) {
    let state = app.state::<AppState>();
    let (now_hidden, snapshot) = {
        let Ok(mut visibility) = state.visibility.lock() else {
            log::line(&format!(
                "the provider visibility is poisoned; {id} was left as it was"
            ));
            return;
        };
        let now_hidden = !visibility.is_hidden(id);
        if !visibility.set_hidden(id, now_hidden) {
            log::line(&format!("ignored a tray toggle for an unusable provider id: {id}"));
            return;
        }
        (now_hidden, visibility.clone())
    };

    log::line(&format!(
        "{} is now {} in the widget (it is still read either way)",
        label_for(id),
        if now_hidden { "hidden" } else { "shown" }
    ));

    remember(app, &snapshot);
    broadcast(app, &snapshot);
    crate::tray::rebuild_menu(app);
}

/// Write the set down, if there is anywhere to write it.
fn remember(app: &AppHandle, visibility: &Visibility) {
    let Some(path) = app.state::<AppState>().visibility_path.clone() else {
        // Logged once already, at startup. Repeating it on every toggle would
        // bury the log in the one message the user can do nothing about.
        return;
    };
    store(&path, visibility);
}

/// Tell every window that is open which providers to draw.
///
/// Both, not just the focused one: the strip and the popover run the same page
/// and either may be on screen. A window that does not exist is not an error,
/// which is why this reports at most one line per emit rather than failing.
fn broadcast(app: &AppHandle, visibility: &Visibility) {
    let payload = serde_json::json!({ "hidden": visibility.hidden() });
    for label in [strip::LABEL, popover::LABEL] {
        if app.get_webview_window(label).is_none() {
            continue;
        }
        if let Err(error) = app.emit_to(label, EVENT, payload.clone()) {
            log::line(&format!(
                "could not tell the {label} window which providers to draw ({error}); it will catch up on its next poll"
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{encode, ids_from, label_for, parse, Visibility, VERSION};

    fn with(hidden: &[&str], known: &[&str]) -> Visibility {
        let mut visibility = Visibility::default();
        visibility.note_known(known.iter().map(|id| (*id).to_string()).collect());
        for id in hidden {
            assert!(visibility.set_hidden(id, true), "{id} should have been hidden");
        }
        visibility
    }

    #[test]
    fn everything_is_visible_until_something_is_hidden() {
        let visibility = with(&[], &["claude-code", "codex"]);
        assert!(!visibility.is_hidden("claude-code"));
        assert!(!visibility.is_hidden("codex"));
        // A provider nobody has ever seen is visible too. Storing hidden ids
        // rather than visible ones is what makes that true.
        assert!(!visibility.is_hidden("cursor"));
        assert!(visibility.hidden().is_empty());
    }

    #[test]
    fn hiding_and_showing_reports_whether_it_changed_anything() {
        let mut visibility = with(&[], &["codex"]);
        assert!(visibility.set_hidden("codex", true), "the first hide changes things");
        assert!(!visibility.set_hidden("codex", true), "the second does not");
        assert!(visibility.is_hidden("codex"));
        assert!(visibility.set_hidden("codex", false), "showing it again changes things");
        assert!(!visibility.set_hidden("codex", false));
        assert!(!visibility.is_hidden("codex"));
    }

    #[test]
    fn the_menu_lists_the_providers_that_were_detected() {
        let visibility = with(&["codex"], &["claude-code", "codex"]);
        let entries = visibility.entries();
        assert_eq!(entries.len(), 2);
        // Order is the order the CLI reported, so the menu does not shuffle.
        assert_eq!(entries[0].id, "claude-code");
        assert_eq!(entries[0].label, "Claude Code");
        assert!(entries[0].visible);
        assert_eq!(entries[1].label, "Codex");
        assert!(!entries[1].visible, "an unticked provider is not visible");
    }

    #[test]
    fn an_id_saved_for_a_provider_that_has_gone_away_puts_nothing_in_the_menu() {
        // Devin was installed, was hidden, and has since been uninstalled, so
        // the last read never mentioned it.
        let raw = format!(
            r#"{{"version":{VERSION},"providers":["claude-code"],"hidden":["devin","claude-code"]}}"#
        );
        let visibility = parse(&raw).expect("this file is fine");

        let entries = visibility.entries();
        assert_eq!(entries.len(), 1, "only what the last read reported is offered");
        assert_eq!(entries[0].id, "claude-code");
        assert!(!entries[0].visible);

        // The choice is still remembered, so reinstalling Devin does not
        // silently un-hide it.
        assert!(visibility.is_hidden("devin"));
        assert_eq!(visibility.hidden(), vec!["claude-code".to_string(), "devin".to_string()]);

        // And it survives being written back out.
        let round_tripped = parse(&encode(&visibility).expect("encodes")).expect("re-reads");
        assert_eq!(round_tripped, visibility);
    }

    #[test]
    fn a_new_provider_appearing_does_not_disturb_the_hidden_ones() {
        let mut visibility = with(&["codex"], &["claude-code", "codex"]);
        assert!(visibility.note_known(vec![
            "claude-code".to_string(),
            "codex".to_string(),
            "cursor".to_string(),
        ]));
        let entries = visibility.entries();
        assert_eq!(entries.len(), 3);
        assert!(entries[2].visible, "a provider seen for the first time is drawn");
        assert!(!entries[1].visible, "and the old choice still stands");
        // Same list again is not a change, so the menu is not rebuilt on
        // every 60-second poll.
        assert!(!visibility.note_known(vec![
            "claude-code".to_string(),
            "codex".to_string(),
            "cursor".to_string(),
        ]));
    }

    #[test]
    fn a_set_survives_the_round_trip() {
        let visibility = with(&["codex"], &["claude-code", "codex", "cursor"]);
        let raw = encode(&visibility).expect("encodes");
        assert_eq!(parse(&raw), Ok(visibility));
    }

    #[test]
    fn a_corrupt_file_is_refused_rather_than_half_read() {
        for (raw, what) in [
            ("", "empty"),
            ("{", "truncated mid-write"),
            ("not json at all", "not json"),
            ("[]", "the wrong kind of document"),
            (r#"{"providers":[],"hidden":[]}"#, "no version at all"),
            (
                r#"{"version":99,"providers":[],"hidden":["codex"]}"#,
                "a version from the future",
            ),
            (
                r#"{"version":1,"hidden":"codex"}"#,
                "a hidden set that is not a set",
            ),
            (
                r#"{"version":1,"hidden":[7]}"#,
                "an id that is not a string",
            ),
        ] {
            assert!(parse(raw).is_err(), "{what} should be refused: {raw}");
        }
    }

    #[test]
    fn a_file_with_junk_ids_keeps_the_ids_that_are_fine() {
        // One bad entry must not cost the user every other choice.
        let long = "x".repeat(super::MAX_ID + 1);
        let raw = format!(
            r#"{{"version":{VERSION},"providers":["codex","codex",""],"hidden":["codex","  ","{long}"]}}"#
        );
        let visibility = parse(&raw).expect("junk entries are dropped, not fatal");
        assert_eq!(visibility.entries().len(), 1, "the duplicate and the blank are gone");
        assert_eq!(visibility.hidden(), vec!["codex".to_string()]);
    }

    #[test]
    fn a_byte_order_mark_is_not_corruption() {
        let raw = format!(
            "\u{feff}{{\"version\":{VERSION},\"providers\":[\"codex\"],\"hidden\":[\"codex\"]}}"
        );
        let visibility = parse(&raw).expect("a BOM is not a corrupt file");
        assert!(visibility.is_hidden("codex"));
    }

    #[test]
    fn a_file_with_extra_keys_still_reads() {
        // A newer build adding a key must not brick an older one.
        let raw = format!(
            r#"{{"version":{VERSION},"providers":["codex"],"hidden":[],"mood":"blue"}}"#
        );
        assert_eq!(parse(&raw).expect("extra keys are ignored").entries().len(), 1);
    }

    /// A scratch path of our own. No temp-file crate for one test module.
    fn scratch(name: &str) -> std::path::PathBuf {
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let unique = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        std::env::temp_dir()
            .join(format!("quota-monitor-visibility-{}-{unique}", std::process::id()))
            .join(name)
    }

    #[test]
    fn a_set_written_to_disk_is_the_set_read_back() {
        let path = scratch(super::FILE);
        let visibility = with(&["codex"], &["claude-code", "codex"]);

        // The directory does not exist yet either; storing makes it.
        super::store(&path, &visibility);
        assert_eq!(super::load(&path), visibility);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn no_file_at_all_shows_everything() {
        let visibility = super::load(&scratch("never-written.json"));
        assert_eq!(visibility, Visibility::default());
        assert!(!visibility.is_hidden("claude-code"));
        assert!(visibility.entries().is_empty());
    }

    #[test]
    fn a_corrupt_file_on_disk_shows_everything_rather_than_nothing() {
        // Exactly what a crash mid-write leaves behind. The failure mode that
        // matters is the other one: a half-read file must never be able to
        // hide providers the user never hid.
        let path = scratch("truncated.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, r#"{"version":1,"hidden":["cod"#).unwrap();

        let visibility = super::load(&path);
        assert_eq!(visibility, Visibility::default());
        assert!(!visibility.is_hidden("codex"));

        // And the next toggle overwrites it with something readable.
        let fixed = with(&["codex"], &["codex"]);
        super::store(&path, &fixed);
        assert_eq!(super::load(&path), fixed);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn provider_ids_are_labelled_readably() {
        assert_eq!(label_for("claude-code"), "Claude Code");
        assert_eq!(label_for("codex"), "Codex");
        assert_eq!(label_for("copilot"), "GitHub Copilot");
        // A community adapter we have never heard of still gets a name.
        assert_eq!(label_for("some-new-thing"), "Some New Thing");
        assert_eq!(label_for("some_new_thing"), "Some New Thing");
        assert_eq!(label_for("aider"), "Aider");
        // Nothing usable in it at all: print it rather than an empty item.
        assert_eq!(label_for("--"), "--");
    }

    #[test]
    fn the_provider_list_comes_from_the_envelope() {
        let payload = serde_json::json!({
            "tool": "quota-monitor",
            "results": [
                { "ok": true, "id": "claude-code", "readings": [] },
                { "ok": false, "id": "codex", "error": "no rollouts" },
                { "ok": true, "id": "claude-code", "readings": [] },
                { "ok": true, "readings": [] },
                { "ok": true, "id": "   ", "readings": [] }
            ]
        });
        // A failed adapter is still a provider you can hide; a duplicate, a
        // missing id and a blank one are not.
        assert_eq!(ids_from(&payload), vec!["claude-code".to_string(), "codex".to_string()]);
    }

    #[test]
    fn an_envelope_that_is_not_one_yields_no_providers() {
        for payload in [
            serde_json::json!({}),
            serde_json::json!({ "results": "soon" }),
            serde_json::json!([]),
            serde_json::json!(null),
        ] {
            assert!(ids_from(&payload).is_empty(), "{payload} is not an envelope");
        }
    }
}
