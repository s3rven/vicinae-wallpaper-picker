"""Palette previews come from matugen on the cached thumbnail, without generating a theme."""

import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
MAGICK = shutil.which("magick") or shutil.which("convert")
LINE = re.compile(r"^[0-3]( #[0-9a-f]{6}){3}$")


@unittest.skipUnless(MAGICK and shutil.which("matugen") and shutil.which("jq"), "needs ImageMagick, matugen and jq")
class Palette(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="wallpaper-palette-")
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.image = self.home / "scene [2]*.png"
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("WALLPAPER_")}
        self.env.update(HOME=str(self.home), XDG_CACHE_HOME=str(self.home / "cache"),
                        XDG_CONFIG_HOME=str(self.home / "config"))
        self.draw(self.image, "xc:#ee2222", "-fill", "#2244ee", "-draw", "rectangle 60,0 119,79")

    def draw(self, path, *spec):
        subprocess.run([MAGICK, "-size", "120x80", *spec, "png:" + str(path)], check=True)

    def scan(self, image=None):
        result = subprocess.run(["bash", str(ROOT / "wallpaper-colours.sh"), str(image or self.image)],
                                env=self.env, capture_output=True, text=True, timeout=25)
        self.assertEqual(result.returncode, 0, result.stderr)
        lines = result.stdout.splitlines()
        self.assertTrue(1 <= len(lines) <= 4, lines)
        for line in lines:
            self.assertRegex(line, LINE)
        return result.stdout

    def test_each_source_colour_is_a_palette_with_literal_image_names(self):
        primaries = [line.split()[1] for line in self.scan().splitlines()]
        rgb = [tuple(int(h[i:i + 2], 16) for i in (1, 3, 5)) for h in primaries]
        self.assertTrue(any(r > g and r > b for r, g, b in rgb), primaries)
        self.assertTrue(any(b > r for r, _, b in rgb), primaries)

    def test_grey_image_is_not_given_matugens_fallback_blue(self):
        grey = self.home / "grey.png"
        self.draw(grey, "gradient:#202020-#d0d0d0")
        lines = self.scan(grey).splitlines()
        self.assertEqual(len(lines), 1)
        r, g, b = (int(lines[0].split()[1][i:i + 2], 16) for i in (1, 3, 5))
        self.assertLess(max(r, g, b) - min(r, g, b), 24, lines)

    def test_warm_palette_does_not_decode_again(self):
        original = self.scan()
        fake_bin = self.home / "bin"
        fake_bin.mkdir()
        for name in ("magick", "convert", "matugen"):
            tool = fake_bin / name
            tool.write_text("#!/bin/sh\necho 'unexpected image or theme work' >&2\nexit 1\n")
            tool.chmod(0o755)
        self.env["PATH"] = str(fake_bin) + ":" + self.env["PATH"]
        self.assertEqual(self.scan(), original)

    def test_corrupt_cache_is_repaired(self):
        self.scan()
        cache = next((self.home / "cache/wallpaper-picker/thumbs").glob("*.schemes-v1"))
        cache.write_text("not a palette\n")
        self.scan()
        self.assertNotIn("not a palette", cache.read_text())
