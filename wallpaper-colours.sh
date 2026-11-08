#!/usr/bin/env bash
# Matugen palettes for one wallpaper, cached. Prints "index primary tertiary surface"
# (dark scheme) per source colour, from the same thumbnail and seed a matugen
# theme hook uses, so the preview shows the accent the desktop will get.
set -euo pipefail
[ "$#" -eq 1 ] || { printf 'Usage: %s WALLPAPER\n' "$0" >&2; exit 2; }
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=image-lib.sh
. "$script_dir/image-lib.sh"
wallpaper=$(realpath -e -- "$1")
[ -f "$wallpaper" ] && [ -r "$wallpaper" ] || exit 1
cache="$THUMB_DIR/$(thumb_hash "$wallpaper").schemes-v1"
line_re='^[0-3]( #[[:xdigit:]]{6}([[:xdigit:]]{2})?){3}$'

valid() {
    local line count=0
    [ -s "$1" ] || return 1
    while IFS= read -r line; do
        [[ "$line" =~ $line_re ]] || return 1
        count=$((count + 1))
    done <"$1"
    [ "$count" -le 4 ]
}

if thumb_is_fresh "$wallpaper" "$cache" && valid "$cache"; then
    cat -- "$cache"
    exit 0
fi
for tool in matugen jq; do
    command -v "$tool" >/dev/null 2>&1 || { printf 'Install matugen and jq to preview image palettes.\n' >&2; exit 127; }
done
input=$(thumb_path "$wallpaper")
ensure_thumb "$wallpaper" "$input" || input=$wallpaper
mkdir -p -- "$THUMB_DIR"
tmp=$(mktemp "${cache}.XXXXXX")
trap 'rm -f -- "$tmp" "$tmp".?' EXIT

roles() {
    timeout --kill-after=1s 12s matugen "$@" --dry-run --mode dark --json hex 2>/dev/null |
        jq -r --arg i "$index" '.colors as $c | [$i, $c.primary.dark.color, $c.tertiary.dark.color, $c.surface.dark.color] | join(" ")'
}

seed=$(achromatic_seed "$input")
if [ -n "$seed" ]; then
    # A grey image has one honest palette: the one its mean colour seeds.
    index=0 roles color hex "$seed" --type scheme-fidelity >"$tmp" || true
else
    # Up to four source colours; matugen rejects an index the image does not have.
    for index in 0 1 2 3; do
        roles image "$input" --source-color-index "$index" --resize-filter nearest >"$tmp.$index" &
    done
    wait || true
    cat -- "$tmp".? >"$tmp" 2>/dev/null || true
fi
grep -E "$line_re" "$tmp" >"$tmp.v" || true
mv -f -- "$tmp.v" "$tmp"
valid "$tmp" || { printf 'Could not extract a palette from this image.\n' >&2; exit 1; }
mv -fT -- "$tmp" "$cache"
cat -- "$cache"
