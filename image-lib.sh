# shellcheck shell=bash
# Shared image, video-poster and colour-hint cache helpers.
[ "${_WALLPAPER_IMAGES_LOADED:-0}" = 1 ] && return 0
_WALLPAPER_IMAGES_LOADED=1
_wp_env="${XDG_CONFIG_HOME:-$HOME/.config}/wallpaper-picker/env"
# shellcheck source=/dev/null
if [ -r "$_wp_env" ]; then . "$_wp_env"; fi
unset _wp_env
umask 077

THUMB_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/wallpaper-picker/thumbs"

THUMB_GEOMETRY='800x500'
THUMB_QUALITY=82

if command -v magick >/dev/null 2>&1; then
    THUMB_CMD=(magick)
elif command -v convert >/dev/null 2>&1; then
    THUMB_CMD=(convert)
else
    THUMB_CMD=()
fi

# sha1 of the path bytes, no trailing newline. scan-wallpapers.sh computes these
# in a single batched python pass for the whole collection; this is the reference
# implementation and the fallback for one-off lookups.
thumb_hash() {
    printf '%s' "$1" | sha1sum | cut -c1-40
}

thumb_path() {
    printf '%s/%s.jpg\n' "$THUMB_DIR" "$(thumb_hash "$1")"
}

# --- live (video) wallpapers ---------------------------------------------------
#
# A video is a wallpaper like any other: it keeps its own path in the picker's
# state. Everything that needs pixels (awww, thumbnails, the lock screen)
# gets a full-size still of its first frame instead, so the still awww shows
# under the player is exactly the frame playback starts on.
LIVE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/wallpaper-picker/live"

is_live() {
    case "${1,,}" in *.mp4|*.webm|*.mkv) return 0 ;; *) return 1 ;; esac
}

# Print the cached first-frame still for video $1, rendering it on a miss.
live_poster() {
    local dst tmp
    dst="$LIVE_DIR/$(thumb_hash "$1").png"
    if ! thumb_is_fresh "$1" "$dst"; then
        command -v ffmpeg >/dev/null 2>&1 || return 1
        mkdir -p "$LIVE_DIR" || return 1
        tmp="${dst%.png}.${BASHPID:-$$}.tmp.png"
        if ! ffmpeg -nostdin -loglevel error -y -i "$1" -frames:v 1 "$tmp" 9>&- || ! mv -f "$tmp" "$dst"; then
            rm -f "$tmp"
            return 1
        fi
    fi
    printf '%s\n' "$dst"
}

# The image to show for wallpaper $1: itself, or a video's still.
still_for() {
    if is_live "$1"; then live_poster "$1"; else printf '%s\n' "$1"; fi
}

thumb_color_path() {
    printf '%s/%s.color\n' "$THUMB_DIR" "$(thumb_hash "$1")"
}

# --- dominant colour ---------------------------------------------------------
#
# The picker sorts and filters the library on one colour per wallpaper, cached
# beside the thumb. Unlike the thumb, that cache is keyed only on the source
# path, so it cannot notice that the *algorithm* changed. Version it: a cache
# written by an older rule is ignored and rebuilt, which stops a collection from
# ever being half-sorted by one rule and half by another.
COLOR_VERSION=3

# v3 adds the image's mean brightness (0-100, mean OKLab-style lightness of the
# same 12-colour histogram) after the hex. The colour sort orders each colour
# family light to dark with it, so a family reads as a gradient, not a shuffle.

# The wallpaper's characteristic colour, not its average.
#
# Two obvious answers are both wrong. The mean pixel of a photo is mud — average
# a sunset and you get grey-brown. The most *frequent* colour of a dark wallpaper
# is its near-black background, which is exactly the part nobody would name the
# image by. So quantise to a small palette and score each entry by frequency
# times chroma: that picks the colour covering the largest *coloured* area. A
# dark image with a teal subject reads as teal, while a genuinely grey image has
# no chroma to find and still resolves to grey.
dominant_color() {
    [ ${#THUMB_CMD[@]} -gt 0 ] || return 1
    "${THUMB_CMD[@]}" "$1" -alpha remove -alpha off -resize '64x64!' \
        -colors 12 -depth 8 -format '%c' histogram:info:- 2>/dev/null | awk '
        # Hand-rolled rather than strtonum(): that is a gawk extension, and a
        # silent zero on mawk would mis-colour the whole library rather than fail.
        function hexval(s,   i, c, v) {
            v = 0
            for (i = 1; i <= length(s); i++) {
                c = index("0123456789ABCDEF", toupper(substr(s, i, 1)))
                if (c == 0)
                    return -1
                v = v * 16 + (c - 1)
            }
            return v
        }
        {
            n = $1 + 0
            hex = ""
            # Alpha-bearing sources can print 8 hex digits; take the leading six.
            for (i = 1; i <= NF; i++)
                if ($i ~ /^#[0-9A-Fa-f]+$/ && length($i) >= 7) { hex = substr($i, 1, 7); break }
            if (hex == "" || n <= 0)
                next
            r = hexval(substr(hex, 2, 2))
            g = hexval(substr(hex, 4, 2))
            b = hexval(substr(hex, 6, 2))
            if (r < 0 || g < 0 || b < 0)
                next
            mx = r; if (g > mx) mx = g; if (b > mx) mx = b
            mn = r; if (g < mn) mn = g; if (b < mn) mn = b
            if (n * (mx - mn) > best) { best = n * (mx - mn); best_hex = hex }
            if (n > most) { most = n; most_hex = hex }
            # Perceived lightness: cube root of linear luminance, weighted by area.
            y = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
            light += n * (y > 0 ? exp(log(y) / 3) : 0)
            total += n
        }
        function lin(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ^ 2.4 }
        # A greyscale image scores zero everywhere, so fall back to its most
        # common shade instead of returning nothing at all.
        END {
            if (total == 0) exit
            printf "%s %d\n", (best_hex != "" ? best_hex : most_hex), light / total * 100 + 0.5
        }'
}

# True when $2 holds a colour written by the *current* algorithm for source $1.
color_is_fresh() {
    local line=""
    thumb_is_fresh "$1" "$2" || return 1
    { read -r line <"$2"; } 2>/dev/null || return 1
    case "$line" in
        "v${COLOR_VERSION} #"??????*) return 0 ;;
        *) return 1 ;;
    esac
}

# True when $2 is a usable thumb for source $1 (present, non-empty, not stale).
thumb_is_fresh() {
    [ -s "$2" ] && [ "$2" -nt "$1" ]
}

# Render src -> dst at the canonical geometry. Atomic: renders to a temp file and
# renames, so a concurrent reader never sees a half-written JPEG (scan-wallpapers'
# concurrent background refreshes can race on the same path). Returns non-zero if no ImageMagick is installed or the render failed.
ensure_thumb() {
    local src="$1" dst="$2" tmp img
    thumb_is_fresh "$src" "$dst" && return 0
    [ ${#THUMB_CMD[@]} -gt 0 ] || return 1
    img=$(still_for "$src") || return 1

    mkdir -p "${dst%/*}" || return 1
    tmp="${dst}.${BASHPID:-$$}.tmp"
    if "${THUMB_CMD[@]}" "$img" -auto-orient -strip \
        -thumbnail "${THUMB_GEOMETRY}^" -gravity center -extent "$THUMB_GEOMETRY" \
        -quality "$THUMB_QUALITY" "jpg:$tmp" 2>/dev/null && mv -f "$tmp" "$dst"; then
        return 0
    fi
    rm -f "$tmp"
    return 1
}
