# Trademarks

`quota-monitor` is an independent project. It is not affiliated with, endorsed
by, or supported by Anthropic, OpenAI, GitHub, Google, Cognition, or Anysphere.

## Product names

Claude, Claude Code, Codex, ChatGPT, GitHub Copilot, Gemini, Devin, Cursor and
every other product named in this repository are trademarks of their respective
owners. They are used here for one purpose: to identify which service a
particular reading came from. A tool that measures your Codex usage has to be
able to say the word "Codex".

## The icons

The provider marks in [ui/icons/](ui/icons/) **are** the vendors' own logos,
copied unmodified from the brand packs they publish:

| Provider | File | Source |
| --- | --- | --- |
| Claude Code | `claude-code.svg` | Anthropic's Claude mark, `currentColor` variant |
| OpenAI Codex | `codex.svg` | OpenAI brand pack, Blossom (white) |
| GitHub Copilot | `copilot.svg` | GitHub brand pack, Invertocat (white) |
| Cursor | `cursor.png` | Cursor brand pack, square avatar (2D, dark) |
| Devin | `devin.svg` | Cognition brand pack, square avatar (white) |

This reverses an earlier decision to draw our own approximations. The reason for
that decision was the licence, and the reason it changed is that the brands
publish these packs precisely so that others can identify their products.
GitHub's guidelines put the permission plainly:

> Use a permitted GitHub logo to inform others that your project integrates
> with GitHub.

**What that permission costs.** Every one of these guidelines says the same
three things, and the implementation is shaped by them:

- **Do not modify, including the colour.** The marks are loaded from files
  rather than inlined, so no stylesheet can tint one; `object-fit: contain`
  means a badge cannot crop one; and where a brand ships a light and a dark
  variant, the chip underneath is chosen to suit the variant rather than the
  variant being altered to suit the chip.
- **Do not use them as your own identity.** They label rows. quota-monitor's
  own icon, name and window are its own.
- **Do not imply endorsement.** This project is independent of all of them, as
  the top of this file says.

**They are not covered by the MIT licence.** The LICENSE file says so, and
[ui/icons/NOTICE.md](ui/icons/NOTICE.md) records where each file came from and
how to replace one. A vendor who would rather we did not carry their mark can
open an issue; removing one is a file and a line, and the row falls back to
initials.

**A note on accuracy over fidelity.** These render at 22 pixels. The marks that
survive that are the ones their owners drew for small use - an app icon or an
avatar - which is what was chosen in each case, rather than a lockup scaled
down until its wordmark is a smear.

## If you fork this

The MIT licence covers our code, including the icon geometry. It does not and
cannot grant you any right in a third party's trademark. If you redistribute or
rebrand this project, that is your responsibility to check, particularly if you
replace these drawings with official brand assets.

## Corrections

If you own one of these marks and something here is wrong, open an issue. We
would rather fix it than argue about it.
