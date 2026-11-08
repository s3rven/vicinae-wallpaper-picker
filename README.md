# Vicinae Wallpaper Picker

![Wallpaper Picker for Vicinae, showcasing a library of blue wallpapers](docs/images/wallpaper-picker-hero.png)

Browse and switch wallpapers from [Vicinae](https://vicinae.com). A thumbnail
grid for still images and live wallpapers, with favourites, collections, colour
filters and animated transitions through [awww](https://codeberg.org/LGFae/awww).

The picker sets wallpapers. Desktop theming is separate; an optional
[matugen example](examples/matugen/README.md) shows how to connect your own setup.

[Install](#install) · [Features](#features) · [Keys](#keys) · [Live wallpapers](#live-wallpapers) · [Troubleshooting](#troubleshooting)

## Install

Requires Linux, Vicinae and a Wayland compositor supported by awww, such as
Hyprland or Sway. This backend does not support X11, GNOME, KDE, macOS or Windows.

```sh
git clone https://github.com/s3rven/vicinae-wallpaper-picker
cd vicinae-wallpaper-picker
./install.sh
```

The installer checks dependencies, runs `npm ci` from the lockfile, and builds
into Vicinae's extension directory. It does not need sudo or edit your desktop
configuration.

1. Open **Set Wallpaper** in Vicinae.
2. Choose your wallpaper folder in the extension preferences. The default is
   `~/Pictures/wallpaper`; create it or select an existing folder.
3. Search or choose a collection, select an image, and press **Enter**.

Other installer options:

```sh
./install.sh --check                       # dependency check only
./install.sh --build-only                  # build to release/extension
./install.sh --output /path/to/extension   # build to a chosen directory
```

`--build-only` and `--output` can build on a headless Linux machine with
Node.js/npm. Installs and `--check` also check the desktop tools below.
`--check` cannot be combined with build/output options.

| Dependency | Purpose |
|---|---|
| Vicinae | Launcher and extension runtime |
| Node.js 22+ and npm | Build the extension |
| awww and awww-daemon | Set wallpapers and animate transitions |
| Bash 4.4+, coreutils, findutils, `flock` from util-linux | Backend scripts |
| ImageMagick (`magick` or `convert`), recommended | Small thumbnails and colour filters; stills work without it |
| matugen and jq, optional | Palette previews in the colour step |
| Python 3, optional for stills | Faster scans and Hyprland monitor routing |
| mpvpaper, ffmpeg, Python 3 and a systemd user session, optional | Live wallpapers |
| ffprobe, optional | Prepare downloaded videos with `import-live.sh` |
| notify-send, optional | Desktop error notifications |

The scripts are bundled with the extension; the source clone can live anywhere
or be removed after installation. The installer downloads npm dependencies.
The running picker makes no network requests; source links open only when you
choose **Open Source Page**.

### Update

From your source checkout:

```sh
git pull --ff-only
./install.sh
```

The installer rebuilds the extension from the lockfile. Your wallpaper library,
favourites and local settings are kept outside the checkout.

## Features

- Searchable thumbnail grid, favourites pinned first, and collections from
  subfolders. Archive/Old folders have their own filter.
- Filter by collection, colour, favourites, current wallpaper, live or still.
  **Ctrl+Shift+F** opens colour swatches with counts; combine a colour with a
  collection or favourites. Colour choices stay available while detection warms.
  Sort by colour, modification date or name; the picker remembers your filter
  and sort. Search matches names, titles, tags, folders and colour names.
  Exact names and words lead search results, with fuzzy matches below them.
  Flat layout keeps the chosen sort across folders; names sort naturally
  (for example, Night 2 before Night 10).
  Empty favourites and other library filters stay selected until you change them.
- Set a solid background from colour presets or a custom `#RGB` / `#RRGGBB`
  value with **Set Solid Colour**, in the launcher or the picker's action panel.
  The form remembers the last colour you submitted.
- Fast native fade, spotlight, iris, wave, directional wipe and random
  transitions. Change the effect and duration directly in the action panel;
  your choice also applies to Random and Previous Wallpaper.
- Set a random still from the current search and filter, or use **Random
  Wallpaper** on a keybind to shuffle the whole active library. Videos and the
  current wallpaper are excluded from random selection.
- **Previous Wallpaper** swaps between the last two successful choices.
- Live wallpapers with manual pause and automatic pause behind windows on
  Hyprland. Pause policy is configurable in the action panel.
- Open full size, reveal in the file manager, open a source link or copy a path.
- Cached thumbnails and colours, with background refresh while the grid is open.
  Stills first show a placeholder while their small preview is built, avoiding
  hundreds of full-size image loads on a new library. Without ImageMagick,
  still images continue to display directly.
  New videos first show a video icon while their preview is rendered, so opening
  a library does not wait for every clip to decode. Animated WebP previews use
  their first frame.
  Colours become available with each completed preview. Decoder timeouts and
  limited worker threads keep a damaged file from holding up the whole pass;
  malformed colour-cache entries are rebuilt automatically.
- Applies and login restores share a lock. Failed applies preserve the previous
  state and attempt to restore the previous image.
  Rapid choices keep the latest waiting selection instead of replaying every
  queued wallpaper change.

## Keys

| Key | Action |
|---|---|
| Enter | Choose a wallpaper's accent colour, then apply |
| Ctrl+Enter | Set immediately (or open colours when immediate apply is the default) |
| Ctrl+Shift+R | Random still from the current search/filter |
| Ctrl+F | Add/remove favourite |
| Ctrl+Shift+F | Filter by colour, within the current collection |
| Ctrl+S | Choose sort order |
| Ctrl+Shift+B | Switch search/browse mode |
| Ctrl+Shift+P | Pause/resume live wallpaper |
| Ctrl+O | Open full size |
| Ctrl+R | Rescan |
| Ctrl+Shift+C | Copy path |

You can also bind the no-window commands in your compositor. Hyprland example:

```ini
bind = SUPER SHIFT, W, exec, vicinae cmd launch @s3rven/wallpaper-picker:set-wallpaper
bind = SUPER ALT, W, exec, vicinae cmd launch @s3rven/wallpaper-picker:random-wallpaper
bind = SUPER ALT SHIFT, W, exec, vicinae cmd launch @s3rven/wallpaper-picker:previous-wallpaper
```

## Restore at login

The picker remembers the original path, fit and crop anchor. Add the bundled
restore script to your compositor's autostart. For the default data directory,
a Hyprland example is:

```ini
exec-once = ~/.local/share/vicinae/extensions/wallpaper-picker/assets/backend/restore-wallpaper.sh
```

For Sway, use `exec` with that script path. If you set `XDG_DATA_HOME`, use its
`vicinae/extensions/wallpaper-picker/assets/backend/restore-wallpaper.sh` path.
It starts awww-daemon when needed. Restoring does not run post-apply hooks.

## Transitions and colours

Open a wallpaper to choose its colours. **From This Wallpaper** lists up to four
matugen palettes of the image, each previewed with the accent, complement and
surface your theme will get; the preview reads the thumbnail cache and does not
generate themes. **Accents** are muted presets that stay pinned for later
wallpapers until you choose a palette again. Type a `#RGB` / `#RRGGBB` hex in the
search bar for a custom accent. Choices are sent to your optional theming hook.
Palette previews need matugen and jq; without them the list offers **Automatic**.
In preferences, **Wallpaper click action** can switch back to immediate apply;
Ctrl+Enter offers the other action. **Ctrl+R** reloads the palettes.
Collection counts follow the selected colour;
the gallery footer shows how many wallpapers match the current view.

Open the action panel and choose **Transition** to pick an effect or duration.
**Use Extension Defaults** returns both to the extension preferences. The
**None** effect changes images immediately.

Fade is the default, at 0.28 seconds. Wipes take about 0.32 seconds, wave
0.38 seconds, and circular reveals 0.4 seconds. All effects use awww directly,
with frame pacing matched to your display and a quick ease-out curve.
**Auto** picks the effect's tuned duration; choose 0.2 seconds for a shorter
animation. Existing Doom selections switch to Fade.

Colour filtering needs ImageMagick. While it detects a new library, the colour
menu keeps its swatches and updates their counts. A selected colour is kept
even if it currently has no matches; **All Colours** clears it without changing
the collection. **Clear Colour Filter** also clears it directly from the action
panel. **Copy Wallpaper Colour** copies an image's dominant hex value.

Solid colours are saved as small images in the picker's state directory, so
Previous Wallpaper, login restore and transitions work with them too.

## Local settings and hooks

Optional settings belong in
`${XDG_CONFIG_HOME:-$HOME/.config}/wallpaper-picker/env`.
Copy [examples/env.example](examples/env.example) as a starting point. This is
trusted shell code; keep your real settings outside the public repository.

| Variable | Effect |
|---|---|
| `AWWW_BLACKOUT_MATCH` | Optional case-insensitive regex matching Hyprland monitor names/descriptions. Those outputs get a solid colour. |
| `AWWW_BLACKOUT_COLOR` | Solid fill for matched outputs, default `0x000000`. |
| `WALLPAPER_PICKER_POST_APPLY` | Optional executable called with the original wallpaper path after a successful apply. Limited to ten seconds. |
| `WALLPAPER_LIVE_MPV_OPTIONS` | mpv options, default `no-audio loop hwdec=auto-safe panscan=1.0`. |
| `WALLPAPER_LIVE_EGL_VENDOR` | Optional glvnd vendor JSON for hybrid-GPU setups. |
| `WALLPAPER_LIVE_FPS`, `_MIN_LOOP`, `_SIZE`, `_DIR` | Frame-rate cap, minimum clip length, output size and destination for `import-live.sh`. |
| `WALLPAPER_TRANSITION_FPS`, `_ANGLE`, `_POS`, `_BEZIER`, `_WAVE`, `WALLPAPER_SCALING_FILTER` | Low-level awww options. |

A post-apply hook can run matugen or another tool. The picker does not generate
application themes, edit app configs or reload desktop applications. See the
[separate matugen setup example](examples/matugen/README.md). Hook failures
report an error while keeping the successfully set wallpaper.

Hooks receive `WALLPAPER_PICKER_ACCENT` with the selected or previously pinned
`#RRGGBB` seed, or an empty string for automatic image colours.
`WALLPAPER_PICKER_ACCENT_CHANGED=1` identifies an explicit colour choice;
immediate, random and previous applies keep the saved choice and send `0`.

## Live wallpapers

`.mp4`, `.webm` and `.mkv` files play through mpvpaper above a still of their
first frame. The same still is used for previews and the optional hook.
Missing live dependencies are reported when applying a video; stills do not
require them. Window-based automatic pause needs Hyprland; manual pause works
on other supported compositors too.

Prepare large downloads once, if desired:

```sh
./import-live.sh ~/Downloads/*.mp4
```

This imports into `<wallpaper folder>/Live`, caps the frame rate at 30 fps,
removes audio and repeats short clips to reduce loop hitches. Set
`WALLPAPER_LIVE_DIR` when your extension preference uses a different library.
Without a detected Hyprland output size, the target is 1920x1080; smaller
sources are not upscaled. Preparation requires ffmpeg, ffprobe and Python 3.
If one clip fails, the rest of the batch continues; the command exits with a
nonzero status to report any skipped or failed inputs. Existing files are kept.

For a keybind, use **Pause or Resume Live Wallpaper**, or call the bundled
`live-wallpaper.py` with `pause`, `resume`, `toggle`, or `status`. Manual pause
persists across logins. The `idle` and `active` commands are suitable for
hypridle hooks, to stop decoding while the screen is locked or asleep.

## Library metadata

Supported still formats: JPEG, PNG and WebP. Subfolders are scanned to the depth
chosen in preferences. Folder paths can contain spaces and Unicode. Filenames
containing tabs/newlines are skipped because the scanner uses a record format.
Thumbnail rendering treats names containing `*`, `?` or brackets as literal paths.

An optional `.wallpaper-library.json` in the wallpaper folder adds searchable
titles, tags, source links and resolution labels. Keys are relative paths:

```json
{
  "version": 1,
  "wallpapers": {
    "Scenes/rain.jpg": {
      "title": "Rainy neon alley",
      "tags": ["city", "rain"],
      "source": "https://wallhaven.cc/w/abc123",
      "resolution": "3840x2160"
    }
  }
}
```

Wallhaven filenames get source links automatically. Filenames remain searchable
and appear in tooltips, leaving the grid mostly pictures.

## Local data

Configuration, state, cache and runtime paths respect the corresponding XDG
variables. Defaults:

- State: `~/.local/state/wallpaper-picker/`, including `current`, `current-image`
  (a still-image symlink), `previous`, `fit`, `favourites` and `last-apply.log`.
- Cache: `~/.cache/wallpaper-picker/`.
- Live sockets/flags: `$XDG_RUNTIME_DIR/wallpaper-picker/runtime`, or a private
  directory under the picker cache when no runtime directory is available.

State and caches can contain absolute paths to your own files. They stay outside
the source repository. The source exporter excludes them and Git history; see
[RELEASING.md](RELEASING.md) before making the project public.

## Troubleshooting

| Problem | What to check |
|---|---|
| Empty library or folder error | Open extension preferences and select a readable folder containing JPEG, PNG, WebP or supported videos. Check the subfolder depth. |
| Wallpaper does not change | Run `./install.sh --check`, then `awww query` in your Wayland session. The daemon must be reachable from the session running Vicinae. |
| A failed apply closes the picker | Read `~/.local/state/wallpaper-picker/last-apply.log` (or its `XDG_STATE_HOME` equivalent) for the backend error. Desktop notifications need `notify-send`. |
| Colours or small thumbnails are missing | Install ImageMagick and press Ctrl+R. The first scan fills the thumbnail/colour cache in the background. |
| Live wallpaper shows only a still | Check the optional live dependencies and a working systemd user session. Inspect `journalctl --user -u wallpaper-live.service -b --no-pager` for player errors. |
| Wallpaper changes but app colours do not | Theming is opt-in. Follow the [matugen example](examples/matugen/README.md) or configure your own post-apply hook. |

## Development

```sh
cd vicinae
npm ci
npm run dev
npm test
npm run lint
npx tsc --noEmit
shellcheck -x -P .. ../*.sh ../examples/matugen/post-apply.sh
```

Tests use fake desktop commands, temporary state and simulated compositor
sockets. They do not change your real wallpaper or desktop configuration.

## License

MIT
