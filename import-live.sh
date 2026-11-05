#!/usr/bin/env bash
# Prepare downloaded videos as live wallpapers: import-live.sh VIDEO...
#
# Downloads are usually 4K at up to 60 fps, which costs decode bandwidth and a
# full-screen recomposite per frame for pixels the panel cannot show. Each video
# is re-encoded once to fill the largest wallpaper output, capped in frame rate,
# without audio. Smaller sources are only cropped to the output's shape, never
# upscaled: mpv scales on the GPU for free, while extra pixels cost every decode. Short clips are repeated inside the file (stream copy, no second
# encode): mpv drops a frame each time it seeks back to the start, so a 5 s clip
# hitches every 5 s, while a 30 s file hitches twice a minute.
#
#   WALLPAPER_LIVE_DIR       destination (default: <wallpaper folder>/Live)
#   WALLPAPER_LIVE_SIZE      WxH to fill (default: largest wallpaper output)
#   WALLPAPER_LIVE_FPS       frame-rate cap (default 30)
#   WALLPAPER_LIVE_MIN_LOOP  shortest file in seconds before repeating (default 30)
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" 2>/dev/null && pwd -P)
# shellcheck source=awww-lib.sh
. "$script_dir/awww-lib.sh"

[ "$#" -gt 0 ] || { printf 'Usage: %s VIDEO...\n' "$0" >&2; exit 2; }
for tool in ffmpeg ffprobe python3; do
    command -v "$tool" >/dev/null 2>&1 || { printf 'Video preparation requires %s.\n' "$tool" >&2; exit 127; }
done

dest=${WALLPAPER_LIVE_DIR:-${WALLPAPER_DIR:-$HOME/Pictures/wallpaper}/Live}
fps_cap=${WALLPAPER_LIVE_FPS:-30}
min_loop=${WALLPAPER_LIVE_MIN_LOOP:-30}
size=${WALLPAPER_LIVE_SIZE:-}
if [ -z "$size" ] && [ -n "${HYPRLAND_INSTANCE_SIGNATURE:-}" ]; then
    # Physical mode of the largest output that shows the wallpaper.
    size=$(hyprctl monitors -j 2>/dev/null | python3 -c '
import json, re, sys
rx = re.compile(sys.argv[1], re.I) if sys.argv[1] else None
mons = [m for m in json.load(sys.stdin) if not (rx and rx.search(m["name"] + " " + m.get("description", "")))]
m = max(mons, key=lambda m: m["width"] * m["height"])
# A rotated output shows the mode sideways.
w, h = (m["height"], m["width"]) if m.get("transform", 0) % 2 else (m["width"], m["height"])
print(f"{w}x{h}")' "$AWWW_BLACKOUT_MATCH" 2>/dev/null) || size=""
fi
size=${size:-1920x1080}
[[ "$size" =~ ^[1-9][0-9]*x[1-9][0-9]*$ ]] || { printf 'Invalid size: %s\n' "$size" >&2; exit 2; }
[[ "$fps_cap" =~ ^[1-9][0-9]*$ ]] || { printf 'Invalid frame rate: %s\n' "$fps_cap" >&2; exit 2; }
[[ "$min_loop" =~ ^[0-9]+([.][0-9]+)?$ ]] || { printf 'Invalid minimum duration: %s\n' "$min_loop" >&2; exit 2; }
w=${size%x*} h=${size#*x}
mkdir -p -- "$dest"

tmp=""
cleanup_import() {
    if [ -n "$tmp" ]; then rm -f -- "$tmp" "$tmp.loop.mp4"; fi
}
trap cleanup_import EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

rc=0
for src in "$@"; do
    cleanup_import
    tmp=""
    name=${src##*/}
    # Download sites append themselves: "-live-wallpaper-wallsflow-com", "-moewalls-com".
    base=$(sed -E 's/(-live-wallpaper)?-[a-z0-9]+-com$//' <<<"${name%.*}")
    out="$dest/${base:-${name%.*}}.mp4"
    if [ ! -f "$src" ]; then
        printf 'skip %s: not found\n' "$src" >&2; rc=1; continue
    fi
    if [ -e "$out" ]; then
        printf 'skip %s: %s already exists\n' "$name" "$out" >&2; rc=1; continue
    fi
    if ! src=$(realpath -e -- "$src"); then
        printf 'skip %s: source is no longer available\n' "$name" >&2; rc=1; continue
    fi
    # One probe for frame rate and size, then the output geometry: crop to the
    # target's aspect, and shrink to the target only when the source is larger.
    if ! read -r fps ow oh < <(ffprobe -v error -select_streams v:0 \
        -show_entries stream=avg_frame_rate,width,height -of json "$src" | python3 -c '
import json, sys
s = json.load(sys.stdin)["streams"][0]
cap, W, H = map(int, sys.argv[1:4])
n, _, d = s["avg_frame_rate"].partition("/")
fps = min(cap, round(float(n) / float(d or 1))) or cap
iw, ih = s["width"], s["height"]
cw, ch = (ih * W / H, ih) if iw / ih > W / H else (iw, iw * H / W)
k = min(1, W / cw)
even = lambda v: max(2, int(v * k) // 2 * 2)
print(fps, even(cw), even(ch))' "$fps_cap" "$w" "$h" 2>/dev/null); then
        printf 'skip %s: could not read video geometry\n' "$name" >&2; rc=1; continue
    fi
    tmp="$out.$$.tmp.mp4"
    if ! ffmpeg -nostdin -hide_banner -loglevel error -y -i "$src" -an \
        -vf "fps=$fps,scale=$ow:$oh:force_original_aspect_ratio=increase:flags=lanczos,crop=$ow:$oh" \
        -c:v libx264 -preset slow -crf 20 -profile:v high -pix_fmt yuv420p -g $((fps * 2)) \
        -movflags +faststart "$tmp"; then
        printf 'skip %s: video encoding failed\n' "$name" >&2; rc=1; continue
    fi
    if ! duration=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$tmp") ||
       ! repeats=$(python3 -c 'import math, sys; duration=float(sys.argv[1]); assert duration > 0; print(max(1, math.ceil(float(sys.argv[2]) / duration)))' "$duration" "$min_loop" 2>/dev/null); then
        printf 'skip %s: could not read clip duration\n' "$name" >&2; rc=1; continue
    fi
    if [ "$repeats" -gt 1 ]; then
        if ! ffmpeg -nostdin -hide_banner -loglevel error -y -stream_loop $((repeats - 1)) -i "$tmp" \
            -c copy -movflags +faststart "$tmp.loop.mp4" || ! mv -fT -- "$tmp.loop.mp4" "$tmp"; then
            printf 'skip %s: extending the video loop failed\n' "$name" >&2; rc=1; continue
        fi
    fi
    # A second importer may have created the destination while encoding.
    if ! mv -nT -- "$tmp" "$out" || [ -e "$tmp" ]; then
        printf 'skip %s: destination already exists or could not be saved\n' "$name" >&2; rc=1; continue
    fi
    printf '%s -> %s (%sx%s, %s fps, %sx loop)\n' "$name" "$out" "$ow" "$oh" "$fps" "$repeats"
done
exit "$rc"
