//! The system theme: inherit Windows rather than invent a palette.
//!
//! The user asked for the widget to take the taskbar's colour scheme, so this
//! module reads what Windows already stores and derives the eight colours the
//! stylesheet needs. Nothing here writes to the registry, talks to the
//! network, or looks at another tool's files.
//!
//! Colours are all it derives. The taskbar's *transparency* is deliberately
//! not inherited - see the effects section below for what that cost and why.
//!
//! # Byte order
//!
//! The DWM colour DWORDs are **ABGR**, not ARGB. `0xFF484A4C` is
//! `A=FF B=48 G=4A R=4C`, i.e. `#4c4a48` - a warm grey. Reading it as ARGB
//! gives `#484a4c`, a cold blue-grey, and every colour derived from it
//! inherits the mistake. `ColorizationColor`, in the same key, *is* ARGB. The
//! two are not interchangeable, so `abgr` and `argb` below are deliberately
//! separate functions with a test pinning each.
//!
//! # Contrast
//!
//! Text is not chosen from the dark-mode flag. A user can run dark apps with a
//! light accent, and `StartColorMenu` - the card ground - follows the accent,
//! not the flag. So the text pair is computed from the *card's* measured
//! relative luminance and checked against WCAG: 4.5:1 for body text, 3:1 for
//! the dimmed secondary. `text_pair` cannot return a pair that fails, and a
//! test sweeps the whole grey ramp plus an RGB cube to keep it that way.
//!
//! # Failure
//!
//! Every read is allowed to fail. A missing key, a `REG_SZ` where a `DWORD`
//! was expected, a hive we may not open - each falls back to the value baked
//! into `panel.css` and is noted in the log once. A widget must never fail to
//! paint because a theme lookup went wrong.

use serde::Serialize;

use crate::log;

/* ------------------------------------------------------------- colour -- */

/// An opaque sRGB colour. Alpha is deliberately absent: every value this
/// module hands the frontend is a solid `#rrggbb`, and transparency is carried
/// by the compositor effect, not by a colour channel.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Rgb {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

impl Rgb {
    pub const WHITE: Rgb = Rgb::new(0xff, 0xff, 0xff);
    pub const BLACK: Rgb = Rgb::new(0x00, 0x00, 0x00);

    pub const fn new(r: u8, g: u8, b: u8) -> Self {
        Self { r, g, b }
    }

    /// Lowercase `#rrggbb`, which is what the CSS custom properties expect.
    pub fn hex(self) -> String {
        format!("#{:02x}{:02x}{:02x}", self.r, self.g, self.b)
    }

    fn min_channel(self) -> u8 {
        self.r.min(self.g).min(self.b)
    }
}

/// Decode a DWM colour DWORD, which is stored **ABGR**.
///
/// `AccentColor`, `AccentColorMenu` and `StartColorMenu` all use this layout.
/// The alpha byte is discarded: these are opaque paints.
pub fn abgr(value: u32) -> Rgb {
    Rgb::new(
        (value & 0xff) as u8,
        ((value >> 8) & 0xff) as u8,
        ((value >> 16) & 0xff) as u8,
    )
}

/// Decode an ARGB colour DWORD. `ColorizationColor` uses this layout - the
/// opposite of its neighbour `AccentColor` in the very same key.
pub fn argb(value: u32) -> Rgb {
    Rgb::new(
        ((value >> 16) & 0xff) as u8,
        ((value >> 8) & 0xff) as u8,
        (value & 0xff) as u8,
    )
}

/// Linear-light value of one sRGB channel, per WCAG 2.x.
fn linearize(channel: u8) -> f64 {
    let s = f64::from(channel) / 255.0;
    if s <= 0.040_45 {
        s / 12.92
    } else {
        ((s + 0.055) / 1.055).powf(2.4)
    }
}

/// WCAG relative luminance. 0.0 for black, 1.0 for white.
pub fn relative_luminance(colour: Rgb) -> f64 {
    0.2126 * linearize(colour.r) + 0.7152 * linearize(colour.g) + 0.0722 * linearize(colour.b)
}

/// WCAG contrast ratio, from 1.0 (identical) to 21.0 (black on white).
pub fn contrast_ratio(a: Rgb, b: Rgb) -> f64 {
    let (la, lb) = (relative_luminance(a), relative_luminance(b));
    let (hi, lo) = if la >= lb { (la, lb) } else { (lb, la) };
    (hi + 0.05) / (lo + 0.05)
}

/// Blend `a` toward `b`. `t` is clamped to 0..=1.
fn mix(a: Rgb, b: Rgb, t: f64) -> Rgb {
    let t = t.clamp(0.0, 1.0);
    let lerp = |x: u8, y: u8| (f64::from(x) + (f64::from(y) - f64::from(x)) * t).round() as u8;
    Rgb::new(lerp(a.r, b.r), lerp(a.g, b.g), lerp(a.b, b.b))
}

/// Move every channel by `delta`, saturating. Additive rather than
/// multiplicative because multiplying a near-black card by 0.9 does nothing
/// visible, and the recess has to be visible.
fn shift(colour: Rgb, delta: i16) -> Rgb {
    let step = |c: u8| (i16::from(c) + delta).clamp(0, 255) as u8;
    Rgb::new(step(colour.r), step(colour.g), step(colour.b))
}

/// The panel's inner surface, and the groove a bar sits in.
///
/// Normally the recess is *darker* than the card, which is what the design
/// does and what a light card wants too. The exception is a card already
/// pressed against black, where darkening is a no-op and the only way to make
/// the recess visible is to lighten it. Keyed off the card's own channels, not
/// off the dark-mode flag, for the same reason the text pair is.
fn recess(base: Rgb, amount: i16) -> Rgb {
    if base.min_channel() >= 16 {
        shift(base, -amount)
    } else {
        shift(base, amount)
    }
}

/// WCAG AA for body text.
pub const TEXT_MIN_CONTRAST: f64 = 4.5;
/// WCAG AA for large or secondary text. The dimmed row labels live here.
pub const TEXT_DIM_MIN_CONTRAST: f64 = 3.0;

/// Pick `(text, textDim)` that actually read against `base`.
///
/// The warm off-white and warm near-black are the design's own ink. If neither
/// clears 4.5:1 - which only happens on a mid-tone card - we fall back to pure
/// white or pure black, one of which always clears about 4.58:1 against *any*
/// colour. The dim tone is then walked back toward the card as far as 3:1
/// allows, so it is as quiet as it can be while still being legible.
pub fn text_pair(base: Rgb) -> (Rgb, Rgb) {
    const WARM_LIGHT: Rgb = Rgb::new(0xf2, 0xef, 0xea);
    const WARM_DARK: Rgb = Rgb::new(0x1a, 0x18, 0x15);

    let better = |a: Rgb, b: Rgb| {
        if contrast_ratio(a, base) >= contrast_ratio(b, base) {
            a
        } else {
            b
        }
    };

    let mut text = better(WARM_LIGHT, WARM_DARK);
    if contrast_ratio(text, base) < TEXT_MIN_CONTRAST {
        text = better(Rgb::WHITE, Rgb::BLACK);
    }

    // Contrast falls monotonically as the ink is mixed into the card, so the
    // first candidate that dips below 3:1 is the stopping point. The candidate
    // itself is what gets returned, so the measurement is of the real value
    // after rounding to bytes, not of an idealised one.
    let mut dim = text;
    let mut t = 0.0;
    const STEP: f64 = 0.02;
    const CEILING: f64 = 0.80;
    while t + STEP <= CEILING {
        let candidate = mix(text, base, t + STEP);
        if contrast_ratio(candidate, base) < TEXT_DIM_MIN_CONTRAST {
            break;
        }
        t += STEP;
        dim = candidate;
    }

    (text, dim)
}

/* ------------------------------------------------------------ palette -- */

/// The design's own tokens, from `ui/panel.css`. Used whenever the registry
/// cannot tell us better, so an unreadable hive degrades to the shipped look
/// rather than to something arbitrary.
pub const DEFAULT_ACCENT: Rgb = Rgb::new(0xe8, 0x76, 0x3c);
pub const DEFAULT_BASE: Rgb = Rgb::new(0x38, 0x36, 0x33);

/// The raw DWORDs, exactly as the registry holds them. `None` means the key
/// was absent, the wrong type, or unreadable - the three are indistinguishable
/// to a caller and are treated identically.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RawTheme {
    /// `Personalize\AppsUseLightTheme`. 0 means dark.
    pub apps_use_light_theme: Option<u32>,
    /// `DWM\AccentColor`, ABGR.
    pub accent_color: Option<u32>,
    /// `Explorer\Accent\AccentColorMenu`, ABGR.
    pub accent_color_menu: Option<u32>,
    /// `Explorer\Accent\StartColorMenu`, ABGR. This is the Start and taskbar
    /// ground, and is what the card should sit next to.
    pub start_color_menu: Option<u32>,
    /// `DWM\ColorizationColor`, ARGB. Last-ditch accent source.
    pub colorization_color: Option<u32>,
}

/// What `system_theme` hands the frontend. Every field is filled; the
/// stylesheet treats them as overrides for its own tokens.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemTheme {
    pub dark: bool,
    pub accent: String,
    pub accent_soft: String,
    pub base: String,
    pub surface: String,
    pub track: String,
    pub text: String,
    pub text_dim: String,
}

/// Turn raw registry DWORDs into the palette. Pure, so it can be tested
/// without a registry.
pub fn derive(raw: RawTheme) -> SystemTheme {
    // Missing means dark: the widget is a dark-first design, and a light card
    // arrived at by accident would be the worse guess.
    let dark = raw.apps_use_light_theme.map(|v| v == 0).unwrap_or(true);
    let system_accent = raw
        .accent_color
        .or(raw.accent_color_menu)
        .map(abgr)
        .or_else(|| raw.colorization_color.map(argb));
    let accent = system_accent.unwrap_or(DEFAULT_ACCENT);

    // Slightly lifted, for the warn state. Not a different hue: escalation is
    // carried by the bar filling up, as the design has it.
    let accent_soft = mix(accent, Rgb::WHITE, 0.18);

    let base = match (raw.start_color_menu.map(abgr), system_accent) {
        // What Explorer paints behind Start. The card then matches the taskbar
        // by construction rather than by guesswork.
        (Some(start), _) => start,
        // No Start colour, but a real accent: the taskbar under
        // ColorPrevalence is roughly the accent taken down, so do that.
        (None, Some(accent)) => mix(accent, Rgb::BLACK, 0.34),
        // Nothing readable at all. Ship the design's charcoal rather than a
        // darkened fallback orange.
        (None, None) => DEFAULT_BASE,
    };

    let (text, text_dim) = text_pair(base);

    SystemTheme {
        dark,
        accent: accent.hex(),
        accent_soft: accent_soft.hex(),
        base: base.hex(),
        surface: recess(base, 12).hex(),
        track: recess(base, 18).hex(),
        text: text.hex(),
        text_dim: text_dim.hex(),
    }
}

/* ----------------------------------------------------------- registry -- */

#[cfg(windows)]
const PERSONALIZE: &str = r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";
#[cfg(windows)]
const DWM: &str = r"Software\Microsoft\Windows\DWM";
#[cfg(windows)]
const EXPLORER_ACCENT: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\Accent";

/// Read HKCU. Read only, and every failure is a `None`.
#[cfg(windows)]
pub fn read_raw() -> RawTheme {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
    use winreg::RegKey;

    // KEY_READ spelled out rather than left to `open_subkey`'s default, so the
    // read-only intent is visible at the call site. Nothing in this crate ever
    // opens a key for writing.
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let open = |path: &str| hkcu.open_subkey_with_flags(path, KEY_READ).ok();
    let dword = |key: &Option<RegKey>, name: &str| -> Option<u32> {
        // `get_value::<u32>` on a REG_SZ is an error, not a panic, so a
        // wrong-typed value lands in the same place as an absent one.
        key.as_ref()?.get_value::<u32, _>(name).ok()
    };

    let personalize = open(PERSONALIZE);
    let dwm = open(DWM);
    let explorer = open(EXPLORER_ACCENT);

    let raw = RawTheme {
        apps_use_light_theme: dword(&personalize, "AppsUseLightTheme"),
        accent_color: dword(&dwm, "AccentColor"),
        accent_color_menu: dword(&explorer, "AccentColorMenu"),
        start_color_menu: dword(&explorer, "StartColorMenu"),
        colorization_color: dword(&dwm, "ColorizationColor"),
    };

    report_gaps(&raw);
    raw
}

/// No registry off Windows, so the design defaults stand. The command still
/// answers, because a frontend that cannot theme itself must still paint.
#[cfg(not(windows))]
pub fn read_raw() -> RawTheme {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        log::line("no system theme source on this platform: using the design's own palette");
    });
    RawTheme::default()
}

/// Say once, rather than every thirty seconds, which values we could not read.
#[cfg(windows)]
fn report_gaps(raw: &RawTheme) {
    static ONCE: std::sync::Once = std::sync::Once::new();

    let mut missing = Vec::new();
    if raw.apps_use_light_theme.is_none() {
        missing.push("AppsUseLightTheme");
    }
    if raw.accent_color.is_none() && raw.accent_color_menu.is_none() {
        missing.push("AccentColor");
    }
    if raw.start_color_menu.is_none() {
        missing.push("StartColorMenu");
    }
    if missing.is_empty() {
        return;
    }

    let joined = missing.join(", ");
    ONCE.call_once(move || {
        log::line(&format!(
            "system theme: could not read {joined}; the built-in palette stands in for those"
        ));
    });
}

/* ------------------------------------------------------------ effects -- */

// There is deliberately NO mica and NO acrylic here, and putting one back is
// not a one-line change.
//
// Windows paints a compositor backdrop across the whole window RECTANGLE. It
// knows nothing about the 16px corners the card draws, and the window has to
// be transparent for those corners to exist at all - so the backdrop filled
// the corner regions the rounding leaves empty, and the widget sat on a dark
// square slab. That is exactly what it looked like on build 19045: a rounded
// card on a square block, reported as a rendering fault, which is what it was.
//
// The card also had to go translucent to let the blur through, so the slab
// showed through the card's own colour as well - the fault was visible across
// the whole widget, not only at its corners.
//
// Windows 10 offers no way to clip that backdrop to a rounded shape.
// SetWindowRgn is the only lever and it hard-clips, so it trades a squared
// corner for a stair-stepped one. Windows 11's own rounding is 8px on all four
// corners, which is neither the card's 16px nor the corners it squares off
// against the bezel.
//
// So the card paints its own opaque ground and owns its shape. If a blur ever
// comes back it has to arrive with a shape story for BOTH windows, and one
// that survives the strip expanding, the dock moving to another edge, and the
// corners the page squares off where it meets the screen.

/// Parse `#rrggbb` back out of the palette, on a string this module produced.
/// The palette leaves as hex and comes back as channels only here, where the
/// tests check contrast against what the frontend was actually handed.
#[cfg(test)]
fn parse_hex(value: &str) -> Option<Rgb> {
    let digits = value.strip_prefix('#')?;
    if digits.len() != 6 || !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    Some(Rgb::new(
        u8::from_str_radix(&digits[0..2], 16).ok()?,
        u8::from_str_radix(&digits[2..4], 16).ok()?,
        u8::from_str_radix(&digits[4..6], 16).ok()?,
    ))
}

/* ------------------------------------------------------------ command -- */

/// The palette as it stands right now.
pub fn current() -> SystemTheme {
    derive(read_raw())
}

/// Hand the frontend the Windows colour scheme.
///
/// Never returns an error: a theme lookup is not allowed to stop the widget
/// painting, so every failure inside becomes a documented default. index.html
/// polls this every 30 seconds, so it runs on a blocking-pool thread rather
/// than on the UI thread - four HKCU opens are microseconds, but "cheap" and
/// "never on the thread that draws" are different promises and both were
/// asked for.
#[tauri::command]
pub async fn system_theme() -> SystemTheme {
    let theme = match tauri::async_runtime::spawn_blocking(current).await {
        Ok(theme) => theme,
        Err(error) => {
            log::line(&format!(
                "the system theme read did not finish ({error}); using the built-in palette"
            ));
            derive(RawTheme::default())
        }
    };

    report_delivery(&theme);
    theme
}

/// Record what actually went over IPC - the first time, and thereafter only
/// when it changes.
///
/// The poll runs every thirty seconds, so logging unconditionally would bury
/// everything else. Logging nothing, though, leaves no way to tell "the
/// frontend is themed from Windows" apart from "the frontend fell back to the
/// stylesheet defaults and swallowed the error", which are the two states this
/// command sits between. A change is worth a line too: it is the only trace
/// left when someone repaints their accent while the widget is running.
fn report_delivery(theme: &SystemTheme) {
    static LAST: std::sync::Mutex<Option<SystemTheme>> = std::sync::Mutex::new(None);

    // A poisoned mutex here would mean a previous logging call panicked. That
    // is not a reason to stop answering the frontend, so the log is skipped.
    let Ok(mut last) = LAST.lock() else { return };
    if last.as_ref() == Some(theme) {
        return;
    }

    log::line(&format!(
        "system_theme -> frontend: {} card {} on a {} accent (surface {}, track {}, text {} / {})",
        if theme.dark { "dark" } else { "light" },
        theme.base,
        theme.accent,
        theme.surface,
        theme.track,
        theme.text,
        theme.text_dim,
    ));
    *last = Some(theme.clone());
}

/* -------------------------------------------------------------- tests -- */

#[cfg(test)]
mod tests {
    use super::*;

    /// The exact DWORDs on the machine this was written against.
    const MACHINE_ACCENT: u32 = 0xFF48_4A4C;
    const MACHINE_START: u32 = 0xFF33_3536;
    const MACHINE_COLORIZATION: u32 = 0xC44C_4A48;

    #[test]
    fn abgr_decodes_the_machine_accent() {
        // The whole point of this file. 0xFF484A4C is a warm grey, not a cold
        // one; if this flips, every colour derived from it flips with it.
        assert_eq!(abgr(MACHINE_ACCENT).hex(), "#4c4a48");
    }

    #[test]
    fn abgr_and_argb_are_not_interchangeable() {
        // Same DWORD, two layouts, two different colours. ColorizationColor
        // sits in the same key as AccentColor and is ARGB.
        assert_eq!(argb(MACHINE_ACCENT).hex(), "#484a4c");
        assert_ne!(abgr(MACHINE_ACCENT), argb(MACHINE_ACCENT));
    }

    #[test]
    fn start_color_menu_decodes_to_the_taskbar_charcoal() {
        assert_eq!(abgr(MACHINE_START).hex(), "#363533");
    }

    #[test]
    fn hex_is_lowercase_and_zero_padded() {
        assert_eq!(Rgb::new(0, 10, 255).hex(), "#000aff");
        assert_eq!(Rgb::WHITE.hex(), "#ffffff");
        assert_eq!(Rgb::BLACK.hex(), "#000000");
    }

    #[test]
    fn luminance_spans_black_to_white() {
        assert!(relative_luminance(Rgb::BLACK).abs() < 1e-9);
        assert!((relative_luminance(Rgb::WHITE) - 1.0).abs() < 1e-9);
        assert!((contrast_ratio(Rgb::BLACK, Rgb::WHITE) - 21.0).abs() < 1e-6);
        assert!((contrast_ratio(Rgb::WHITE, Rgb::WHITE) - 1.0).abs() < 1e-9);
    }

    /// Every colour the picker can be handed, not just the plausible ones.
    fn colour_sweep() -> Vec<Rgb> {
        let mut bases = Vec::new();
        // The whole grey ramp, which is where the 4.5:1 floor is tightest.
        for v in 0..=255u16 {
            bases.push(Rgb::new(v as u8, v as u8, v as u8));
        }
        // A coarse RGB cube on top: a saturated accent is exactly where a
        // naive "dark mode means white text" rule breaks.
        for r in (0..=255u16).step_by(17) {
            for g in (0..=255u16).step_by(17) {
                for b in (0..=255u16).step_by(51) {
                    bases.push(Rgb::new(r as u8, g as u8, b as u8));
                }
            }
        }
        bases.push(abgr(MACHINE_START));
        bases.push(abgr(MACHINE_ACCENT));
        bases.push(DEFAULT_BASE);
        bases
    }

    #[test]
    fn the_text_pair_always_clears_wcag() {
        for base in colour_sweep() {
            let (text, dim) = text_pair(base);
            let ct = contrast_ratio(text, base);
            let cd = contrast_ratio(dim, base);
            assert!(
                ct >= TEXT_MIN_CONTRAST,
                "text {} on {} is only {ct:.2}:1",
                text.hex(),
                base.hex()
            );
            assert!(
                cd >= TEXT_DIM_MIN_CONTRAST,
                "dim {} on {} is only {cd:.2}:1",
                dim.hex(),
                base.hex()
            );
            // Dim means dimmer. Equal is allowed only on the mid-tones, where
            // there is no headroom to give away.
            assert!(cd <= ct + 1e-9, "dim outshone text on {}", base.hex());
        }
    }

    #[test]
    fn text_follows_the_card_not_the_dark_mode_flag() {
        // Dark apps, light accent: the honest answer is dark ink on a light
        // card, which a flag-driven picker would get exactly backwards.
        let light_card = RawTheme {
            apps_use_light_theme: Some(0),
            start_color_menu: Some(0xFFEE_F0F2), // ABGR -> #f2f0ee
            ..RawTheme::default()
        };
        let theme = derive(light_card);
        assert!(theme.dark, "the flag is reported as the system set it");
        assert_eq!(theme.base, "#f2f0ee");

        let base = parse_hex(&theme.base).unwrap();
        let text = parse_hex(&theme.text).unwrap();
        assert!(
            relative_luminance(text) < relative_luminance(base),
            "a light card needs dark ink, got {}",
            theme.text
        );
        assert!(contrast_ratio(text, base) >= TEXT_MIN_CONTRAST);
        assert!(
            contrast_ratio(parse_hex(&theme.text_dim).unwrap(), base) >= TEXT_DIM_MIN_CONTRAST
        );
    }

    #[test]
    fn the_recess_stays_visible_against_any_card() {
        for base in colour_sweep() {
            let surface = recess(base, 12);
            let track = recess(base, 18);
            assert_ne!(surface, base, "surface vanished into {}", base.hex());
            assert_ne!(track, base, "track vanished into {}", base.hex());
            assert_ne!(track, surface, "track and surface collapsed on {}", base.hex());
        }
        // Pressed against black there is nowhere to go but up.
        assert_eq!(recess(Rgb::BLACK, 12).hex(), "#0c0c0c");
        // Everywhere else the recess is a shadow, as the design has it.
        assert_eq!(recess(DEFAULT_BASE, 12).hex(), "#2c2a27");
    }

    #[test]
    fn this_machine_derives_the_expected_palette() {
        // Exactly what the registry holds on the machine this was built for.
        let raw = RawTheme {
            apps_use_light_theme: Some(0),
            accent_color: Some(MACHINE_ACCENT),
            accent_color_menu: Some(MACHINE_ACCENT),
            start_color_menu: Some(MACHINE_START),
            colorization_color: Some(MACHINE_COLORIZATION),
        };
        let theme = derive(raw);

        assert!(theme.dark);
        // The whole palette, pinned. If a future edit changes any of these the
        // widget stops matching the taskbar, and that is worth being told
        // about rather than discovering by eye.
        assert_eq!(theme.accent, "#4c4a48");
        assert_eq!(theme.accent_soft, "#6c6b69");
        assert_eq!(theme.base, "#363533");
        assert_eq!(theme.surface, "#2a2927");
        assert_eq!(theme.track, "#242321");
        assert_eq!(theme.text, "#f2efea");
        assert_eq!(theme.text_dim, "#817f7c");

        // The taskbar charcoal lands within a couple of steps of the design's
        // own #383633, which is the whole reason StartColorMenu is preferred
        // over a darkened accent.
        let base = parse_hex(&theme.base).unwrap();
        assert!((i16::from(base.r) - i16::from(DEFAULT_BASE.r)).abs() < 8);

        let accent = parse_hex(&theme.accent).unwrap();
        let soft = parse_hex(&theme.accent_soft).unwrap();
        assert!(
            relative_luminance(soft) > relative_luminance(accent),
            "accentSoft must be the lifted one"
        );
    }

    #[test]
    fn colorization_color_is_the_last_resort_accent() {
        // No AccentColor anywhere, but DWM still has a colorization value. It
        // is ARGB, so 0xC44C4A48 is #4c4a48 - the same colour the ABGR
        // AccentColor encodes, spelled the other way round. Decoding it with
        // `abgr` would give #484a4c and quietly cool the whole palette.
        let raw = RawTheme {
            colorization_color: Some(MACHINE_COLORIZATION),
            ..RawTheme::default()
        };
        assert_eq!(derive(raw).accent, "#4c4a48");
    }

    #[test]
    fn an_absent_key_falls_back_to_the_design() {
        // Every key absent, wrong-typed, or unreadable: all three arrive here
        // as None, and none of them may fail the command.
        let theme = derive(RawTheme::default());
        assert_eq!(theme.accent, DEFAULT_ACCENT.hex());
        assert_eq!(theme.base, DEFAULT_BASE.hex());
        assert_eq!(theme.surface, "#2c2a27");
        // Dark-first design unless we know otherwise.
        assert!(theme.dark);

        let base = parse_hex(&theme.base).unwrap();
        assert!(contrast_ratio(parse_hex(&theme.text).unwrap(), base) >= TEXT_MIN_CONTRAST);
        assert!(
            contrast_ratio(parse_hex(&theme.text_dim).unwrap(), base) >= TEXT_DIM_MIN_CONTRAST
        );
    }

    #[test]
    fn a_partial_read_still_yields_a_whole_palette() {
        // Personalize readable, Explorer\Accent not. The card is then derived
        // from the accent instead of from StartColorMenu.
        let raw = RawTheme {
            apps_use_light_theme: Some(1),
            accent_color: Some(MACHINE_ACCENT),
            ..RawTheme::default()
        };
        let theme = derive(raw);
        assert!(!theme.dark);
        assert_eq!(theme.accent, "#4c4a48");
        // #4c4a48 taken 34% toward black, which is roughly what Explorer
        // paints behind Start when ColorPrevalence is on.
        assert_eq!(theme.base, "#323130");
        for field in [&theme.surface, &theme.track, &theme.text, &theme.text_dim] {
            assert!(parse_hex(field).is_some(), "{field} is not #rrggbb");
        }
    }

    #[test]
    fn the_wire_shape_is_the_one_index_html_reads() {
        let json = serde_json::to_value(derive(RawTheme::default())).unwrap();
        for key in [
            "dark",
            "accent",
            "accentSoft",
            "base",
            "surface",
            "track",
            "text",
            "textDim",
        ] {
            assert!(json.get(key).is_some(), "missing {key} in {json}");
        }
        assert!(json["dark"].is_boolean());
    }

    #[test]
    fn the_delivery_log_is_quiet_on_a_repeat_and_never_panics() {
        // The frontend polls every thirty seconds, so this runs hundreds of
        // times a day. It must survive being handed the same palette over and
        // over, and must not poison its own mutex when it does.
        let theme = derive(RawTheme::default());
        report_delivery(&theme);
        report_delivery(&theme);
        report_delivery(&derive(RawTheme {
            accent_color: Some(0xFF48_4A4C),
            ..RawTheme::default()
        }));
        report_delivery(&theme);
    }

    #[test]
    fn the_payload_carries_no_transparency_switch() {
        // The card always paints its own ground, because a compositor backdrop
        // cannot be clipped to its rounded corners - see the effects section.
        // A flag here is how the page would be told to stop painting, so the
        // absence of one is the thing worth pinning.
        let json = serde_json::to_value(derive(RawTheme::default())).unwrap();
        assert!(json.get("transparency").is_none(), "no transparency switch: {json}");
    }

    #[test]
    fn parse_hex_rejects_nonsense() {
        assert!(parse_hex("4c4a48").is_none());
        assert!(parse_hex("#4c4a4").is_none());
        assert!(parse_hex("#gggggg").is_none());
        assert_eq!(parse_hex("#4c4a48"), Some(Rgb::new(0x4c, 0x4a, 0x48)));
    }

    #[test]
    fn reading_the_real_registry_never_panics() {
        // Whatever this machine actually holds, the command's core has to
        // return a complete, well-formed, legible palette.
        let theme = current();
        for field in [
            &theme.accent,
            &theme.accent_soft,
            &theme.base,
            &theme.surface,
            &theme.track,
            &theme.text,
            &theme.text_dim,
        ] {
            assert!(parse_hex(field).is_some(), "{field} is not #rrggbb");
        }
        let base = parse_hex(&theme.base).unwrap();
        assert!(contrast_ratio(parse_hex(&theme.text).unwrap(), base) >= TEXT_MIN_CONTRAST);
        assert!(
            contrast_ratio(parse_hex(&theme.text_dim).unwrap(), base) >= TEXT_DIM_MIN_CONTRAST
        );
    }
}
