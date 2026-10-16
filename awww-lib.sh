# shellcheck shell=bash
# Per-output wallpaper routing for awww. Sourced by apply-wallpaper-theme.sh and
# restore-wallpaper.sh.
#
# Optional blackout: outputs whose name or description matches
# AWWW_BLACKOUT_MATCH (a case-insensitive regex, e.g. a portrait side panel) get
# a flat fill instead of the wallpaper. awww has no per-output memory - every
# `awww img` without `-o` repaints *all* outputs - so every path that sets a
# wallpaper routes around them. Match on the description, not the connector:
# USB-C monitors can re-enumerate between DP-1/DP-2/DP-3 across replugs.

# Local, untracked settings (blackout match, reload command, ...). Plain shell
# assignments; see the README.
_wp_env="${XDG_CONFIG_HOME:-$HOME/.config}/wallpaper-picker/env"
# shellcheck source=/dev/null
[ -r "$_wp_env" ] && . "$_wp_env"
unset _wp_env

AWWW_BLACKOUT_MATCH="${AWWW_BLACKOUT_MATCH:-}"
AWWW_BLACKOUT_COLOR="${AWWW_BLACKOUT_COLOR:-0x000000}"

# A running process is not proof that its IPC socket is ready. Share this
# bounded readiness check between regular applies and session/hotplug restores.
awww_ensure_ready() {
    command -v awww >/dev/null 2>&1 || return 127
    awww query >/dev/null 2>&1 && return 0
    if ! pgrep -x awww-daemon >/dev/null 2>&1; then
        command -v awww-daemon >/dev/null 2>&1 || return 127
        # The long-lived daemon must never inherit the caller's apply lock.
        awww-daemon 9>&- >/dev/null 2>&1 &
    fi
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
    local image=$1
    shift
    local -a routes=()
    local wallpaper blackout rc=0
    mapfile -t routes < <(_awww_routes)
    wallpaper=${routes[0]:-}
    blackout=${routes[1]:-}
    # Detect pacing from the same snapshot used for output routing. Explicit
    # frame-rate arguments still win, including scripted overrides.
    local arg explicit_fps=false
    for arg in "$@"; do
        case "$arg" in --transition-fps|--transition-fps=*) explicit_fps=true ;; esac
    done
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
    return "$rc"
}
