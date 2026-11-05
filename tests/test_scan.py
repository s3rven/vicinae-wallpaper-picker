"""The scanner's colour hint: hex plus mean brightness, read back from its cache."""

import os
from pathlib import Path
import subprocess
import shutil
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]


class ScanRecords(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='wallpaper library ')
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.library = self.home / 'images 夜'
        self.library.mkdir()
        self.env = {k: v for k, v in os.environ.items() if not k.startswith(('WALLPAPER_', 'AWWW_'))}
        self.env.update(HOME=str(self.home), XDG_CACHE_HOME=str(self.home / 'cache'),
                        XDG_STATE_HOME=str(self.home / 'state'), XDG_CONFIG_HOME=str(self.home / 'config'),
                        WALLPAPER_DIR=str(self.library), WALLPAPER_PICKER_CACHE_ONLY='1')

    def scan(self, *args, **env):
        result = subprocess.run(['bash', str(ROOT / 'scan-wallpapers.sh'), *map(str, args)],
                                env=dict(self.env, **env), capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        return {row[0]: row for row in (line.split('\t') for line in result.stdout.splitlines())}

    def test_spaces_unicode_and_record_delimiters(self):
        good = self.library / 'rain #1 (夜).PNG'
        for file in (good, self.library / 'bad\tname.png', self.library / 'bad\nname.png'):
            file.touch()
        rows = self.scan()
        self.assertEqual(set(rows), {str(good)})
        self.assertEqual(len(rows[str(good)]), 8)

    def test_explicit_preference_wins_over_shell_config(self):
        good = self.library / 'one.jpg'
        good.touch()
        config = self.home / 'config/wallpaper-picker/env'
        config.parent.mkdir(parents=True)
        other = self.home / 'other'
        other.mkdir()
        config.write_text(f'WALLPAPER_DIR="{other}"\n')
        self.assertEqual(set(self.scan(self.library)), {str(good)})

    def test_include_current_only_adds_images_outside_library(self):
        inside = self.library / 'one.jpg'
        outside = self.home / 'outside.png'
        inside.touch(); outside.touch()
        state = self.home / 'state/wallpaper-picker/current'
        state.parent.mkdir(parents=True)
        state.write_text(str(outside) + '\n')
        self.assertEqual(set(self.scan()), {str(inside), str(outside)})
        self.assertEqual(set(self.scan(WALLPAPER_INCLUDE_CURRENT='0')), {str(inside)})
        state.write_text(str(inside) + '\n')
        self.assertEqual(self.scan(WALLPAPER_INCLUDE_CURRENT='0')[str(inside)][3], '1')

    def test_scan_depth_limits_subfolders(self):
        root = self.library / 'root.jpg'
        nested = self.library / 'collection/one.png'
        nested.parent.mkdir()
        root.touch(); nested.touch()
        self.assertEqual(set(self.scan(WALLPAPER_SCAN_DEPTH='1')), {str(root)})
        self.assertEqual(set(self.scan(WALLPAPER_SCAN_DEPTH='2')), {str(root), str(nested)})

    @unittest.skipIf(os.geteuid() == 0, 'root bypasses directory permissions')
    def test_unreadable_library_reports_an_error_instead_of_empty_results(self):
        (self.library / 'one.jpg').touch()
        self.library.chmod(0o111)
        try:
            result = subprocess.run(['bash', str(ROOT / 'scan-wallpapers.sh')], env=self.env,
                                    capture_output=True, text=True, timeout=10)
        finally:
            self.library.chmod(0o700)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('not readable', result.stderr)
        self.assertEqual(result.stdout, '')


@unittest.skipUnless(shutil.which('magick') or shutil.which('convert'), 'ImageMagick is optional')
class Scan(unittest.TestCase):
    def test_colour_hint_carries_brightness(self):
        tmp = tempfile.TemporaryDirectory(prefix='wallpaper-scan-')
        self.addCleanup(tmp.cleanup)
        home = Path(tmp.name)
        library = home / 'walls'
        library.mkdir()
        for name, colour in (('grey.png', '#808080'), ('blue.png', '#3366cc')):
            subprocess.run([shutil.which('magick') or shutil.which('convert'), '-size', '64x40', f'xc:{colour}', str(library / name)], check=True)
        env = {k: v for k, v in os.environ.items() if not k.startswith(('WALLPAPER_', 'AWWW_'))}
        env.update(HOME=str(home), XDG_CACHE_HOME=str(home / 'cache'),
                   XDG_STATE_HOME=str(home / 'state'), XDG_CONFIG_HOME=str(home / 'config'), WALLPAPER_DIR=str(library))

        def scan(**extra):
            out = subprocess.run(['bash', str(ROOT / 'scan-wallpapers.sh')], env=dict(env, **extra),
                                 capture_output=True, text=True, timeout=15, check=True).stdout
            return {Path(fields[0]).name: fields for fields in (line.split('\t') for line in out.splitlines())}

        rows = scan()  # starts the background thumbnail and colour pass
        self.assertTrue(all(len(r) == 8 for r in rows.values()), rows)
        for _ in range(150):
            rows = scan(WALLPAPER_PICKER_CACHE_ONLY='1')
            if all(r[7] for r in rows.values()):
                break
            time.sleep(0.1)
        # Mid grey is 60 on the cube-root-luminance scale; this blue is darker.
        self.assertAlmostEqual(int(rows['grey.png'][7]), 60, delta=2)
        self.assertAlmostEqual(int(rows['blue.png'][7]), 53, delta=2)
        self.assertRegex(rows['blue.png'][4], r'^#[0-9A-Fa-f]{6}$')


if __name__ == '__main__':
    unittest.main()
