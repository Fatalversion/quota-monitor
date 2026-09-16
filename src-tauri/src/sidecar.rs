//! Running the quota CLI and handing its JSON to the webview.
//!
//! The shell contains no provider logic whatsoever. It shells out to the same
//! `quota --json` the terminal user runs, and forwards the parsed envelope. If
//! that ever stops being true, the widget and the CLI can disagree, which is
//! the one bug this project cannot afford.
//!
//! Resolution order, first one that exists wins:
//!
//!   1. a `quota` binary bundled next to the app executable. This is what a
//!      packaged build ships: `npm run build:sidecar` produces
//!      `src-tauri/binaries/quota-<target triple>[.exe]`, and Tauri copies it
//!      next to the app under the plain name.
//!
//!      The `bundle.externalBin` declaration that does this lives in
//!      `src-tauri/tauri.bundle.conf.json`, NOT in tauri.conf.json, and is
//!      merged in with `--config` by `npm run build:installer`. The reason is
//!      that tauri-build resolves externalBin at COMPILE time: declaring it in
//!      the base config makes a plain `cargo build` fail with "resource path
//!      ... doesn't exist" until the 76 MB sidecar has been built, and
//!      src-tauri/binaries/ is gitignored. Keeping it in an overlay is what
//!      lets a fresh clone compile the Rust with no sidecar at all and simply
//!      fall through to 2.
//!   2. `node <repo>/dist/cli/index.js --json`, i.e. a compiled checkout
//!   3. `npx --no-install tsx <repo>/src/cli/index.ts --json`, i.e. a plain
//!      checkout with `npm install` run. `--no-install` matters: it guarantees
//!      npx cannot reach out to the network to fetch tsx, which would break
//!      the project's no-network rule.
//!
//! Two hard rules live in this file:
//!
//!   - The child's stdout is NEVER logged. It is full of the user's transcript
//!     and rollout paths. It is parsed, forwarded to the webview that asked
//!     for it, and dropped. Errors describe the shape of the problem, not the
//!     content of the output.
//!   - Nothing panics. Every failure becomes a string the panel renders as an
//!     `{ok: false}` row, because a widget that vanishes when a provider
//!     breaks is worse than one that says so.

use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::log;

/// Kill the child after this long. A quota read scans transcript files, and a
/// refresh additionally runs `claude -p /usage` - measured at 1-5 seconds, but
/// it is a second node process starting while this one reads a week of
/// transcripts, and the CLI gives that its own 20-second bound. A minute leaves
/// room for both without ever being the thing that decides.
const TIMEOUT: Duration = Duration::from_secs(60);
/// How often to check whether the child is done.
const POLL: Duration = Duration::from_millis(25);
/// Refuse to buffer more than this from the child. The real payload is a few
/// kilobytes; anything near this is a runaway, not a quota report.
const MAX_OUTPUT: u64 = 8 * 1024 * 1024;
/// How much of stderr to quote back. Enough to name the failure, capped so a
/// stack trace cannot fill the panel.
const STDERR_EXCERPT: usize = 400;

/// Points at a checkout when the app is not running from inside one.
pub const REPO_ENV_VAR: &str = "QUOTA_MONITOR_REPO";

/// Remembers which launcher we announced, so a 60-second refresh loop does not
/// write the same line to the log a thousand times a day.
static ANNOUNCED: Mutex<Option<String>> = Mutex::new(None);

/// Run the CLI and return its parsed JSON envelope.
///
/// `refresh` is what a person pressing Refresh means, and it is passed
/// straight through to the CLI: ask each provider's own tool for a current
/// figure rather than reading only what is on disk. A poll never sets it.
pub fn read_quota(app: &AppHandle, refresh: bool) -> Result<Value, String> {
    let launcher = match resolve(app, refresh) {
        Ok(launcher) => launcher,
        Err(error) => {
            log::line(&error);
            return Err(error);
        }
    };

    announce(&launcher);

    match launcher.run() {
        Ok(value) => Ok(value),
        Err(error) => {
            log::line(&error);
            Err(error)
        }
    }
}

/// A command line we are prepared to run, plus a name for it in messages.
struct Launcher {
    /// Short human description, e.g. "the bundled quota sidecar".
    label: String,
    program: PathBuf,
    args: Vec<OsString>,
    cwd: Option<PathBuf>,
}

impl Launcher {
    fn describe(&self) -> String {
        format!("{} ({})", self.label, self.program.display())
    }

    fn run(&self) -> Result<Value, String> {
        let mut command = Command::new(&self.program);
        command
            .args(&self.args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(cwd) = &self.cwd {
            command.current_dir(cwd);
        }

        // Without this a console window flashes on every refresh on Windows.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = command
            .spawn()
            .map_err(|error| format!("could not start {}: {error}", self.describe()))?;

        // Drain both pipes on their own threads. A child that fills the stderr
        // pipe while we wait on stdout deadlocks, and a 30 second timeout that
        // only fires after a deadlock is not a timeout.
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let stdout_reader = std::thread::spawn(move || stdout.map(drain).unwrap_or_default());
        let stderr_reader = std::thread::spawn(move || stderr.map(drain).unwrap_or_default());

        let deadline = Instant::now() + TIMEOUT;
        let mut timed_out = false;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) => {
                    if Instant::now() >= deadline {
                        timed_out = true;
                        let _ = child.kill();
                        let _ = child.wait();
                        break None;
                    }
                    std::thread::sleep(POLL);
                }
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("lost track of {}: {error}", self.describe()));
                }
            }
        };

        // Killing the child closes the pipes, so both readers finish.
        let out = stdout_reader.join().unwrap_or_default();
        let err = stderr_reader.join().unwrap_or_default();
        let stderr_note = excerpt(&err.text);

        if timed_out {
            return Err(format!(
                "{} did not answer within {}s and was stopped{stderr_note}",
                self.label,
                TIMEOUT.as_secs()
            ));
        }

        if out.overflowed {
            return Err(format!(
                "{} produced more than {} MiB of output, which is not a quota report; nothing was parsed",
                self.label,
                MAX_OUTPUT / (1024 * 1024)
            ));
        }

        if let Some(status) = status {
            if !status.success() {
                let code = status
                    .code()
                    .map(|code| format!("exit code {code}"))
                    .unwrap_or_else(|| "no exit code (killed by a signal)".to_string());
                return Err(format!("{} failed with {code}{stderr_note}", self.label));
            }
        }

        if out.text.trim().is_empty() {
            return Err(format!("{} printed nothing{stderr_note}", self.label));
        }

        // NOTE: the parse error carries a line and column, never the text at
        // that position, so this message cannot leak a path from stdout.
        serde_json::from_str::<Value>(&out.text).map_err(|error| {
            format!(
                "{} printed something that is not JSON ({error}){stderr_note}",
                self.label
            )
        })
    }
}

#[derive(Default)]
struct Captured {
    text: String,
    /// True when the child hit MAX_OUTPUT, so the caller knows the text is a
    /// prefix and must not be parsed as if it were the whole thing.
    overflowed: bool,
}

fn drain<R: Read>(source: R) -> Captured {
    let mut buffer = Vec::new();
    // One byte past the cap, so a full read is distinguishable from a stream
    // that happened to be exactly MAX_OUTPUT long.
    let _ = source.take(MAX_OUTPUT + 1).read_to_end(&mut buffer);
    let overflowed = buffer.len() as u64 > MAX_OUTPUT;
    Captured { text: String::from_utf8_lossy(&buffer).into_owned(), overflowed }
}

/// The tail of the child's stderr, flattened and capped.
///
/// stderr is diagnostics, not data, and it is the only clue a user gets when
/// the CLI refuses to run - so it is surfaced rather than swallowed. It still
/// goes only into the error string the panel renders, never into the log.
fn excerpt(stderr: &str) -> String {
    let flat = stderr.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.is_empty() {
        return String::new();
    }
    if flat.chars().count() <= STDERR_EXCERPT {
        return format!(" - it said: {flat}");
    }
    let tail: String = flat
        .chars()
        .skip(flat.chars().count() - STDERR_EXCERPT)
        .collect();
    format!(" - it ended with: ...{tail}")
}

/// Log which launcher we settled on, once per distinct launcher.
fn announce(launcher: &Launcher) {
    let description = launcher.describe();
    let Ok(mut guard) = ANNOUNCED.lock() else { return };
    if guard.as_deref() == Some(description.as_str()) {
        return;
    }
    log::line(&format!("reading quota through {description}"));
    *guard = Some(description);
}

/// Find the first runnable quota CLI, or explain everywhere we looked.
fn resolve(app: &AppHandle, refresh: bool) -> Result<Launcher, String> {
    let mut tried: Vec<String> = Vec::new();
    // Every launcher below ends with the same pair, so the flag is built once.
    let mut tail: Vec<OsString> = vec![OsString::from("--json")];
    if refresh {
        tail.push(OsString::from("--refresh"));
    }

    for path in bundled_candidates(app) {
        if path.is_file() {
            return Ok(Launcher {
                label: "the bundled quota sidecar".to_string(),
                program: path,
                args: tail,
                cwd: None,
            });
        }
        tried.push(path.display().to_string());
    }

    let Some(root) = repo_root() else {
        tried.push(format!(
            "no quota-monitor checkout (set {REPO_ENV_VAR} to one to develop against it)"
        ));
        return Err(not_found(&tried));
    };

    let built = root.join("dist").join("cli").join("index.js");
    if built.is_file() {
        match find_in_path("node") {
            Some(node) => {
                return Ok(Launcher {
                    label: "the compiled quota CLI".to_string(),
                    program: node,
                    args: [vec![built.into_os_string()], tail].concat(),
                    cwd: Some(root),
                })
            }
            None => tried.push(format!("{} (but node is not on PATH)", built.display())),
        }
    } else {
        tried.push(built.display().to_string());
    }

    let source = root.join("src").join("cli").join("index.ts");
    if source.is_file() {
        match find_in_path("npx") {
            Some(npx) => {
                return Ok(Launcher {
                    label: "the quota CLI source via tsx".to_string(),
                    program: npx,
                    args: [
                        vec![
                            OsString::from("--no-install"),
                            OsString::from("tsx"),
                            source.into_os_string(),
                        ],
                        tail,
                    ]
                    .concat(),
                    cwd: Some(root),
                })
            }
            None => tried.push(format!("{} (but npx is not on PATH)", source.display())),
        }
    } else {
        tried.push(source.display().to_string());
    }

    Err(not_found(&tried))
}

fn not_found(tried: &[String]) -> String {
    format!(
        "no quota CLI to run. Looked for: {}. Run `npm run build` in the quota-monitor checkout, \
         or install a build of the app that ships the sidecar.",
        tried.join("; ")
    )
}

/// Where a packaged build keeps the sidecar. Tauri strips the target triple
/// from an `externalBin` entry when it copies it, both in dev and in a bundle,
/// so the plain name is the one to look for.
fn bundled_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let name = if cfg!(windows) { "quota.exe" } else { "quota" };
    let mut candidates = Vec::new();

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(name));
            candidates.push(dir.join("binaries").join(name));
        }
    }
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join(name));
    }

    candidates
}

/// The quota-monitor checkout this shell belongs to, if there is one.
fn repo_root() -> Option<PathBuf> {
    if let Some(value) = std::env::var_os(REPO_ENV_VAR) {
        let path = PathBuf::from(value);
        if looks_like_repo(&path) {
            return Some(path);
        }
    }

    // Development: this crate is <repo>/src-tauri. In a packaged build the
    // compile-time path does not exist on the user's machine, so the check
    // below simply fails and we fall through.
    if let Some(parent) = Path::new(env!("CARGO_MANIFEST_DIR")).parent() {
        if looks_like_repo(parent) {
            return Some(parent.to_path_buf());
        }
    }

    // A binary copied somewhere inside a checkout.
    let exe = std::env::current_exe().ok()?;
    exe.ancestors()
        .take(8)
        .find(|dir| looks_like_repo(dir))
        .map(Path::to_path_buf)
}

fn looks_like_repo(dir: &Path) -> bool {
    dir.join("package.json").is_file()
        && (dir.join("src").join("cli").join("index.ts").is_file()
            || dir.join("dist").join("cli").join("index.js").is_file())
}

/// Resolve a program name against PATH ourselves.
///
/// On Windows this is not optional. `Command::new("npx")` appends `.exe` and
/// finds nothing, because npx ships as `npx.cmd`; meanwhile the extensionless
/// `npx` shell script sitting in the same directory is a POSIX script Windows
/// cannot execute, so a naive `is_file()` check picks exactly the wrong file.
/// Hence: on Windows, PATHEXT decides, and a bare name is only accepted when
/// it already carries an extension.
fn find_in_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;

    for dir in std::env::split_paths(&path) {
        if dir.as_os_str().is_empty() {
            continue;
        }

        if cfg!(windows) {
            if Path::new(name).extension().is_some() {
                let direct = dir.join(name);
                if direct.is_file() {
                    return Some(direct);
                }
                continue;
            }
            for ext in windows_extensions() {
                let candidate = dir.join(format!("{name}{ext}"));
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        } else {
            let candidate = dir.join(name);
            if is_executable_file(&candidate) {
                return Some(candidate);
            }
        }
    }

    None
}

fn windows_extensions() -> Vec<String> {
    std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string())
        .split(';')
        .map(str::trim)
        .filter(|ext| !ext.is_empty())
        .map(str::to_string)
        .collect()
}

#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

#[cfg(test)]
mod tests {
    use super::{excerpt, looks_like_repo, STDERR_EXCERPT};
    use std::path::Path;

    #[test]
    fn an_empty_stderr_adds_nothing() {
        assert_eq!(excerpt("   \n\t "), "");
    }

    #[test]
    fn a_short_stderr_is_quoted_whole() {
        assert_eq!(excerpt("boom\nbang\n"), " - it said: boom bang");
    }

    #[test]
    fn a_long_stderr_is_capped() {
        let noise = "x".repeat(STDERR_EXCERPT * 3);
        let quoted = excerpt(&noise);
        assert!(quoted.starts_with(" - it ended with: ..."));
        assert!(quoted.chars().count() < STDERR_EXCERPT + 40);
    }

    #[test]
    fn the_repo_next_door_is_recognised() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        assert!(looks_like_repo(root));
        assert!(!looks_like_repo(Path::new(env!("CARGO_MANIFEST_DIR"))));
    }
}
