# Vicinae Wallpaper Picker

Browse and switch wallpapers from [Vicinae](https://vicinae.com). A thumbnail
grid for still images and live wallpapers, with favourites, collections, colour
filters and animated transitions through [awww](https://codeberg.org/LGFae/awww).

The picker sets wallpapers. Desktop theming is separate; an optional
[matugen example](examples/matugen/README.md) shows how to connect your own setup.

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
configuration. Run **Set Wallpaper** in Vicinae, then choose your wallpaper
folder in extension preferences. The default is `~/Pictures/wallpaper`.

Other installer options:

```sh
./install.sh --check                       # dependency check only
./install.sh --build-only                  # build to release/extension
./install.sh --output /path/to/extension   # build to a chosen directory
```

| Dependency | Purpose |
|---|---|
| Vicinae | Launcher and extension runtime |
| Node.js 22+ and npm | Build the extension |
| awww and awww-daemon | Set wallpapers and animate transitions |
| Bash 4.4+, coreutils, findutils, `flock` from util-linux | Backend scripts |
| ImageMagick (`magick` or `convert`), recommended | Small thumbnails and colour filters; stills work without it |
| Python 3, optional for stills | Faster scans and Hyprland monitor routing |
| mpvpaper, ffmpeg, Python 3 and a systemd user session, optional | Live wallpapers |
| ffprobe, optional | Prepare downloaded videos with `import-live.sh` |
| notify-send, optional | Desktop error notifications |

The scripts are bundled with the extension; the source clone can live anywhere
or be removed after installation. The installer downloads npm dependencies.
The running picker makes no network requests; source links open only when you
choose **Open Source Page**.

## Features

- Searchable thumbnail grid, favourites pinned first, and collections from
  subfolders. Archive/Old folders have their own filter.
- Filter by collection, colour, favourites, current wallpaper, live or still.
  Sort by colour, date or name; the picker remembers your filter and sort.
- Spotlight, iris, wave, wipe and fade transitions; adjustable duration, fit
  and crop anchor.
- Set a random still from the current filter, or use **Random Wallpaper** on a
  keybind. Videos are excluded from random selection.
- **Previous Wallpaper** swaps between the last two successful choices.
- Live wallpapers with manual pause and automatic pause behind windows on
  Hyprland. Pause policy is configurable in the action panel.
- Open full size, reveal in the file manager, open a source link or copy a path.
- Cached thumbnails and colours, with background refresh while the grid is open.
- Applies and login restores share a lock. Failed applies preserve the previous
  state and attempt to restore the previous image.

## Keys

| Key | Action |
|---|---|
| Enter | Set wallpaper |
| Ctrl+Shift+R | Random still from the current filter |
| Ctrl+F | Add/remove favourite |
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
sources are not upscaled. Preparation requires ffmpeg and ffprobe.

For a keybind, use **Pause or Resume Live Wallpaper**, or call the bundled
`live-wallpaper.py` with `pause`, `resume`, `toggle`, or `status`. Manual pause
persists across logins. The `idle` and `active` commands are suitable for
hypridle hooks, to stop decoding while the screen is locked or asleep.

## Library metadata

Supported still formats: JPEG, PNG and WebP. Subfolders are scanned to the depth
chosen in preferences. Folder paths can contain spaces and Unicode. Filenames
containing tabs/newlines are skipped because the scanner uses a record format.

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
