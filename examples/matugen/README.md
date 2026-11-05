# Optional wallpaper-based theming with matugen

The picker only changes wallpapers. You can run any external tool after a
successful change using `WALLPAPER_PICKER_POST_APPLY`. This example uses
[matugen](https://github.com/InioX/matugen); install and configure it separately.

1. Create your matugen templates and config at
   `${XDG_CONFIG_HOME:-$HOME/.config}/matugen/config.toml`. This directory includes
   a minimal [config.toml](config.toml) and [Kitty template](kitty-colors.conf)
   you can copy as a starting point if you do not already have a matugen setup.
   The config disables matugen's wallpaper setter and writes
   `generated/kitty-colors.conf` next to itself. Your templates decide which
   applications are themed; see matugen's [configuration example](https://github.com/InioX/matugen/blob/main/example/config.toml).
2. Install the example hook from this directory:

   ```sh
   mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/wallpaper-picker"
   install -m 700 examples/matugen/post-apply.sh "${XDG_CONFIG_HOME:-$HOME/.config}/wallpaper-picker/post-apply.sh"
   ```

3. Add this line to `${XDG_CONFIG_HOME:-$HOME/.config}/wallpaper-picker/env`:

   ```sh
   WALLPAPER_PICKER_POST_APPLY="${XDG_CONFIG_HOME:-$HOME/.config}/wallpaper-picker/post-apply.sh"
   ```

The hook receives the original wallpaper path as `$1`. For a live wallpaper,
`WALLPAPER_PICKER_CURRENT_IMAGE` points to its cached first frame, so matugen
always gets an image. The hook is limited to ten seconds. A hook failure is
reported without undoing the wallpaper change. Restoring at login skips hooks.

To try the Kitty example, generate it once with
`matugen --config /path/to/config.toml image /path/to/wallpaper.jpg --mode dark`,
then add `include ../matugen/generated/kitty-colors.conf` to your Kitty config
(adjust the path if you saved the matugen config elsewhere). Reload Kitty's
config to see it. Automatic application reloads belong in your matugen templates
or your own hook; the picker does not manage them. An alternative config can be
selected with `export MATUGEN_CONFIG="/path/to/config.toml"` in the picker env file.

To disable theming, remove the hook setting. Your desktop configuration and
templates remain separate from the picker and can live in your dotfiles repo.
