# shellcheck shell=bash
# Per-output wallpaper routing for awww. Sourced by apply-wallpaper.sh and
# restore-wallpaper.sh.
#
# Optional blackout: outputs whose name or description matches
# AWWW_BLACKOUT_MATCH (a case-insensitive regex, e.g. a portrait side panel) get
# a flat fill instead of the wallpaper. awww has no per-output memory - every
# `awww img` without `-o` repaints *all* outputs - so every path that sets a
# wallpaper routes around them. Match on the description, not the connector:
# USB-C monitors can re-enumerate between DP-1/DP-2/DP-3 across replugs.

# shellcheck source=image-lib.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/image-lib.sh"

AWWW_BLACKOUT_MATCH="${AWWW_BLACKOUT_MATCH:-}"
AWWW_BLACKOUT_COLOR="${AWWW_BLACKOUT_COLOR:-0x000000}"

# A running process is not proof that its IPC socket is ready. Share this
# bounded readiness check between regular applies and session/hotplug restores.
awww_ensure_ready() {
    command -v awww >/dev/null 2>&1 || return 127
    awww query >/dev/null 2>&1 && return 0
    command -v awww-daemon >/dev/null 2>&1 || return 127
    # Processes in other users/sessions say nothing about this session's socket.
    # A daemon that is already running can reject the duplicate startup safely.
    awww-daemon 9>&- >/dev/null 2>&1 &
    local _attempt
    for _attempt in {1..20}; do
        sleep 0.1
        awww query >/dev/null 2>&1 && return 0
    done
    printf 'awww did not become ready; check awww-daemon.service.\n' >&2
    return 1
}

# One compositor snapshot supplies routing and animation pacing. Returning both
# lists together avoids races and three monitor queries per wallpaper send.
_awww_routes() {
    local payload="" src=""
    if [ -n "${HYPRLAND_INSTANCE_SIGNATURE:-}" ] && command -v hyprctl >/dev/null 2>&1; then
        payload=$(hyprctl monitors -j 2>/dev/null) || payload=""
        [ -n "$payload" ] && src=hyprland
    fi
    printf '%s' "$payload" | python3 -c '
import json, re, sys
src, pattern = sys.argv[1:3]
try:
    data = json.load(sys.stdin)
    # An empty pattern matches everything; it means "no blackout", not "all".
    rx = re.compile(pattern, re.I) if pattern else None
    hit = lambda name, desc: bool(rx and rx.search(name + " " + desc))
    monitors = [(m["name"], m.get("description", ""), m.get("refreshRate", 60)) for m in data] if src == "hyprland" else []
    wallpaper = [(name, rate) for name, desc, rate in monitors if name and not hit(name, desc)]
    blackout = [name for name, desc, rate in monitors if name and hit(name, desc)]
    fps = min(240, max(60, round(max((float(rate) for _, rate in wallpaper), default=60))))
except (ValueError, TypeError, KeyError, IndexError, AttributeError, OverflowError, re.error):
    wallpaper, blackout, fps = [], [], 60
print(",".join(name for name, _ in wallpaper))
print(",".join(blackout))
print(fps)
' "$src" "$AWWW_BLACKOUT_MATCH" 2>/dev/null || printf '\n\n60\n'
}

awww_blackout_csv() { _awww_routes | sed -n '2p'; }
awww_wallpaper_csv() { _awww_routes | sed -n '1p'; }
awww_wallpaper_fps() { _awww_routes | sed -n '3p'; }

# One validated fit contract for login restore and failed-apply recovery.
# Output one argument per line so callers can use mapfile without word splitting.
awww_saved_fit_args() {
    local resize=crop filter=CatmullRom gravity=center
    if [ -r "$1" ]; then
        { IFS= read -r resize; IFS= read -r filter; IFS= read -r gravity; } <"$1" 2>/dev/null || true
    fi
    case "$resize" in crop|fit|stretch|no) ;; *) resize=crop ;; esac
    case "$filter" in Nearest|Bilinear|CatmullRom|Mitchell|Lanczos3) ;; *) filter=CatmullRom ;; esac
    case "$gravity" in top-left|top|top-right|left|center|right|bottom-left|bottom|bottom-right) ;; *) gravity=center ;; esac
    printf '%s\n' --resize "$resize" --filter "$filter" --crop-gravity "$gravity"
}

# Live wallpapers: awww shows the video's first frame, and live-wallpaper.py
# plays it above that with one mpvpaper per output, pausing it while windows
# cover it (see that file). It runs as one transient user unit, so it outlives
# whichever launcher started it and stops cleanly.
# On hybrid-GPU laptops set WALLPAPER_LIVE_EGL_VENDOR to Mesa's glvnd JSON:
# otherwise glvnd loads the NVIDIA driver first and the dGPU never sleeps.
WALLPAPER_LIVE_MPV_OPTIONS="${WALLPAPER_LIVE_MPV_OPTIONS:-no-audio loop hwdec=auto-safe panscan=1.0}"
WALLPAPER_LIVE_EGL_VENDOR="${WALLPAPER_LIVE_EGL_VENDOR:-}"
_live_runtime="${XDG_RUNTIME_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}}/wallpaper-picker/runtime"
_live_token="$_live_runtime/live-token"
_live_player="$(dirname -- "${BASH_SOURCE[0]}")/live-wallpaper.py"

live_stop() {
    rm -f -- "$_live_token"
    # Stills also work in sessions without systemd. Never wait indefinitely for
    # an unavailable user bus just to set an image.
    if command -v systemctl >/dev/null 2>&1; then
        timeout 3 systemctl --user stop wallpaper-live.service >/dev/null 2>&1 || true
    fi
}

live_require_tools() {
    local tool
    for tool in mpvpaper ffmpeg python3 systemctl systemd-run; do
        command -v "$tool" >/dev/null 2>&1 || {
            printf 'Live wallpapers require %s. Install it or choose a still image.\n' "$tool" >&2
            return 127
        }
    done
    if ! timeout 3 systemctl --user show-environment >/dev/null 2>&1; then
        printf 'Live wallpapers require a running systemd user session. Choose a still image in this session.\n' >&2
        return 1
    fi
}

# live_start VIDEO OUTPUTS_CSV DELAY: start after awww's transition to the still
# has finished, unless another switch has happened in the meantime.
live_start() {
    local video=$1 outputs=$2 delay=${3:-0} token="$$.$RANDOM" var
    local -a env=()
    # Only forward what is set: an empty vendor list leaves glvnd with no EGL
    # driver at all, and the player reads the rest from its environment.
    for var in WAYLAND_DISPLAY HYPRLAND_INSTANCE_SIGNATURE XDG_RUNTIME_DIR XDG_CACHE_HOME XDG_CONFIG_HOME XDG_STATE_HOME WALLPAPER_LIVE_MPV_OPTIONS; do
        [ -n "${!var:-}" ] && env+=(-E "$var=${!var}")
    done
    [ -n "$WALLPAPER_LIVE_EGL_VENDOR" ] && env+=(-E "__EGL_VENDOR_LIBRARY_FILENAMES=$WALLPAPER_LIVE_EGL_VENDOR")
    mkdir -p -- "$_live_runtime" || return 1
    printf '%s\n' "$token" >"$_live_token" || return 1
    (
        sleep "$delay"
        [ "$(cat "$_live_token" 2>/dev/null)" = "$token" ] || exit 0
        systemd-run --user --quiet --collect --unit=wallpaper-live "${env[@]}" \
            python3 "$(realpath -- "$_live_player")" run "$video" "$outputs"
    ) 9>&- >/dev/null 2>&1 &
}

awww_apply_blackout() {
    local blackout
    blackout=$(awww_blackout_csv)
    [ -n "$blackout" ] || return 0
    awww img "$AWWW_BLACKOUT_COLOR" -o "$blackout" \
        --transition-type none >/dev/null 2>&1
}

# Return failure for either image or blackout sends, including an all-blackout
# setup. A successful wallpaper send must not hide a failed blackout fill.
awww_img_targeted() {
    local image=$1 video=""
    shift
    local -a routes=()
    local wallpaper blackout rc=0
    # Check optional dependencies before interrupting the current wallpaper.
    if is_live "$image"; then
        live_require_tools || return $?
        video=$image
        image=$(live_poster "$video") || return 1
    fi
    # Any switch replaces the running player; a video then shows its still here.
    live_stop
    mapfile -t routes < <(_awww_routes)
    wallpaper=${routes[0]:-}
    blackout=${routes[1]:-}
    # Detect pacing from the same snapshot used for output routing. Explicit
    # frame-rate arguments still win, including scripted overrides.
    local arg prev="" explicit_fps=false duration=0 ttype=""
    for arg in "$@"; do
        case "$arg" in --transition-fps|--transition-fps=*) explicit_fps=true ;; esac
        case "$prev" in
            --transition-duration) duration=$arg ;;
            --transition-type) ttype=$arg ;;
        esac
        prev=$arg
    done
    [ "$ttype" = none ] && duration=0
    if ! $explicit_fps; then
        set -- "$@" --transition-fps "${routes[2]:-60}"
    fi
    if [ -z "$blackout" ]; then
        awww img "$image" "$@" || rc=$?
    else
        if [ -n "$wallpaper" ]; then
            awww img "$image" -o "$wallpaper" "$@" || rc=$?
        fi
        awww img "$AWWW_BLACKOUT_COLOR" -o "$blackout" \
            --transition-type none >/dev/null 2>&1 || rc=$?
    fi
    if [ -n "$video" ] && [ "$rc" = 0 ] && { [ -z "$blackout" ] || [ -n "$wallpaper" ]; }; then
        # No compositor snapshot (awww painted every output): mpvpaper's ALL.
        live_start "$video" "${wallpaper:-ALL}" "$duration" || rc=$?
    fi
    return "$rc"
}
