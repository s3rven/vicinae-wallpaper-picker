#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ]; then
    echo "Usage: $0 WALLPAPER [SOURCE_COLOR_INDEX] [TRANSITION] [CUSTOM_ACCENT]" >&2
    exit 2
fi

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" 2>/dev/null && pwd -P)
# shellcheck source=thumb-lib.sh
. "$script_dir/thumb-lib.sh"
# shellcheck source=awww-lib.sh
. "$script_dir/awww-lib.sh"

wallpaper=$1
source_index=${2:-0}
transition_type=${3:-fade}
custom_accent=${4:-}
wallpaper_only=${WALLPAPER_PICKER_WALLPAPER_ONLY:-0}
case "$wallpaper_only" in 0|1) ;; *) wallpaper_only=0 ;; esac
custom_scheme_type=${WALLPAPER_PICKER_CUSTOM_SCHEME_TYPE:-scheme-fidelity}
resize_mode=${WALLPAPER_RESIZE_MODE:-crop}
scaling_filter=${WALLPAPER_SCALING_FILTER:-CatmullRom}
crop_gravity=${WALLPAPER_CROP_GRAVITY:-center}
transition_duration=${WALLPAPER_TRANSITION_DURATION:-}
transition_wait=${WALLPAPER_TRANSITION_WAIT:-0}
# Empty: pace the transition to the fastest output that shows the wallpaper
# (blacked-out outputs don't count).
transition_fps=${WALLPAPER_TRANSITION_FPS:-}
transition_angle=${WALLPAPER_TRANSITION_ANGLE:-45}
transition_pos=${WALLPAPER_TRANSITION_POS:-center}
# CSS `ease`. Two curves were tried and rejected here, both for the same reason
# — where a curve spends its time matters more than how smooth it is on paper:
#
#   .4,0,.2,1   first control point at y=0 through x=.4, so the image holds
#               still for the opening ~40% and then lunges. Reads as a hitch.
#   .2,0,0,1    Material 3 standard easing. Second control point at x=0 makes it
#               badly back-loaded: the tail of the crossfade crawls and the whole
#               thing feels far slower than its 0.6s, even though the number
#               never changed. M3 tuned that curve for position, not opacity.
#
# .25,.1,.25,1 leaves y=0 immediately, eases without a stall, and resolves
# cleanly instead of creeping to the finish.
transition_bezier=${WALLPAPER_TRANSITION_BEZIER:-.25,.1,.25,1}
transition_wave=${WALLPAPER_TRANSITION_WAVE:-24,18}

# Keep preference/environment input from turning a wallpaper apply into an
# awww argument error. The picker exposes the high-level fit controls, while
# the environment variables remain useful for scripted or power-user applies.
case "$resize_mode" in
    crop|fit|stretch|no) ;;
    *) resize_mode=crop ;;
esac
case "$scaling_filter" in
    Nearest|Bilinear|CatmullRom|Mitchell|Lanczos3) ;;
    *) scaling_filter=CatmullRom ;;
esac
case "$crop_gravity" in
    top-left|top|top-right|left|center|right|bottom-left|bottom|bottom-right) ;;
    *) crop_gravity=center ;;
esac
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}"
matugen_config=${MATUGEN_CONFIG:-"$HOME/.config/matugen/config.toml"}
neutral_config=${MATUGEN_NEUTRAL_CONFIG:-"$HOME/.config/matugen/config-neutral.toml"}
neutral_state=${WALLPAPER_PICKER_NEUTRAL:-"$state_dir/wallpaper-picker/neutral-mode"}
custom_accent_state=${WALLPAPER_PICKER_CUSTOM_ACCENT:-"$state_dir/wallpaper-picker/custom-accent"}
source_index_state=${WALLPAPER_PICKER_SOURCE_INDEX:-"$state_dir/wallpaper-picker/source-index"}
apply_lock=${WALLPAPER_PICKER_LOCK:-"$state_dir/wallpaper-picker/apply.lock"}
apply_marker=${WALLPAPER_PICKER_APPLY_MARKER:-"$state_dir/wallpaper-picker/applying"}
wallpaper_state=${WALLPAPER_STATE_FILE:-"$state_dir/theme/generated/wallpaper/path.txt"}
wallpaper_link=${WALLPAPER_LINK_FILE:-"${wallpaper_state%/*}/current"}
fit_state=${WALLPAPER_PICKER_FIT_STATE:-"$state_dir/wallpaper-picker/fit"}

generation_pending=false
wallpaper_attempted=false
previous_wallpaper=""
had_wallpaper=false
previous_fit_args=()
owns_marker=false
marker_tmp="${apply_marker}.$$"
apply_stage="validating the selection"
finish_apply() {
    local rc=$?
    trap - EXIT
    if [ "$rc" -ne 0 ]; then
        if $generation_pending; then
            # Matugen may have written a thumbnail path or Null before failing.
            if $had_wallpaper; then
                atomic_write_line "$wallpaper_state" "$previous_wallpaper" || true
                if [ -f "$previous_wallpaper" ]; then
                    ln -sfnT -- "$previous_wallpaper" "$wallpaper_link" || true
                fi
            else
                rm -f -- "$wallpaper_state"
            fi
        fi
        if $wallpaper_attempted && [ -n "$previous_wallpaper" ] && [ -f "$previous_wallpaper" ]; then
            awww_img_targeted "$previous_wallpaper" "${previous_fit_args[@]}" --transition-type none >/dev/null 2>&1 || true
        fi
        printf 'Wallpaper apply failed while %s (exit %s).\n' "$apply_stage" "$rc" >&2
        if command -v notify-send >/dev/null 2>&1; then
            notify-send --app-name='Wallpaper Picker' --urgency=normal \
                'Wallpaper apply failed' "Could not finish $apply_stage. Try again or choose another palette." \
                9>&- >/dev/null 2>&1 || true
        fi
    fi
    $owns_marker && rm -f -- "$apply_marker"
    rm -f -- "$marker_tmp"
    exit "$rc"
}
trap finish_apply EXIT
trap 'exit 130' INT
trap 'exit 143' TERM


if [ ! -f "$wallpaper" ]; then
    echo "Wallpaper not found: $wallpaper" >&2
    exit 1
fi
# Persist an absolute path even for direct shell applies from another folder.
# Login restore, lock-screen links and the thumbnail cache share this identity.
wallpaper=$(realpath -e -- "$wallpaper")

if [ -n "$custom_accent" ]; then
    [[ "$custom_accent" = \#* ]] || custom_accent="#$custom_accent"
    if [[ ! "$custom_accent" =~ ^\#[[:xdigit:]]{6}$ ]]; then
        echo "Invalid custom accent: $custom_accent" >&2
        exit 2
    fi
fi

if [ -z "$custom_accent" ] && [[ ! "$source_index" =~ ^[0-3]$ ]]; then
    printf 'Invalid source colour index: %s\n' "$source_index" >&2
    exit 2
fi
if [ "$wallpaper_only" != 1 ]; then
    command -v matugen >/dev/null 2>&1 || { printf 'Matugen is not installed.\n' >&2; exit 127; }
fi

atomic_write_line() {
    local target="$1" value="$2" tmp
    mkdir -p "$(dirname "$target")" || return 1
    tmp="${target}.${BASHPID:-$$}.tmp"
    if printf '%s\n' "$value" >"$tmp" && mv -f "$tmp" "$target"; then
        return 0
    fi
    rm -f "$tmp"
    return 1
}

save_wallpaper() {
    atomic_write_line "$wallpaper_state" "$wallpaper"
    ln -sfnT -- "$wallpaper" "$wallpaper_link"
    atomic_write_line "$fit_state" "$resize_mode
$scaling_filter
$crop_gravity"
}

# Theme generation and shell reloads are not safe to overlap. If the picker is
# reopened and applied again while the first Matugen run is still finishing,
# serialize the jobs so the newest selection always becomes the final state.
apply_stage="waiting for the previous wallpaper apply"
mkdir -p "$(dirname "$apply_lock")"
exec 9>"$apply_lock"
if ! flock -w 20 9; then
    echo "Timed out waiting for another wallpaper apply" >&2
    exit 1
fi

if [ -f "$wallpaper_state" ]; then
    had_wallpaper=true
    previous_wallpaper=$(cat "$wallpaper_state")
fi
mapfile -t previous_fit_args < <(awww_saved_fit_args "$fit_state")

# Detached launcher applies keep a bounded log; direct shell runs retain stderr.
if [ "${WALLPAPER_PICKER_LOG:-0}" = 1 ]; then
    mkdir -p "$state_dir/wallpaper-picker"
    exec 2>"$state_dir/wallpaper-picker/last-apply.log"
fi

mkdir -p "$(dirname "$apply_marker")"
marker_tmp="${apply_marker}.$$"
printf '%s\n' "$$" >"$marker_tmp"
mv -f "$marker_tmp" "$apply_marker"
owns_marker=true
apply_stage="setting the wallpaper"

# Neutral mode: use the neutral matugen config when the user has one. What it
# renders (typically grey surfaces with the wallpaper accent) is up to it.
if [ -f "$neutral_state" ] && [ -f "$neutral_config" ]; then
    matugen_config="$neutral_config"
fi

_templates=""
[ -f "$matugen_config" ] && _templates=$(sed -n 's/^[[:space:]]*\[templates\.\([^]]*\)\].*/\1/p' "$matugen_config")

has_template() {
    printf '%s\n' "$_templates" | grep -qxF "$1"
}

case "$transition_type" in
    custom|spotlight|spotlight-wave)
        # Grow from center: smooth fast-start deceleration, no overshoot bounce.
        # The picker's default, so this duration decides how fast picking a
        # wallpaper feels. 0.95s read as a stall, 0.5s was over before it
        # registered as motion; 0.7s reads as deliberate.
        transition_type=grow
        transition_duration=${transition_duration:-0.7}
        transition_pos=${WALLPAPER_TRANSITION_POS:-center}
        transition_bezier=${WALLPAPER_TRANSITION_BEZIER:-.25,.1,.25,1}
        ;;
    iris-close)
        # Shrinking circle - the reverse of grow/spotlight-wave, same tuning.
        transition_type=outer
        transition_duration=${transition_duration:-0.7}
        transition_pos=${WALLPAPER_TRANSITION_POS:-center}
        transition_bezier=${WALLPAPER_TRANSITION_BEZIER:-.25,.1,.25,1}
        ;;
    wave-sweep)
        # Top-to-bottom wave (90°) looks much more intentional than the old
        # near-horizontal 28° which was indistinguishable from a plain wipe.
        transition_type=wave
        transition_duration=${transition_duration:-0.6}
        transition_angle=${WALLPAPER_TRANSITION_ANGLE:-90}
        transition_wave=${WALLPAPER_TRANSITION_WAVE:-24,18}
        transition_bezier=${WALLPAPER_TRANSITION_BEZIER:-.25,.1,.25,1}
        ;;
    diagonal-wipe)
        # True 45° diagonal; old 32° looked nearly identical to wave-sweep.
        transition_type=wipe
        transition_duration=${transition_duration:-0.5}
        transition_angle=${WALLPAPER_TRANSITION_ANGLE:-45}
        transition_bezier=${WALLPAPER_TRANSITION_BEZIER:-.25,.1,.25,1}
        ;;
    soft-fade)
        # Symmetric ease-in-out and longer duration — actually soft this time.
        transition_type=fade
        transition_duration=${transition_duration:-0.65}
        transition_bezier=${WALLPAPER_TRANSITION_BEZIER:-.4,0,.6,1}
        ;;
    *)
        transition_duration=${transition_duration:-0.4}
        ;;
esac

apply_with_awww() {
    local -a fps_args=()
    [ -n "$transition_fps" ] && fps_args=(--transition-fps "$transition_fps")
    awww_img_targeted "$wallpaper" --resize "$resize_mode" --crop-gravity "$crop_gravity" --filter "$scaling_filter" \
        --transition-type "$transition_type" \
        --transition-duration "$transition_duration" \
        "${fps_args[@]}" \
        --transition-angle "$transition_angle" \
        --transition-pos "$transition_pos" \
        --transition-bezier "$transition_bezier" \
        --transition-wave "$transition_wave"
}

if ! command -v awww >/dev/null 2>&1; then
    printf 'Cannot apply wallpaper: awww is not installed.\n' >&2
    exit 1
fi

apply_stage="waiting for the wallpaper daemon"
awww_ensure_ready
apply_stage="setting the wallpaper"
wallpaper_attempted=true
if ! apply_with_awww && { sleep 0.15; ! apply_with_awww; }; then
    printf 'Failed to apply wallpaper with awww; theme was left unchanged.\n' >&2
    exit 1
fi
if [ "$transition_type" != "none" ] && [ "$transition_wait" != "0" ]; then
    sleep "$transition_wait"
fi

if [ "$wallpaper_only" = 1 ]; then
    # Switching just the image must preserve the palette, accent pin, neutral
    # mode and application settings. Still commit image/fit for login and lock.
    apply_stage="saving the wallpaper"
    generation_pending=true
    save_wallpaper
    generation_pending=false
    wallpaper_attempted=false
    exit 0
fi

# Theme from the cached thumb, not the 4K source: matugen runs ~3-5x faster and
# extracts identical colours. Critically, this is the same thumb scan-colors.sh
# sampled for the preview, so the applied theme is the one that was shown.
matugen_input=$(matugen_input_for "$wallpaper")

if [ -n "$custom_accent" ]; then
    matugen_args=(
        color hex "$custom_accent"
        --type "$custom_scheme_type"
        --mode dark
        --quiet
        --continue-on-error
    )
else
    matugen_args=(
        image "$matugen_input"
        --source-color-index "$source_index"
        --mode dark
        --resize-filter nearest
        --quiet
        --continue-on-error
    )
fi

if [ -f "$matugen_config" ]; then
    matugen_args=(--config "$matugen_config" "${matugen_args[@]}")
fi

# 9>&- is load-bearing. FD 9 holds this script's flock on apply.lock, and every
# matugen post_hook inherits it. A long-running hook therefore keeps apply.lock
# pinned after this script exits, and the next wallpaper pick blocks on flock
# before it can even send the image — the first switch is instant and every one
# after it appears to hang. Backgrounding a hook does not help: `setsid nohup
# ... &` detaches the session and redirects stdio but does NOT close inherited
# descriptors. Same guard as awww_ensure_ready.
apply_stage="generating the theme"
generation_pending=true
matugen "${matugen_args[@]}" 9>&-
generation_pending=false
apply_stage="saving wallpaper preferences"

if [ -n "$custom_accent" ]; then
    atomic_write_line "$custom_accent_state" "$custom_accent"
    # The palette came from a hex, so which swatch of the image would have been
    # the source is meaningless. Clear it for the same reason the else branch
    # clears the pin: whichever of the two files survives is the one that
    # describes how this palette was actually built.
    rm -f "$source_index_state"
else
    # This apply derived the palette from the image, so there is no pinned accent
    # any more. Anything that rebuilds the theme from these state files must not
    # find a stale pin and repaint the desktop with an accent replaced hours ago.
    rm -f "$custom_accent_state"

    # Which extracted swatch was used matters just as much as a pinned hex:
    # without it, a rebuild defaults to index 0 and lands on a different accent.
    atomic_write_line "$source_index_state" "$source_index"
fi

# Persist the original image, stable lock-screen link and chosen fit even when
# a custom Matugen config omits its wallpaper template.
save_wallpaper
wallpaper_attempted=false

# Optional user hook for whatever matugen templates cannot reach (a shell's IPC,
# a bar reload, ...). Gets "neutral" or "colour" as its argument. Best-effort and
# time-boxed: a hung hook must never block or fail a wallpaper apply.
if [ -n "${WALLPAPER_PICKER_POST_APPLY:-}" ]; then
    if [ "$matugen_config" = "$neutral_config" ]; then hook_mode=neutral; else hook_mode=colour; fi
    timeout 5 "$WALLPAPER_PICKER_POST_APPLY" "$hook_mode" 9>&- >/dev/null 2>&1 || true
fi

apply_stage="refreshing themed applications"

ensure_cava_theme_selected() {
    local config_file="$HOME/.config/cava/config"

    mkdir -p "$HOME/.config/cava/themes" "$(dirname "$config_file")"

    if [ ! -f "$config_file" ]; then
        printf '[color]\ntheme = "matugen"\n' >"$config_file"
        return 0
    fi

    if grep -q '^\[color\]' "$config_file"; then
        if sed -n '/^\[color\]/,/^\[/p' "$config_file" | grep -qE '^[;[:space:]]*theme[[:space:]]*='; then
            sed -i -E '/^\[color\]/,/^\[/{s/^[;[:space:]]*theme[[:space:]]*=.*/theme = "matugen"/}' "$config_file"
        else
            sed -i '/^\[color\]/a theme = "matugen"' "$config_file"
        fi
    else
        printf '\n[color]\ntheme = "matugen"\n' >>"$config_file"
    fi
}

reload_cava() {
    if ! pgrep -x cava >/dev/null 2>&1; then
        return 0
    fi

    local cava_pid cava_cmdline
    while IFS= read -r cava_pid; do
        [ -r "/proc/$cava_pid/cmdline" ] || continue
        cava_cmdline=$(tr '\0' ' ' <"/proc/$cava_pid/cmdline")
        case "$cava_cmdline" in *-p*stdin*) continue ;; esac
        kill -USR1 "$cava_pid" 2>/dev/null || true
    done < <(pgrep -x cava 2>/dev/null)
}

reload_kitty() {
    command -v kitty >/dev/null 2>&1 || return 0
    pgrep -x kitty >/dev/null 2>&1 || return 0

    # Push the palette over the remote-control socket instead of SIGUSR1.
    # SIGUSR1 is a full config + GPU-renderer reload, which on some hybrid-GPU
    # setups leaves idle windows stuck on a stale frame until something forces a
    # repaint. set-colors swaps the palette and repaints immediately; SIGUSR1
    # stays as the fallback when no socket answers (needs allow_remote_control).
    local sock pushed=0
    for sock in "${XDG_RUNTIME_DIR:-/tmp}"/kitty-* /tmp/kitty-*; do
        [ -S "$sock" ] || continue
        if kitty @ --to "unix:$sock" set-colors -a -c "$HOME/.config/kitty/theme.conf" 2>/dev/null; then
            pushed=1
        fi
    done
    [ "$pushed" = 1 ] || pkill -USR1 -x kitty 2>/dev/null || true
}

reload_hyprland=false
if has_template hyprland || has_template hyprlock; then
    reload_hyprland=true
fi

if has_template cava; then
    ensure_cava_theme_selected
    reload_cava
fi

if has_template kitty; then
    reload_kitty
fi

if [ "$reload_hyprland" = true ] && command -v hyprctl >/dev/null 2>&1; then
    # Backgrounded, so it outlives this script: close FD 9 for the same reason
    # the matugen call above does, or it holds apply.lock until Hyprland answers.
    # WALLPAPER_PICKER_HYPR_RELOAD swaps in your own reload command (word-split).
    # shellcheck disable=SC2086
    (${WALLPAPER_PICKER_HYPR_RELOAD:-hyprctl reload config-only} >/dev/null 2>&1 || true) 9>&- &
fi
