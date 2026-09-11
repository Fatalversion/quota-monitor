//! A log the user can actually find.
//!
//! The release build is a `windows_subsystem = "windows"` binary, so there is
//! no console to print to and stderr goes nowhere. That collides with the
//! project rule that nothing degrades silently: if the sidecar cannot be
//! found, or the config file is unreadable, or a monitor query fails, the user
//! has to be able to read about it somewhere.
//!
//! So: every message goes to stderr (useful under `cargo run`) and is appended
//! to a single plain-text file under the app log directory. The file is
//! truncated once at startup rather than rotated, because a widget that runs
//! for a week should not leave a gigabyte behind.
//!
//! What must never reach this file is the sidecar's stdout: it is full of the
//! user's transcript paths. Callers pass summaries, never captured output.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

static SINK: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();

fn sink() -> &'static Mutex<Option<PathBuf>> {
    SINK.get_or_init(|| Mutex::new(None))
}

/// Point the log at a file and start it empty. Failing to open the file is
/// itself reported (to stderr) and then ignored - no log file is a degraded
/// state, not a reason to refuse to start.
pub fn open(path: &Path) {
    if let Some(parent) = path.parent() {
        if let Err(error) = fs::create_dir_all(parent) {
            eprintln!(
                "[quota-monitor] could not create log directory {}: {error}",
                parent.display()
            );
            return;
        }
    }

    match OpenOptions::new().create(true).write(true).truncate(true).open(path) {
        Ok(_) => {
            if let Ok(mut guard) = sink().lock() {
                *guard = Some(path.to_path_buf());
            }
        }
        Err(error) => {
            eprintln!("[quota-monitor] could not open log file {}: {error}", path.display());
        }
    }
}

/// Write one line. Always to stderr, and to the log file when there is one.
pub fn line(message: &str) {
    let stamped = format!("{} {message}", timestamp());
    eprintln!("[quota-monitor] {stamped}");

    let Ok(guard) = sink().lock() else { return };
    let Some(path) = guard.as_ref() else { return };
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    let _ = writeln!(file, "{stamped}");
}

/// `2026-09-11T04:35:33Z`. Hand-rolled so the shell needs no date crate.
fn timestamp() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (year, month, day) = civil_from_days((secs / 86_400) as i64);
    let rem = secs % 86_400;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Days since the Unix epoch to a civil date (Howard Hinnant's algorithm).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod tests {
    use super::civil_from_days;

    #[test]
    fn epoch_is_1970_01_01() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
    }

    #[test]
    fn handles_leap_days() {
        // 2024-02-29 is 19782 days after the epoch.
        assert_eq!(civil_from_days(19_782), (2024, 2, 29));
    }
}
