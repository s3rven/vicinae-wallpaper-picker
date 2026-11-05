#!/usr/bin/env bash
# Optional matugen integration. The picker itself never runs matugen.
# Install this script to ~/.config/wallpaper-picker/post-apply.sh and set
# WALLPAPER_PICKER_POST_APPLY to its absolute path in wallpaper-picker/env.
set -euo pipefail
[ "$#" -eq 1 ] || { printf 'Usage: %s WALLPAPER\n' "$0" >&2; exit 2; }
command -v matugen >/dev/null 2>&1 || { printf 'Install matugen to use this example hook.\n' >&2; exit 127; }
image=${WALLPAPER_PICKER_CURRENT_IMAGE:-$1}
config=${MATUGEN_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/matugen/config.toml}
if [ ! -f "$config" ]; then
    printf 'Create a matugen config first: %s\n' "$config" >&2
    exit 1
fi
matugen --config "$config" image "$image" --mode dark --source-color-index 0
