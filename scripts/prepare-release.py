#!/usr/bin/env python3
"""Export reviewed source files without Git history or local machine metadata."""

import argparse
import gzip
import io
import json
from pathlib import Path, PurePosixPath
import re
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
PREFIX = "vicinae-wallpaper-picker"
PATTERNS = {
    "absolute home path": re.compile(rb"/(?:home|Users)/[^/\s\x00]+/"),
    "private key": re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "GitHub token": re.compile(rb"(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})"),
    "AWS access key": re.compile(rb"(?:AKIA|ASIA)[A-Z0-9]{16}"),
    "private network address": re.compile(rb"(?<![\d.])(?:192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)(?![\d.])"),
}


def build_archive(root, target):
    manifest = json.loads((root / "scripts/release-manifest.json").read_text())
    names = sorted(set(manifest["backend"] + manifest["source"]))
    contents = []
    for name in names:
        path = PurePosixPath(name)
        if path.is_absolute() or ".." in path.parts or not path.parts:
            raise ValueError(f"Invalid release entry: {name}")
        source = root
        for part in path.parts:
            source = source / part
            if source.is_symlink():
                raise ValueError(f"Release entry is a symlink: {name}")
        if not source.is_file():
            raise ValueError(f"Missing release file: {name}")
        data = source.read_bytes()
        for label, pattern in PATTERNS.items():
            if pattern.search(data):
                # Report the file and rule, never repeat a suspected secret.
                raise ValueError(f"Review {name}: detected {label}")
        executable = name in manifest["backend"] or name in ("install.sh", "examples/matugen/post-apply.sh")
        contents.append((name, data, 0o755 if executable else 0o644))

    target.parent.mkdir(parents=True, exist_ok=True)
    # Validate everything before replacing a previous export. Tar/gzip headers
    # contain no local user, group, timestamp or absolute checkout path.
    with tempfile.TemporaryDirectory(dir=target.parent) as tmp:
        archive = Path(tmp) / "source.tar.gz"
        with archive.open("wb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as gz:
            with tarfile.open(fileobj=gz, mode="w") as tar:
                for name, data, mode in contents:
                    entry = tarfile.TarInfo(f"{PREFIX}/{name}")
                    entry.mode = mode
                    entry.size = len(data)
                    tar.addfile(entry, io.BytesIO(data))
        archive.replace(target)
    return len(contents)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "release" / f"{PREFIX}-source.tar.gz")
    args = parser.parse_args()
    try:
        count = build_archive(ROOT, args.output)
    except (OSError, ValueError) as error:
        parser.exit(1, f"Release export failed: {error}\n")
    print(f"Exported {count} reviewed files to {args.output}")


if __name__ == "__main__":
    main()
