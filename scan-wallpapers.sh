#!/usr/bin/env bash
# Scan wallpapers and refresh thumbnails in a private cache.
# Output one line per wallpaper:
# <source_path>\t<name>\t<thumb_path>\t<is_current>\t<avg_color>\t<folder>\t<mtime>
set -uo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" 2>/dev/null && pwd -P)
# shellcheck source=thumb-lib.sh
. "$script_dir/thumb-lib.sh"

dir="${WALLPAPER_DIR:-$HOME/Pictures/wallpaper}"
scan_depth="${WALLPAPER_SCAN_DEPTH:-2}"
include_current="${WALLPAPER_INCLUDE_CURRENT:-1}"
# The picker exposes these as a dropdown/checkbox, but keep the script safe and
# useful when called directly from a shell with an invalid environment value.
case "$scan_depth" in
    1|2|3|4|5) ;;
    *) scan_depth=2 ;;
esac
case "$include_current" in
    0|1) ;;
    *) include_current=1 ;;
esac
[ -d "$dir" ] || {
    printf 'Wallpaper folder not found: %s\n' "$dir" >&2
    exit 1
}
# Stable absolute paths keep folder labels, metadata and thumbnail keys the
# same for relative paths, symlinked folders and a trailing slash preference.
dir=$(cd -- "$dir" && pwd -P) || exit 1
thumb_dir="$THUMB_DIR"
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}"
wallpaper_state="${WALLPAPER_STATE_FILE:-$state_dir/theme/generated/wallpaper/path.txt}"
mkdir -p "$thumb_dir"

current=$(cat "$wallpaper_state" 2>/dev/null || true)

# mtime comes straight off the find walk (-printf '%T@') rather than a stat fork
# per file — it's free here, and the picker's "recent" sort needs it. Records are
# "<mtime>\t<path>", so sort on field 2 to keep the by-path ordering this list
# has always had.
files=()
declare -A MTIME=()
[ "$include_current" = 1 ] && [ -n "$current" ] && [ -f "$current" ] && files+=("$current")

while IFS=$'\t' read -r -d '' mtime f; do
    MTIME["$f"]=${mtime%.*}
    # When the current image is inside the selected directory it is part of the
    # ordinary library. The include-current switch only controls the special
    # outside-the-folder entry we add before the walk.
    [ "$f" = "$current" ] && [ "$include_current" = 1 ] && continue
    files+=("$f")
done < <(find "$dir" -maxdepth "$scan_depth" -type f \
    \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' -o -iname '*.webp' \) \
    -printf '%T@\t%p\0' 2>/dev/null | sort -z -t$'\t' -k2)

# The current wallpaper can live outside $dir, so the walk above may not have
# seen it. One stat, not a per-file cost.
if [ -n "$current" ] && [ -f "$current" ] && [ -z "${MTIME["$current"]:-}" ]; then
    MTIME["$current"]=$(stat -c %Y -- "$current" 2>/dev/null || echo 0)
fi

# Batch path→sha1 map: one python process instead of a sha1sum fork per file
# per use — the per-file forks dominated warm-open latency as the collection
# grew. Same hash (sha1 of the path bytes, no trailing newline), so existing
# thumb caches stay valid. Falls back to sha1sum when python is absent.
declare -A PATH_SHA=()
build_path_sha() {
    [ ${#files[@]} -gt 0 ] || return 0
    command -v python3 >/dev/null 2>&1 || return 0
    while IFS=$'\t' read -r h f; do
        [ -n "$h" ] && PATH_SHA["$f"]="$h"
    done < <(printf '%s\n' "${files[@]}" | python3 -c '
import sys, hashlib
for p in sys.stdin.buffer.read().split(b"\n"):
    if p:
        sys.stdout.buffer.write(hashlib.sha1(p).hexdigest().encode() + b"\t" + p + b"\n")
')
}

# Hash from the prebuilt map when we have it, else fall back to the shared
# reference implementation (identical output — see thumb-lib.sh).
path_sha() {
    local h=${PATH_SHA["$1"]:-}
    [ -n "$h" ] || h=$(thumb_hash "$1")
    printf '%s\n' "$h"
}

thumb_for() {
    printf '%s/%s.jpg\n' "$thumb_dir" "$(path_sha "$1")"
}

# Sets $folder instead of printing it, because the caller is a per-wallpaper
# loop and `$(folder_for ...)` is a subshell fork: on a ~100-file library those
# forks were about half of a ~100ms scan. The loop stays fork-free on the warm
# path (batched sha1 map, inlined colour-cache read).
folder_for() {
    local src="$1" rel
    case "$src" in
        "$dir"/*)
            rel=${src#"$dir"/}
            folder=${rel%/*}
            if [ "$folder" = "$rel" ] || [ -z "$folder" ]; then
                folder=Root
            fi
            ;;
        *)
            folder=Current
            ;;
    esac
}

parallel=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)
[ "$parallel" -gt 8 ] && parallel=8
[ "$parallel" -lt 2 ] && parallel=2

missing_src=()
missing_dst=()

build_path_sha

for src in "${files[@]}"; do
    is_current=0
    [ "$src" = "$current" ] && is_current=1

    # Fork-free on the warm path: hash from the prebuilt map.
    file_hash=${PATH_SHA["$src"]:-}
    [ -z "$file_hash" ] && file_hash=$(thumb_hash "$src")
    dst="${thumb_dir}/${file_hash}.jpg"
    if ! thumb_is_fresh "$src" "$dst"; then
        missing_src+=("$src")
        missing_dst+=("$dst")
        # Hand Vicinae the source meanwhile so a new image is visible immediately.
        dst="$src"
    fi

    # Inlined rather than calling color_is_fresh: that would be a fork per file
    # on the warm path this loop is otherwise careful to keep fork-free. A cache
    # from an older extraction rule is skipped here and rewritten by the
    # background pass below.
    color_hint=""
    cached_color=""
    color_file="${thumb_dir}/${file_hash}.color"
    if [ -s "$color_file" ] && [ "$color_file" -nt "$src" ]; then
        { read -r cached_color < "$color_file"; } 2>/dev/null || cached_color=""
        case "$cached_color" in
            "v${COLOR_VERSION} #"??????*) color_hint=${cached_color#* } ;;
        esac
    fi
    folder_for "$src"
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$src" "${src##*/}" "$dst" "$is_current" "$color_hint" "$folder" "${MTIME["$src"]:-0}"
done

cleanup_cache() {
    local keep_file cached_file

    # Defence in depth: with an empty keep-list, the comm below classifies every
    # cached file as an orphan and deletes the whole cache. Never run on no data.
    [ ${#files[@]} -gt 0 ] || return 0

    keep_file=$(mktemp "$thumb_dir/.keep.XXXXXX")   || return 0
    cached_file=$(mktemp "$thumb_dir/.cached.XXXXXX") || { rm -f "$keep_file"; return 0; }

    for src in "${files[@]}"; do
        thumb_for "$src"
    done | sort >"$keep_file"

    find "$thumb_dir" -maxdepth 1 -type f \( -name '*.jpg' -o -name '*.color' \) -print 2>/dev/null \
        | sort >"$cached_file"

    {
        cat "$keep_file"
        sed 's/[.]jpg$/.color/' "$keep_file"
    } | sort -u >"${keep_file}.all"

    # xargs splits a cache path containing spaces into unrelated arguments.
    comm -23 "$cached_file" "${keep_file}.all" | while IFS= read -r orphan; do
        rm -f -- "$orphan"
    done

    rm -f "$keep_file" "${keep_file}.all" "$cached_file"
}

# Cache keys use the absolute source path, so a thumbnail remains valid when
# the picker switches folders or scan depth. A normal scan only knows its own
# current view; pruning against that view deletes valid thumbs from other views
# and forces them to render again on the next switch. Keep the small cache by
# default. An intentional full-library maintenance run can request pruning,
# but an empty result (or only the out-of-folder current wallpaper) cannot.
library_count=0
for src in "${files[@]}"; do
    case "$src" in "$dir"/*) library_count=$((library_count + 1));; esac
done
needs_cleanup=0
if [ "${WALLPAPER_PICKER_PRUNE_CACHE:-0}" = 1 ] && [ "$library_count" -gt 0 ]; then
    needs_cleanup=1
fi

refresh_thumbs() {
    [ ${#THUMB_CMD[@]} -gt 0 ] || return
    local i n=0
    for i in "${!missing_src[@]}"; do
        ensure_thumb "${missing_src[$i]}" "${missing_dst[$i]}" &
        n=$((n + 1))
        # Keep all workers busy: launch a new job the moment ANY finishes
        # (wait -n) instead of draining the whole batch and idling fast cores.
        if [ "$n" -ge "$parallel" ]; then wait -n 2>/dev/null || wait; n=$((n - 1)); fi
    done
    wait
}

# Extract and cache each wallpaper's dominant colour as a single hex string.
# The picker sorts by its hue and filters by its colour group. Runs after refresh_thumbs
# so the thumb is guaranteed to exist when we sample it — one magick call per
# file against the small cached thumb, fast even on large batches.
generate_color_hints() {
    [ ${#THUMB_CMD[@]} -gt 0 ] || return
    local src fh t c n=0
    for src in "${files[@]}"; do
        fh="${PATH_SHA["$src"]:-}"
        [ -z "$fh" ] && fh=$(thumb_hash "$src")
        t="${thumb_dir}/${fh}.jpg"
        c="${thumb_dir}/${fh}.color"
        color_is_fresh "$src" "$c" && continue
        thumb_is_fresh "$src" "$t" || continue
        (
            color_tmp="${c}.${BASHPID:-$$}.tmp"
            hex=$(dominant_color "$t") || exit 0
            if [ "${#hex}" -eq 7 ] && printf 'v%s %s\n' "$COLOR_VERSION" "$hex" >"$color_tmp"; then
                mv -f "$color_tmp" "$c"
            fi
            rm -f "$color_tmp"
        ) &
        n=$((n + 1))
        if [ "$n" -ge "$parallel" ]; then wait -n 2>/dev/null || wait; n=$((n - 1)); fi
    done
    wait
}

# Follow-up reads from the extension must not enqueue another background worker.
# The initial scan already owns cache generation; these reads only report how
# much of its work is ready for the grid to repaint.
[ "${WALLPAPER_PICKER_CACHE_ONLY:-0}" = 1 ] && exit 0

# Run in background so the script exits immediately after printing the file list.
# Vicinae receives all output via the pipe; the heavy work continues asynchronously.
(
    # Serialize cache work, including a scan for a different folder while the
    # previous one is still rendering. Dropping the second worker here leaves
    # that folder showing full-size source images until the picker is reopened.
    # Waiting queues at most lightweight shell workers; ensure_thumb and
    # color_is_fresh skip work another worker has already completed.
    if command -v flock >/dev/null 2>&1; then
        exec 9>"$thumb_dir/.refresh.lock"
        flock -w 20 9 || exit 0
    fi
    [ "$needs_cleanup" = 1 ] && cleanup_cache
    refresh_thumbs
    generate_color_hints
) >/dev/null 2>&1 &
disown
