#!/usr/bin/env bash
# Start awww for the compositor session and restore the last picker selection.
set -uo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" 2>/dev/null && pwd -P)
# shellcheck source=awww-lib.sh
. "$script_dir/awww-lib.sh"

state_dir="${XDG_STATE_HOME:-$HOME/.local/state}"
apply_lock=${WALLPAPER_PICKER_LOCK:-"$state_dir/wallpaper-picker/apply.lock"}
# Login and hotplug restores must read committed picker state after an apply
# finishes. Read fit after this lock too.
mkdir -p -- "${apply_lock%/*}" || exit 1
exec 9>"$apply_lock"
flock -w 20 9 || exit 1
wallpaper_state="${WALLPAPER_STATE_FILE:-$state_dir/wallpaper-picker/current}"
wallpaper_link=${WALLPAPER_LINK_FILE:-"$state_dir/wallpaper-picker/current-image"}
fit_state=${WALLPAPER_PICKER_FIT_STATE:-"$state_dir/wallpaper-picker/fit"}

# apply-wallpaper.sh writes this alongside wallpaper_state whenever the
# picker applies a wallpaper, so a restore at login or on monitor hotplug uses
# whatever fit the user actually picked instead of silently reverting to
# crop/CatmullRom/center. Same validation as the apply script, since this file
# is user-editable state and a stale or hand-edited value must not reach awww.
mapfile -t saved_fit_args < <(awww_saved_fit_args "$fit_state")

awww_ensure_ready || exit $?

wallpaper=""
if [ -r "$wallpaper_state" ]; then
    IFS= read -r wallpaper <"$wallpaper_state" || true
fi

status=0
if [ -n "$wallpaper" ] && [ -f "$wallpaper" ]; then
    # Hyprland can announce a ready monitor before awww has registered its
    # output. Bound the quick retries before handing recovery back to systemd.
    deadline=$((SECONDS + 3))
    for _attempt in {1..20}; do
        if output=$(awww_img_targeted "$wallpaper" "${saved_fit_args[@]}" \
            --transition-type none 2>&1); then
            # Repair the lock-screen link only once the selection was restored.
            poster=$(still_for "$wallpaper") || exit $?
            exec ln -sfnT -- "$poster" "$wallpaper_link"
        else
            status=$?
        fi
        ((SECONDS < deadline)) || break
        sleep 0.1
    done
    printf 'Could not restore the saved wallpaper (exit %s); trying the awww cache.\n' "$status" >&2
    if [ -n "$output" ]; then printf '%s\n' "$output" >&2; fi
fi

# Restore the cache and blackout independently. A successful fallback can
# keep the desktop usable while a failed saved selection still gets retried.
awww restore >/dev/null || status=$?
awww_apply_blackout || status=$?
exit "$status"
