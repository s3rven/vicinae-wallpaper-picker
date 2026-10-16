# vicinae-wallpaper-picker

A [Vicinae](https://vicinae.com) extension that picks a wallpaper and themes
your desktop from it with [matugen](https://github.com/InioX/matugen).

Pick a wallpaper from a thumbnail grid, choose one of its palettes (or a muted
accent of your own), and awww animates the change while matugen re-renders
every template in your config.

> Built for my own Hyprland + matugen setup and shared as-is. It should work
> anywhere Vicinae, matugen and awww run; everything else is optional and skipped
> when missing. Issues and PRs welcome, no promises.

## Features

- Thumbnail grid with search, favourites, collections (subfolders) and colour
  filters; sort by date added, name or colour.
- Palette step: up to four palettes extracted from the image, previewed before
  you apply. The palette you preview is exactly the one you get.
- Accent picker: muted named accents, any hex or colour name (`teal`, `#4488ff`,
  `48f`), saved accents, and a pinned accent that survives wallpaper changes.
- Neutral mode: switch to a second matugen config (for example grey surfaces
  with the wallpaper accent).
- "Set wallpaper, keep current theme", random wallpaper from the current filter.
- awww transitions (spotlight, iris, wave, wipe, fade), fit and crop anchor.
- Safe applies: serialised by a lock, rolled back if matugen fails, and you get a
  desktop notification instead of a silent failure.
- Fast: thumbnails and palettes are cached, the grid paints from cache instantly.

## Requirements

| Needed | What for |
|---|---|
| [Vicinae](https://vicinae.com) with its extension runtime (Node) | the UI |
| [matugen](https://github.com/InioX/matugen) 4.x | theme generation |
| [awww](https://codeberg.org/LGFae/awww) (formerly swww) | setting the wallpaper |
| ImageMagick (`magick` or `convert`) | thumbnails and colour hints |
| bash, `flock` (util-linux), coreutils | the backend scripts |

Optional: `jq` (faster palette parsing, falls back to `python3`), `python3`
(per-monitor routing), `hyprctl`, `kitty`, `notify-send`.

## Install

```bash
git clone https://github.com/s3rven/vicinae-wallpaper-picker
cd vicinae-wallpaper-picker/vicinae
npm install
npm run build        # installs into ~/.local/share/vicinae/extensions
```

The build bundles the shell scripts into the extension, so the clone can live
anywhere. Run **Set Wallpaper** from Vicinae, or bind it, for example in Hyprland:

```
bind = SUPER SHIFT, W, exec, vicinae cmd launch @silent/wallpaper-picker:set-wallpaper
```

Wallpapers are read from `~/Pictures/wallpaper` by default; pick another folder
in the extension preferences.

### Restore the wallpaper on login

awww does not remember your fit or blackout outputs, so restore the last pick
from your compositor's autostart:

```
exec-once = ~/.local/share/vicinae/extensions/wallpaper-picker/assets/backend/restore-wallpaper.sh
```

It starts `awww-daemon` if needed and waits for it.

### matugen

The picker runs `matugen` with `~/.config/matugen/config.toml` (override with
`MATUGEN_CONFIG`). Whatever templates that config renders are what gets themed.

- **Neutral mode** uses `~/.config/matugen/config-neutral.toml`
  (`MATUGEN_NEUTRAL_CONFIG`) when it exists; otherwise the toggle does nothing.
- **"Current" markers** in the palette step read `primary` from
  `~/.local/state/theme/generated/colors.json`. Add a matugen template that
  writes it if you want them:

  ```toml
  [templates.colors]
  input_path = '~/.config/matugen/templates/colors.json'   # {"primary": "{{colors.primary.default.hex}}"}
  output_path = '~/.local/state/theme/generated/colors.json'
  ```

- If your config has `kitty`, `cava`, `hyprland` or `hyprlock` templates, those
  apps are reloaded after an apply.

## Local settings

Machine-specific settings go in `~/.config/wallpaper-picker/env`, a plain shell
file sourced by the scripts. Every variable is optional.

| Variable | Effect |
|---|---|
| `AWWW_BLACKOUT_MATCH` | Regex (case-insensitive) on monitor name + description. Matching outputs get a flat fill instead of the wallpaper, e.g. a portrait side panel. Hyprland only. |
| `AWWW_BLACKOUT_COLOR` | Fill colour for those outputs (default `0x000000`). |
| `WALLPAPER_PICKER_HYPR_RELOAD` | Command used to reload Hyprland after a theme change (default `hyprctl reload config-only`). |
| `WALLPAPER_PICKER_POST_APPLY` | Executable run after each themed apply with `neutral` or `colour` as its argument, for things templates cannot reach (a shell's IPC, a bar reload). Time-boxed to 5 s. |
| `MATUGEN_CONFIG`, `MATUGEN_NEUTRAL_CONFIG` | matugen config paths. |
| `WALLPAPER_TRANSITION_FPS`, `_ANGLE`, `_POS`, `_BEZIER`, `_WAVE`, `WALLPAPER_SCALING_FILTER` | Low-level awww transition overrides. |

Example:

```sh
AWWW_BLACKOUT_MATCH="portrait|DP-3"
WALLPAPER_PICKER_POST_APPLY="$HOME/.config/wallpaper-picker/post-apply.sh"
```

## Keys

Library grid:

| Key | Action |
|---|---|
| Enter | choose a palette (configurable) |
| Ctrl+Enter | apply with the dominant palette |
| Ctrl+Alt+Enter | set wallpaper, keep current theme |
| Ctrl+Shift+Enter | apply with your pinned accent |
| Ctrl+E | choose an accent |
| Ctrl+Shift+R | random wallpaper from the current filter |
| Ctrl+F | favourite |
| Ctrl+S | sort by |
| Ctrl+Shift+B | switch between search and browse mode |
| Ctrl+N | neutral mode on/off (next apply) |
| Ctrl+O | open full size |
| Ctrl+R | rescan |
| Ctrl+Shift+C | copy path |

Palette step:

| Key | Action |
|---|---|
| Enter | apply |
| Ctrl+E | wallpaper colours / muted accents |
| Ctrl+F | save / remove accent |
| Ctrl+N | neutral mode on/off |
| Ctrl+D | show / hide wallpaper preview |
| Ctrl+Shift+C | copy accent hex |

Ctrl+B is avoided on purpose: on Linux it opens Vicinae's action panel.

## Preferences

Columns, default sort, layout (flat or sections), start in search or browse
mode, Enter action, transition and its duration, fit and crop anchor, wallpaper
folder, scan depth, and whether to show the current wallpaper when it lives
outside the folder.

## Library

- **Collections** are subfolders. Folders named `archive` or `old` are hidden
  from the main view and get their own Archive filter.
- **Catalogue (optional):** a `.wallpaper-library.json` in the wallpaper folder
  adds titles, search tags, source links and resolution tooltips. Keys are paths
  relative to the folder:

  ```json
  {
    "version": 1,
    "wallpapers": {
      "Sci-Fi/wallhaven-abc123.jpg": {
        "title": "Rainy neon alley",
        "tags": ["city", "rain"],
        "source": "https://wallhaven.cc/w/abc123",
        "resolution": "3840x2160"
      }
    }
  }
  ```

  Wallhaven filenames get their source link automatically.
- Tiles show no filenames (most wallpaper names are ids); names stay searchable
  and appear in the tooltip.

## How it works

The extension is only the front end. Shell scripts do the work:

| Script | Job |
|---|---|
| `scan-wallpapers.sh` | walks the folder, maintains the thumbnail and colour cache |
| `scan-colors.sh` | extracts and caches the palettes for one wallpaper |
| `apply-wallpaper-theme.sh` | sends the wallpaper, runs matugen, saves state, reloads apps |
| `restore-wallpaper.sh` | re-applies the saved wallpaper at login or on hotplug |
| `thumb-lib.sh`, `awww-lib.sh` | shared thumbnail and awww routing helpers |

The scripts work on their own too:

```bash
./apply-wallpaper-theme.sh ~/Pictures/wallpaper/foo.jpg 0 soft-fade     # palette 0
./apply-wallpaper-theme.sh ~/Pictures/wallpaper/foo.jpg -1 none '#4488ff' # pinned accent
WALLPAPER_PICKER_WALLPAPER_ONLY=1 ./apply-wallpaper-theme.sh foo.jpg     # image only
```

State lives in `~/.local/state/wallpaper-picker/` (favourites, saved accents,
pinned accent, neutral flag, fit, `last-apply.log`). The current wallpaper path
is in `~/.local/state/theme/generated/wallpaper/path.txt`. Caches are in
`~/.cache/wallpaper-picker/`.

## Development

```bash
cd vicinae
npm run dev          # watch mode
npm test             # TS helpers + backend tests
npm run lint
npx tsc --noEmit
shellcheck -x -P .. ../*.sh
```

The backend tests use fake desktop tools and temporary state. They never set a
real wallpaper, generate a live theme or start a daemon.

## License

MIT
