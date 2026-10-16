#!/usr/bin/env bash
# Start awww for the compositor session and restore the last picker selection.
set -uo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" 2>/dev/null && pwd -P)
# shellcheck source=awww-lib.sh
. "$script_dir/awww-lib.sh"

state_dir="${XDG_STATE_HOME:-$HOME/.local/state}"
apply_lock=${WALLPAPER_PICKER_LOCK:-"$state_dir/wallpaper-picker/apply.lock"}
# Login and hotplug restores must read committed picker state, never Matugen's
# temporary thumbnail/Null output during an apply. Read fit after this lock too.
mkdir -p -- "${apply_lock%/*}" || exit 1
exec 9>"$apply_lock"
flock -w 20 9 || exit 1
wallpaper_state="${WALLPAPER_STATE_FILE:-$state_dir/theme/generated/wallpaper/path.txt}"
wallpaper_link=${WALLPAPER_LINK_FILE:-"${wallpaper_state%/*}/current"}
fit_state=${WALLPAPER_PICKER_FIT_STATE:-"$state_dir/wallpaper-picker/fit"}

# apply-wallpaper-theme.sh writes this alongside wallpaper_state whenever the
# picker applies a wallpaper, so a restore at login or on monitor hotplug uses
# whatever fit the user actually picked instead of silently reverting to
# crop/CatmullRom/center. Same validation as the apply script, since this file
# is user-editable state and a stale or hand-edited value must not reach awww.
mapfile -t saved_fit_args < <(awww_saved_fit_args "$fit_state")

command -v awww >/dev/null 2>&1 || exit 0
awww_ensure_ready || exit 1

wallpaper=""
if [ -r "$wallpaper_state" ]; then
    IFS= read -r wallpaper <"$wallpaper_state" || true
fi

if [ -n "$wallpaper" ] && [ -f "$wallpaper" ]; then
    # Self-heal the stable full-resolution path on login or after restoring a
    # state directory on another machine.
    ln -sfnT -- "$wallpaper" "$wallpaper_link"
    # Hyprland can announce a ready monitor before awww has registered its
    # output. Retry briefly instead of immediately replaying an older cache.
    for _attempt in {1..20}; do
        if awww_img_targeted "$wallpaper" "${saved_fit_args[@]}" \
            --transition-type none >/dev/null 2>&1; then
            exit 0
        fi
        sleep 0.1
    done
    awww restore >/dev/null 2>&1 || true
else
    awww restore >/dev/null 2>&1 || true
fi

# `awww restore` replays the daemon's own cache, which knows nothing about the
# blackout split, so re-assert it on both paths.
awww_apply_blackout
