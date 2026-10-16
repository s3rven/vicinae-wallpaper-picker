#!/usr/bin/env bash
# Extract matugen colour schemes for a wallpaper, with per-wallpaper caching.
# `--color #RRGGBB` previews one exact custom source colour instead.
# Output: one line per scheme — "index source primary tertiary surface"
set -uo pipefail

if [ "$#" -lt 1 ]; then
    echo "Usage: $0 WALLPAPER | --color #RRGGBB" >&2
    exit 2
fi

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" 2>/dev/null && pwd -P)
# shellcheck source=thumb-lib.sh
. "$script_dir/thumb-lib.sh"

if [ "$1" = "--color" ]; then
    if [ "$#" -lt 2 ]; then
        echo "Usage: $0 --color #RRGGBB" >&2
        exit 2
    fi

    custom_color=$2
    # A hand-picked colour should preserve its hue/chroma as closely as the
    # contrast-safe Material roles allow. The default tonal-spot scheme is ideal
    # for expressive wallpaper extraction, but can turn neutral custom seeds
    # into unrelated hues (for example, black into pink).
    custom_scheme_type=${WALLPAPER_PICKER_CUSTOM_SCHEME_TYPE:-scheme-fidelity}
    [[ "$custom_color" = \#* ]] || custom_color="#$custom_color"
    if [[ ! "$custom_color" =~ ^\#[[:xdigit:]]{6}$ ]]; then
        echo "Invalid custom colour: $2" >&2
        exit 2
    fi

    if command -v jq >/dev/null 2>&1; then
        timeout 12 matugen color hex "$custom_color" --type "$custom_scheme_type" --dry-run --mode dark --json hex 2>/dev/null |
            jq -r '.colors as $c | ["-1", $c.source_color.dark.color, $c.primary.dark.color, $c.tertiary.dark.color, $c.surface.dark.color] | join(" ")'
    else
        timeout 12 matugen color hex "$custom_color" --type "$custom_scheme_type" --dry-run --mode dark --json hex 2>/dev/null |
            python3 -c '
import sys, json
c = json.load(sys.stdin)["colors"]
print(-1, *(c[r]["dark"]["color"] for r in ("source_color", "primary", "tertiary", "surface")))
'
    fi
    exit $?
fi

wallpaper="$1"
if [ ! -f "$wallpaper" ]; then
    echo "Wallpaper not found: $wallpaper" >&2
    exit 1
fi
wallpaper=$(realpath -e -- "$wallpaper") || exit 1
cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/wallpaper-picker/schemes"
hash=$(printf '%s' "$wallpaper" | md5sum | cut -d' ' -f1)
cache_file="${cache_dir}/${hash}"

mkdir -p "$cache_dir" || exit 1

# The roles the picker reads, in output order. Cache validation and both parser
# implementations derive their expected shape from this list.
ROLES=(source_color primary tertiary surface)
ROLE_COUNT=${#ROLES[@]}

scheme_cache_is_valid() {
    local line seen=0
    declare -A indices=()
    while IFS= read -r line || [ -n "$line" ]; do
        [[ "$line" =~ ^[0-3](\ #[[:xdigit:]]{6}([[:xdigit:]]{2})?){$ROLE_COUNT}$ ]] || return 1
        index=${line%% *}
        [ -z "${indices[$index]:-}" ] || return 1
        indices[$index]=1
        seen=1
    done <"$cache_file"
    [ "$seen" = 1 ]
}

# Revisiting the same image while its first preview is extracting should share
# that work, not launch another four image decodes. Other images stay parallel.
exec 8>"${cache_file}.lock"
if ! flock -w 15 8; then
    printf 'Timed out waiting for this wallpaper palette. Try again.\n' >&2
    exit 1
fi

# A partial write used to remain a "fresh" cache hit forever. Validate before
# returning it; malformed entries are removed and regenerated below.
if [ -s "$cache_file" ] && [ "$cache_file" -nt "$wallpaper" ] && scheme_cache_is_valid; then
    cat "$cache_file"
    exit 0
fi
rm -f "$cache_file"

# Sample the cached thumb rather than the original: a much smaller input (avoids
# decoding a 4K PNG four times) with no effect on colour quality. Built on demand
# if scan-wallpapers.sh's background refresh hasn't reached this wallpaper yet, so
# the preview and the eventual apply sample the SAME pixels.
matugen_input=$(matugen_input_for "$wallpaper")

tmpfile=$(mktemp)
cache_tmp="${cache_file}.$$.tmp"

cleanup() {
    local -a children=()
    mapfile -t children < <(jobs -pr 2>/dev/null || true)
    if [ "${#children[@]}" -gt 0 ]; then
        kill "${children[@]}" 2>/dev/null || true
        wait 2>/dev/null || true
    fi
    rm -f "$tmpfile" "$cache_tmp"
}

# If this process is stopped (the caller gave up), Bash's four parallel Matugen
# children would otherwise survive their parent and keep burning CPU.
trap cleanup EXIT
trap 'exit 130' INT TERM

# jq starts ~10x faster than python3 — saves ~120-180ms across the 4 parallel
# calls. Python fallback in case jq isn't installed.
if command -v jq >/dev/null 2>&1; then
    PARSER="jq"
else
    PARSER="python"
fi

# ".colors.<role>.dark.color" for each role, joined into one space-separated line.
# shellcheck disable=SC2016 # jq variables are intentionally expanded by jq.
JQ_FILTER='.colors as $c | [$idx] + ($roles | split(",") | map($c[.].dark.color)) | join(" ")'

get_color() {
    local idx="$1" src="$2"
    local out roles_csv
    roles_csv=$(IFS=,; printf '%s' "${ROLES[*]}")

    if [ "$PARSER" = "jq" ]; then
        out=$(timeout 12 matugen image "$src" --dry-run \
            --source-color-index "$idx" --mode dark \
            --json hex --resize-filter nearest \
            2>/dev/null | \
            jq -r --arg idx "$idx" --arg roles "$roles_csv" "$JQ_FILTER" \
            2>/dev/null) || true
    else
        out=$(timeout 12 matugen image "$src" --dry-run \
            --source-color-index "$idx" --mode dark \
            --json hex --resize-filter nearest \
            2>/dev/null | \
            ROLES_CSV="$roles_csv" IDX="$idx" python3 -c '
import sys, json, os
c = json.load(sys.stdin)["colors"]
roles = os.environ["ROLES_CSV"].split(",")
print(os.environ["IDX"], *(c[r]["dark"]["color"] for r in roles))
' 2>/dev/null) || true
    fi

    # Shape check: an index followed by exactly ROLE_COUNT hex colours. Guards
    # against matugen partial output and against this script and the extension's
    # parser silently disagreeing on the field count.
    if [[ "$out" =~ ^[0-3](\ #[[:xdigit:]]{6}([[:xdigit:]]{2})?){$ROLE_COUNT}$ ]]; then
        printf '%s\n' "$out" >> "$tmpfile"
        printf '%s\n' "$out"
    fi
}

for i in 0 1 2 3; do get_color "$i" "$matugen_input" & done
wait

if [ -s "$tmpfile" ]; then
    sort -n "$tmpfile" | awk '!seen[$1]++' > "$cache_tmp"
    # Matugen may expose anywhere from one to four valid source-colour indices
    # for an image. Cache the complete set of successful candidates even when
    # there is only one; treating a one-colour image as an incomplete run made
    # every visit launch four more Matugen processes.
    mv -f "$cache_tmp" "$cache_file"
else
    printf 'Could not extract a palette from this image. Try another image or retry.\n' >&2
    exit 1
fi
