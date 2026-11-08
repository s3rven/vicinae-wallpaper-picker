#!/usr/bin/env bash
# Set an image/video wallpaper. Optional theming belongs in the user's hook.
set -euo pipefail

[ "$#" -ge 1 ] || { printf 'Usage: %s WALLPAPER [TRANSITION]\n' "$0" >&2; exit 2; }
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=awww-lib.sh
. "$script_dir/awww-lib.sh"

wallpaper=$(realpath -e -- "$1")
if [ ! -f "$wallpaper" ] || [ ! -r "$wallpaper" ]; then
    printf 'Wallpaper is not a readable file.\n' >&2
    exit 1
fi
case "$wallpaper" in *$'\n'*|*$'\t'*) printf 'Wallpaper filenames cannot contain tabs or newlines.\n' >&2; exit 2 ;; esac
transition=${2:-soft-fade}
duration=${WALLPAPER_TRANSITION_DURATION:-}
angle=${WALLPAPER_TRANSITION_ANGLE:-}
resize=${WALLPAPER_RESIZE_MODE:-crop}
filter=${WALLPAPER_SCALING_FILTER:-CatmullRom}
gravity=${WALLPAPER_CROP_GRAVITY:-center}
case "$resize" in crop|fit|stretch|no) ;; *) resize=crop ;; esac
case "$filter" in Nearest|Bilinear|CatmullRom|Mitchell|Lanczos3) ;; *) filter=CatmullRom ;; esac
case "$gravity" in top-left|top|top-right|left|center|right|bottom-left|bottom|bottom-right) ;; *) gravity=center ;; esac
case "$transition" in
    spotlight-wave|spotlight|custom) transition=grow; duration=${duration:-0.4} ;;
    iris-close) transition=outer; duration=${duration:-0.4} ;;
    wave-sweep) transition=wave; duration=${duration:-0.38} ;;
    diagonal-wipe) transition=wipe; duration=${duration:-0.32}; angle=${angle:-35} ;;
    soft-fade|fade|doom) transition=fade; duration=${duration:-0.28} ;;
    none|simple|grow|outer|wave|wipe|left|right|top|bottom|center|any|random) duration=${duration:-0.32} ;;
    *) transition=fade; duration=${duration:-0.28} ;;
esac
[[ "$duration" =~ ^([0-9]+([.][0-9]+)?|[.][0-9]+)$ ]] || duration=0.28

state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/wallpaper-picker"
# Generated solid colours fill the display even when ordinary images use Fit or Original.
case "$wallpaper" in "$state_dir"/colours/colour-??????.png) resize=stretch ;; esac
wallpaper_state=${WALLPAPER_STATE_FILE:-"$state_dir/current"}
wallpaper_link=${WALLPAPER_LINK_FILE:-"$state_dir/current-image"}
fit_state=${WALLPAPER_PICKER_FIT_STATE:-"$state_dir/fit"}
previous_state=${WALLPAPER_PICKER_PREVIOUS:-"$state_dir/previous"}
custom_accent_state=${WALLPAPER_PICKER_CUSTOM_ACCENT:-"$state_dir/custom-accent"}
source_index_state=${WALLPAPER_PICKER_SOURCE_INDEX:-"$state_dir/source-index"}
accent_changed=0
if [ "${WALLPAPER_PICKER_ACCENT+x}" = x ]; then
    accent_changed=1
    if [ -n "$WALLPAPER_PICKER_ACCENT" ] && [[ ! "$WALLPAPER_PICKER_ACCENT" =~ ^\#[[:xdigit:]]{6}$ ]]; then
        printf 'Accent must be #RRGGBB, or empty for automatic image colours.\n' >&2
        exit 2
    fi
fi
# An image palette (matugen source colour 0-3) belongs to that image, so it also clears a pinned accent.
palette=${WALLPAPER_PICKER_PALETTE:-}
if [ -n "$palette" ]; then
    [[ "$palette" =~ ^[0-3]$ ]] || { printf 'Palette must be 0-3.\n' >&2; exit 2; }
    [ -z "${WALLPAPER_PICKER_ACCENT:-}" ] || { printf 'Choose an accent or a palette, not both.\n' >&2; exit 2; }
    accent_changed=1
    WALLPAPER_PICKER_ACCENT=""
fi
apply_lock=${WALLPAPER_PICKER_LOCK:-"$state_dir/apply.lock"}
apply_marker=${WALLPAPER_PICKER_APPLY_MARKER:-"$state_dir/applying"}
request_state="$state_dir/latest-request"
request_token="$$.$RANDOM.$RANDOM"

atomic_write() {
    local target=$1 value=$2 tmp
    mkdir -p -- "$(dirname -- "$target")" || return 1
    tmp=$(mktemp "${target}.XXXXXX") || return 1
    if printf '%s\n' "$value" >"$tmp" && mv -fT -- "$tmp" "$target"; then return 0; fi
    rm -f -- "$tmp"
    return 1
}

mkdir -p -- "${apply_lock%/*}" "$state_dir"
# A quick sequence of choices should apply the newest waiting request, not replay the entire queue.
atomic_write "$request_state" "$request_token"
exec 9>"$apply_lock"
flock -w 20 9 || { printf 'Another wallpaper apply is still running. Try again.\n' >&2; exit 1; }
[ "$(cat "$request_state" 2>/dev/null)" = "$request_token" ] || exit 0
if [ "${WALLPAPER_PICKER_LOG:-0}" = 1 ]; then exec 2>"$state_dir/last-apply.log"; fi

old_wallpaper=$(cat "$wallpaper_state" 2>/dev/null || true)
old_fit=$(cat "$fit_state" 2>/dev/null || true)
old_link=$(readlink -- "$wallpaper_link" 2>/dev/null || true)
old_previous=$(cat "$previous_state" 2>/dev/null || true)
old_accent=$(cat "$custom_accent_state" 2>/dev/null || true)
old_source_index=$(cat "$source_index_state" 2>/dev/null || true)
had_current=false; [ ! -f "$wallpaper_state" ] || had_current=true
had_fit=false; [ ! -f "$fit_state" ] || had_fit=true
had_previous=false; [ ! -f "$previous_state" ] || had_previous=true
had_accent=false; [ ! -f "$custom_accent_state" ] || had_accent=true
had_source_index=false; [ ! -f "$source_index_state" ] || had_source_index=true
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
            if $had_accent; then atomic_write "$custom_accent_state" "$old_accent" || true; else rm -f -- "$custom_accent_state"; fi
            if $had_source_index; then atomic_write "$source_index_state" "$old_source_index" || true; else rm -f -- "$source_index_state"; fi
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
      --transition-angle "${angle:-90}"
      --transition-bezier "${WALLPAPER_TRANSITION_BEZIER:-.22,1,.36,1}"
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
if [ "$accent_changed" = 1 ]; then
    if [ -n "$WALLPAPER_PICKER_ACCENT" ]; then
        atomic_write "$custom_accent_state" "${WALLPAPER_PICKER_ACCENT,,}"
        rm -f -- "$source_index_state"
    else
        rm -f -- "$custom_accent_state"
        atomic_write "$source_index_state" "${palette:-0}"
    fi
elif [ "$old_wallpaper" != "$wallpaper" ] && [ -f "$source_index_state" ]; then
    # Index 3 of the last image is an arbitrary colour of this one, or out of range.
    atomic_write "$source_index_state" 0
fi
atomic_write "$wallpaper_state" "$wallpaper"
committing=false
attempted=false

# A hook is opt-in. Its failure cannot undo a successfully applied wallpaper.
if [ -n "${WALLPAPER_PICKER_POST_APPLY:-}" ] \
    && [ "$(cat "$request_state" 2>/dev/null)" = "$request_token" ]; then
    export WALLPAPER_PICKER_CURRENT_IMAGE="$poster"
    # Hooks receive the effective seed, including a saved pin on a direct apply.
    # The separate flag lets desktop integrations change preferences only on an explicit choice.
    saved_accent=$(cat "$custom_accent_state" 2>/dev/null || true)
    [[ "$saved_accent" =~ ^\#[[:xdigit:]]{6}$ ]] || saved_accent=""
    export WALLPAPER_PICKER_ACCENT="$saved_accent"
    export WALLPAPER_PICKER_ACCENT_CHANGED="$accent_changed"
    saved_index=$(cat "$source_index_state" 2>/dev/null || true)
    [[ "$saved_index" =~ ^[0-3]$ ]] || saved_index=0
    export WALLPAPER_PICKER_PALETTE_INDEX="$saved_index"
    # Palettes are previewed from this thumbnail; matugen finds other colours in the full image.
    thumb=$(thumb_path "$wallpaper")
    if thumb_is_fresh "$wallpaper" "$thumb"; then export WALLPAPER_PICKER_THUMBNAIL="$thumb"; fi
    if ! timeout 10 "$WALLPAPER_PICKER_POST_APPLY" "$wallpaper" 9>&-; then
        printf 'Wallpaper set, but the post-apply hook failed or timed out.\n' >&2
        if command -v notify-send >/dev/null 2>&1; then
            notify-send --app-name='Wallpaper Picker' 'Wallpaper set' 'The optional post-apply hook failed; check last-apply.log.' 9>&- >/dev/null 2>&1 || true
        fi
    fi
fi
