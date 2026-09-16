# The files in this directory are not ours

Each one is a vendor's own logo, copied unmodified from the brand pack that
vendor publishes. They are **not** covered by this project's MIT licence — see
[LICENSE](../../LICENSE) and [TRADEMARKS.md](../../TRADEMARKS.md).

| File | Mark | Taken from |
| --- | --- | --- |
| `claude-code.svg` | Claude, monochrome | Anthropic's Claude mark, the `currentColor` variant |
| `codex.svg` | OpenAI Blossom, white | OpenAI brand pack, `OAI_OpenAI-Blossom_White.svg` |
| `copilot.svg` | GitHub Invertocat, white | GitHub brand pack, `GitHub_Invertocat_White.svg` |
| `cursor.png` | Cursor square avatar, 2D for dark grounds | Cursor brand pack, `AVATAR_SQUARE_2D_DARK.png` |
| `devin.svg` | Devin square avatar, white | Cognition brand pack, `DEVIN_AVATAR_SQUARE_WHITE.svg` |

## How they are used

They identify whose usage a row is reporting, and nothing else. GitHub states
the permission most plainly, and the others' guidelines agree in substance:

> Use a permitted GitHub logo to inform others that your project integrates
> with GitHub.

The conditions that come with that are why this directory exists at all, rather
than the marks being inlined into `panel.js`:

- **Unmodified geometry.** Byte for byte as published, with one narrow
  exception: `claude-code.svg` is the variant Anthropic publishes with
  `fill="currentColor"` — a colour slot the consumer is meant to fill — and it
  is filled with white, over their own clay (`#D97757`). That is the treatment
  Anthropic gives the mark themselves. No path data is touched in any file.
- **Nothing cropped, stretched or combined.** They are drawn from a file through
  `<img>`, so a stylesheet cannot tint one by accident, and `object-fit:
  contain` means a badge can never crop one. Only the chip underneath is ours.
- **Not our identity.** They appear as row labels, beside our own bars and
  inside our own window. quota-monitor's identity is its own.
- **No endorsement implied.** This project is independent of all of them.

## If a vendor would rather we did not

Open an issue and we will remove it. Replacing one is a file swap and a line in
`MARKS`; an adapter whose mark is removed falls back to initials, which is what
an unknown provider already gets.

## Why these variants

Each brand ships several, and a 22px square decides between them:

- **Cursor** publishes SVGs only for the cube, in a 466x532 portrait canvas -
  which cannot be centred in a square badge. Their square avatar is a PNG, so
  that is what this uses; at 22 and 44px a 1024px raster is ample.
- **GitHub** deprecated the standalone Copilot icon in 2025. Their current
  identity for the product is the Invertocat with a wordmark, and a wordmark is
  unreadable at this size - so the badge carries the Invertocat and the row
  label beside it carries the word Copilot.
- **OpenAI's** Blossom is drawn at 51% of its own canvas, so it is given a box
  larger than the badge and clipped to it. The file is untouched.

## Keeping them current

A logo changes when its owner changes it. If a mark here stops matching the
vendor's brand pack, it is stale and should be re-copied from the source named
above — not redrawn.
