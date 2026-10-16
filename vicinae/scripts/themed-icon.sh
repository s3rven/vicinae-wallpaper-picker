#!/bin/sh
# `vici build` replaces the installed extension directory, which puts the static
# fallback icon back. Copy the matugen-rendered one over it so a rebuild does not
# show a stale palette until the next wallpaper change.
themed="${XDG_STATE_HOME:-$HOME/.local/state}/theme/generated/wallpaper-picker-icon.png"
installed="${XDG_DATA_HOME:-$HOME/.local/share}/vicinae/extensions/wallpaper-picker/assets/icon.png"
[ -r "$themed" ] || exit 0
install -Dm644 "$themed" "$installed"
