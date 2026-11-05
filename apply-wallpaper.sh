#!/usr/bin/env bash
# Set an image/video wallpaper. Optional theming belongs in the user's hook.
set -euo pipefail

[ "$#" -ge 1 ] || { printf 'Usage: %s WALLPAPER [TRANSITION]\n' "$0" >&2; exit 2; }
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=awww-lib.sh
. "$script_dir/awww-lib.sh"

wallpaper=$(realpath -e -- "$1")
[ -f "$wallpaper" ] && [ -r "$wallpaper" ] || { printf 'Wallpaper is not a readable file.\n' >&2; exit 1; }
case "$wallpaper" in *$'\n'*|*$'\t'*) printf 'Wallpaper filenames cannot contain tabs or newlines.\n' >&2; exit 2 ;; esac
transition=${2:-spotlight-wave}
duration=${WALLPAPER_TRANSITION_DURATION:-}
resize=${WALLPAPER_RESIZE_MODE:-crop}
filter=${WALLPAPER_SCALING_FILTER:-CatmullRom}
gravity=${WALLPAPER_CROP_GRAVITY:-center}
case "$resize" in crop|fit|stretch|no) ;; *) resize=crop ;; esac
case "$filter" in Nearest|Bilinear|CatmullRom|Mitchell|Lanczos3) ;; *) filter=CatmullRom ;; esac
case "$gravity" in top-left|top|top-right|left|center|right|bottom-left|bottom|bottom-right) ;; *) gravity=center ;; esac
case "$transition" in
    spotlight-wave|spotlight|custom) transition=grow; duration=${duration:-0.7} ;;
    iris-close) transition=outer; duration=${duration:-0.7} ;;
    wave-sweep) transition=wave; duration=${duration:-0.6} ;;
    diagonal-wipe) transition=wipe; duration=${duration:-0.5} ;;
    soft-fade) transition=fade; duration=${duration:-0.65} ;;
    none|fade|grow|outer|wave|wipe) duration=${duration:-0.4} ;;
    *) transition=fade; duration=${duration:-0.4} ;;
esac
[[ "$duration" =~ ^([0-9]+([.][0-9]+)?|[.][0-9]+)$ ]] || duration=0.4

state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/wallpaper-picker"
wallpaper_state=${WALLPAPER_STATE_FILE:-"$state_dir/current"}
wallpaper_link=${WALLPAPER_LINK_FILE:-"$state_dir/current-image"}
fit_state=${WALLPAPER_PICKER_FIT_STATE:-"$state_dir/fit"}
previous_state=${WALLPAPER_PICKER_PREVIOUS:-"$state_dir/previous"}
apply_lock=${WALLPAPER_PICKER_LOCK:-"$state_dir/apply.lock"}
apply_marker=${WALLPAPER_PICKER_APPLY_MARKER:-"$state_dir/applying"}

atomic_write() {
    local target=$1 value=$2 tmp
    mkdir -p -- "$(dirname -- "$target")" || return 1
    tmp=$(mktemp "${target}.XXXXXX") || return 1
    if printf '%s\n' "$value" >"$tmp" && mv -fT -- "$tmp" "$target"; then return 0; fi
    rm -f -- "$tmp"
    return 1
}

mkdir -p -- "${apply_lock%/*}" "$state_dir"
exec 9>"$apply_lock"
flock -w 20 9 || { printf 'Another wallpaper apply is still running. Try again.\n' >&2; exit 1; }
if [ "${WALLPAPER_PICKER_LOG:-0}" = 1 ]; then exec 2>"$state_dir/last-apply.log"; fi

old_wallpaper=$(cat "$wallpaper_state" 2>/dev/null || true)
old_fit=$(cat "$fit_state" 2>/dev/null || true)
old_link=$(readlink -- "$wallpaper_link" 2>/dev/null || true)
old_previous=$(cat "$previous_state" 2>/dev/null || true)
had_current=false; [ ! -f "$wallpaper_state" ] || had_current=true
had_fit=false; [ ! -f "$fit_state" ] || had_fit=true
had_previous=false; [ ! -f "$previous_state" ] || had_previous=true
mapfile -t old_fit_args < <(awww_saved_fit_args "$fit_state")
attempted=false
committing=false
stage='waiting for the wallpaper daemon'
link_tmp="${wallpaper_link}.$$.tmp"

finish() {
    local rc=$?
    trap - EXIT
    set +e
    if [ "$rc" -ne 0 ]; then
        if $committing; then
            if $had_current; then atomic_write "$wallpaper_state" "$old_wallpaper" || true; else rm -f -- "$wallpaper_state"; fi
            if $had_fit; then atomic_write "$fit_state" "$old_fit" || true; else rm -f -- "$fit_state"; fi
            if $had_previous; then atomic_write "$previous_state" "$old_previous" || true; else rm -f -- "$previous_state"; fi
            if [ -n "$old_link" ]; then ln -sfnT -- "$old_link" "$wallpaper_link" || true; else rm -f -- "$wallpaper_link"; fi
        fi
        if $attempted && [ -f "$old_wallpaper" ]; then
            awww_img_targeted "$old_wallpaper" "${old_fit_args[@]}" --transition-type none >/dev/null 2>&1 || true
        fi
        printf 'Wallpaper apply failed while %s (exit %s).\n' "$stage" "$rc" >&2
        if command -v notify-send >/dev/null 2>&1; then
            notify-send --app-name='Wallpaper Picker' 'Wallpaper apply failed' \
                "Could not finish $stage. See $state_dir/last-apply.log for launcher applies." 9>&- >/dev/null 2>&1 || true
        fi
    fi
    rm -f -- "$apply_marker" "$link_tmp"
    exit "$rc"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
atomic_write "$apply_marker" "$$"

# A missing video dependency must not interrupt the current wallpaper.
if is_live "$wallpaper"; then live_require_tools; fi
awww_ensure_ready
stage='setting the wallpaper'
attempted=true
args=(--resize "$resize" --filter "$filter" --crop-gravity "$gravity"
      --transition-type "$transition" --transition-duration "$duration"
      --transition-pos "${WALLPAPER_TRANSITION_POS:-center}"
      --transition-angle "${WALLPAPER_TRANSITION_ANGLE:-90}"
      --transition-bezier "${WALLPAPER_TRANSITION_BEZIER:-.25,.1,.25,1}"
      --transition-wave "${WALLPAPER_TRANSITION_WAVE:-24,18}")
[ -z "${WALLPAPER_TRANSITION_FPS:-}" ] || args+=(--transition-fps "$WALLPAPER_TRANSITION_FPS")
if ! awww_img_targeted "$wallpaper" "${args[@]}"; then
    sleep 0.15
    awww_img_targeted "$wallpaper" "${args[@]}"
fi

stage='saving the wallpaper'
committing=true
poster=$(still_for "$wallpaper")
mkdir -p -- "${wallpaper_link%/*}"
ln -s -- "$poster" "$link_tmp"
mv -fT -- "$link_tmp" "$wallpaper_link"
atomic_write "$fit_state" "$resize
$filter
$gravity"
if [ -n "$old_wallpaper" ] && [ "$old_wallpaper" != "$wallpaper" ]; then
    atomic_write "$previous_state" "$old_wallpaper"
fi
atomic_write "$wallpaper_state" "$wallpaper"
committing=false
attempted=false

# A hook is opt-in. Its failure cannot undo a successfully applied wallpaper.
if [ -n "${WALLPAPER_PICKER_POST_APPLY:-}" ]; then
    export WALLPAPER_PICKER_CURRENT_IMAGE="$poster"
    if ! timeout 10 "$WALLPAPER_PICKER_POST_APPLY" "$wallpaper" 9>&-; then
        printf 'Wallpaper set, but the post-apply hook failed or timed out.\n' >&2
        if command -v notify-send >/dev/null 2>&1; then
            notify-send --app-name='Wallpaper Picker' 'Wallpaper set' 'The optional post-apply hook failed; check last-apply.log.' 9>&- >/dev/null 2>&1 || true
        fi
    fi
fi
