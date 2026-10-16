# shellcheck shell=bash
# Shared thumbnail cache contract. Sourced by scan-wallpapers.sh, scan-colors.sh
# and apply-wallpaper-theme.sh.
#
# Why this file exists: the picker guarantees that the palette you preview is the
# palette you get. That holds only because matugen samples the *same pixels* in
# scan-colors.sh (preview) and apply-wallpaper-theme.sh (apply) — which in turn
# holds only if both derive the same cache path and, on a miss, render the thumb
# with the same crop. Those two rules used to be copy-pasted into three scripts.
# Editing the geometry in one and not the others would not error; it would just
# silently start applying a theme that differs from the preview. Keep them here,
# in one place, so that can't happen.

THUMB_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/wallpaper-picker/thumbs"

# Changing either of these invalidates every cached thumb and every cached scheme
# (both are keyed on the source path, not on the geometry). That's fine — they
# regenerate — but preview and apply must always agree, so change them together
# by virtue of there being only one copy.
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
COLOR_VERSION=2

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
                if ($i ~ /^#[0-9A-Fa-f]{6}/) { hex = substr($i, 1, 7); break }
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
        }
        # A greyscale image scores zero everywhere, so fall back to its most
        # common shade instead of returning nothing at all.
        END { if (best_hex != "") print best_hex; else print most_hex }'
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
# background refresh and an on-demand build from scan-colors can race on the same
# path). Returns non-zero if no ImageMagick is installed or the render failed.
ensure_thumb() {
    local src="$1" dst="$2" tmp
    thumb_is_fresh "$src" "$dst" && return 0
    [ ${#THUMB_CMD[@]} -gt 0 ] || return 1

    mkdir -p "${dst%/*}" || return 1
    tmp="${dst}.${BASHPID:-$$}.tmp"
    if "${THUMB_CMD[@]}" "$src" -auto-orient -strip \
        -thumbnail "${THUMB_GEOMETRY}^" -gravity center -extent "$THUMB_GEOMETRY" \
        -quality "$THUMB_QUALITY" "jpg:$tmp" 2>/dev/null && mv -f "$tmp" "$dst"; then
        return 0
    fi
    rm -f "$tmp"
    return 1
}

# The input matugen should sample for `src`: the cached thumb when it's fresh
# (3-5x faster than decoding a 4K source, identical extraction), else the source.
# Builds the thumb on demand so preview and apply agree even when the picker's
# background refresh hasn't reached this wallpaper yet.
matugen_input_for() {
    local src="$1" thumb
    thumb=$(thumb_path "$src")
    ensure_thumb "$src" "$thumb" || true
    if thumb_is_fresh "$src" "$thumb"; then
        printf '%s\n' "$thumb"
    else
        printf '%s\n' "$src"
    fi
}
