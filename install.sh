#!/usr/bin/env bash
# Install from a clone or extracted source release; no root access required.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
mode=install
invoking_dir=$PWD
output=""
usage() {
    printf 'Usage: %s [--check | --build-only] [--output DIRECTORY]\n' "$0"
    printf '  --check       Check dependencies without changing anything.\n'
    printf '  --build-only  Build into release/extension instead of installing.\n'
    printf '  --output DIR  Build into DIR instead of installing.\n'
}
while [ "$#" -gt 0 ]; do
    case "$1" in
        --check) mode=check ;;
        --build-only) mode=build ;;
        --output)
            [ "$#" -ge 2 ] && [ -n "$2" ] || { usage >&2; exit 2; }
            output=$2; mode=build; shift ;;
        --help|-h) usage; exit 0 ;;
        *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
    esac
    shift
done

[ "$(uname -s)" = Linux ] || { printf 'This picker needs Linux and a Wayland compositor with awww support.\n' >&2; exit 1; }
if [ "${BASH_VERSINFO[0]}" -lt 4 ] || { [ "${BASH_VERSINFO[0]}" -eq 4 ] && [ "${BASH_VERSINFO[1]}" -lt 4 ]; }; then
    printf 'Bash 4.4 or newer is required.\n' >&2; exit 1
fi
missing=()
for tool in node npm awww awww-daemon flock realpath sha1sum find sort timeout; do
    command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
done
if [ "${#missing[@]}" -gt 0 ]; then
    printf 'Missing required tools: %s\n' "${missing[*]}" >&2
    printf 'Install Node.js 22+, npm, awww, util-linux, coreutils and findutils with your package manager, then retry.\n' >&2
    exit 127
fi
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)' || {
    printf 'Node.js 22 or newer is required to build the extension.\n' >&2; exit 1;
}
printf 'Required dependencies found.\n'
if ! command -v magick >/dev/null 2>&1 && ! command -v convert >/dev/null 2>&1; then
    printf 'Optional: install ImageMagick for thumbnails and colour filters.\n'
fi
for tool in python3 mpvpaper ffmpeg ffprobe systemctl systemd-run; do
    command -v "$tool" >/dev/null 2>&1 || printf 'Optional for live wallpapers: %s\n' "$tool"
done
[ "$mode" != check ] || exit 0

cd -- "$root/vicinae"
npm ci --no-audit --no-fund
npm run bundle
if [ "$mode" = build ]; then
    output=${output:-$root/release/extension}
    # Relative output paths are relative to the invoking directory.
    case "$output" in /*) ;; *) output="$invoking_dir/$output" ;; esac
    npx --no-install vici build --out "$output"
    printf '\nBuilt extension at %s\n' "$output"
else
    npx --no-install vici build
    printf '\nInstalled Wallpaper Picker. Open Set Wallpaper in Vicinae.\n'
    printf 'Choose your wallpaper folder in the extension preferences.\n'
fi
