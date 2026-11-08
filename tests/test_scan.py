"""The scanner's colour hint: hex plus mean brightness, read back from its cache."""

import os
import hashlib
import json
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

    def test_opt_in_prune_keeps_live_entries_and_drops_orphans_and_retired_caches(self):
        image = self.library / 'kept.png'
        image.touch()
        thumbs = self.home / 'cache/wallpaper-picker/thumbs'
        thumbs.mkdir(parents=True)
        kept = hashlib.sha1(str(image).encode()).hexdigest()
        keep = [thumbs / f'{kept}.{ext}' for ext in ('jpg', 'schemes-v1')]
        drop = [thumbs / f'gone.{ext}' for ext in ('jpg', 'color', 'schemes-v1')] + [thumbs / f'{kept}.palette-v1']
        for file in keep + drop:
            file.write_text('x')
            os.utime(file, (time.time() + 60, time.time() + 60))
        self.scan(WALLPAPER_PICKER_CACHE_ONLY='0', WALLPAPER_PICKER_PRUNE_CACHE='1')
        for _ in range(100):
            if not any(file.exists() for file in drop):
                break
            time.sleep(0.05)
        self.assertEqual([file for file in drop if file.exists()], [])
        self.assertTrue(all(file.exists() for file in keep))

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

    def test_current_wallpaper_with_a_record_delimiter_is_skipped(self):
        normal = self.library / 'normal.jpg'
        normal.touch()
        state = self.home / 'state/wallpaper-picker/current'
        state.parent.mkdir(parents=True)
        for name in ('bad\nname.png', 'bad\tname.png'):
            source = self.home / name
            source.touch()
            state.write_text(str(source) + '\n')
            self.assertEqual(set(self.scan()), {str(normal)})

    def test_scan_depth_limits_subfolders(self):
        root = self.library / 'root.jpg'
        nested = self.library / 'collection/one.png'
        nested.parent.mkdir()
        root.touch(); nested.touch()
        self.assertEqual(set(self.scan(WALLPAPER_SCAN_DEPTH='1')), {str(root)})
        self.assertEqual(set(self.scan(WALLPAPER_SCAN_DEPTH='2')), {str(root), str(nested)})

    def test_cache_reads_never_decode_video(self):
        video = self.library / 'slow clip.mp4'
        video.touch()
        bin_dir = self.home / 'bin'
        bin_dir.mkdir()
        trace = self.home / 'ffmpeg-was-called'
        ffmpeg = bin_dir / 'ffmpeg'
        ffmpeg.write_text('#!/bin/sh\ntouch "$TEST_FFMPEG_TRACE"\nexit 1\n')
        ffmpeg.chmod(0o755)
        rows = self.scan(PATH=f'{bin_dir}:{os.environ["PATH"]}', TEST_FFMPEG_TRACE=str(trace))
        self.assertEqual(rows[str(video)][2], str(video))  # UI video icon
        self.assertFalse(trace.exists(), 'cache-only reads must never start a decoder')

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
    def test_ready_image_colours_do_not_wait_for_a_blocked_video(self):
        with tempfile.TemporaryDirectory(prefix='wallpaper-progress-') as tmp:
            home = Path(tmp)
            library = home / 'walls'
            library.mkdir()
            magick = shutil.which('magick') or shutil.which('convert')
            subprocess.run([magick, '-size', '64x40', 'xc:blue', str(library / 'still.png')], check=True)
            for index in range(8):
                (library / f'blocked-{index}.mp4').touch()
            bin_dir = home / 'bin'
            bin_dir.mkdir()
            started, release = home / 'started', home / 'release'
            decoder = bin_dir / 'ffmpeg'
            decoder.write_text('#!/bin/sh\ntouch "$TEST_STARTED"\nwhile [ ! -f "$TEST_RELEASE" ]; do sleep .02; done\nexit 1\n')
            decoder.chmod(0o755)
            env = {k: v for k, v in os.environ.items() if not k.startswith(('WALLPAPER_', 'AWWW_'))}
            env.update(HOME=tmp, PATH=f'{bin_dir}:{os.environ["PATH"]}', XDG_CONFIG_HOME=str(home / 'config'),
                       XDG_CACHE_HOME=str(home / 'cache'), XDG_STATE_HOME=str(home / 'state'),
                       TEST_STARTED=str(started), TEST_RELEASE=str(release))
            def scan(**extra):
                result = subprocess.run(['bash', str(ROOT / 'scan-wallpapers.sh'), str(library)],
                                        env=dict(env, **extra), capture_output=True, text=True, timeout=10, check=True)
                return {Path(row[0]).name: row for row in (line.split('\t') for line in result.stdout.splitlines())}
            try:
                scan()
                deadline = time.monotonic() + 4
                while time.monotonic() < deadline:
                    rows = scan(WALLPAPER_PICKER_CACHE_ONLY='1')
                    if started.exists() and rows['still.png'][4]:
                        break
                    time.sleep(.03)
                self.assertTrue(started.exists())
                self.assertRegex(rows['still.png'][4], r'^#[0-9A-Fa-f]{6}$')
                self.assertEqual(rows['blocked-0.mp4'][2], str(library / 'blocked-0.mp4'))
            finally:
                release.touch()
                subprocess.run(['flock', '-w', '3', str(home / 'cache/wallpaper-picker/thumbs/.refresh.lock'), 'true'], check=True)

    def test_malformed_colour_hints_are_ignored_and_rebuilt(self):
        with tempfile.TemporaryDirectory(prefix='wallpaper-colour-repair-') as tmp:
            home = Path(tmp)
            library = home / 'walls'
            library.mkdir()
            thumbs = home / 'cache/wallpaper-picker/thumbs'
            thumbs.mkdir(parents=True)
            magick = shutil.which('magick') or shutil.which('convert')
            invalid = ['v3 #zzzzzz 42', 'v3 #3366cc 999', 'v3 #3366cc', 'v2 #3366cc 40']
            for index, hint in enumerate(invalid):
                source = library / f'{index}.png'
                subprocess.run([magick, '-size', '64x40', 'xc:blue', str(source)], check=True)
                key = hashlib.sha1(str(source).encode()).hexdigest()
                subprocess.run([magick, str(source), str(thumbs / f'{key}.jpg')], check=True)
                (thumbs / f'{key}.color').write_text(hint + '\n')
            env = {k: v for k, v in os.environ.items() if not k.startswith(('WALLPAPER_', 'AWWW_'))}
            env.update(HOME=tmp, XDG_CONFIG_HOME=str(home / 'config'), XDG_CACHE_HOME=str(home / 'cache'),
                       XDG_STATE_HOME=str(home / 'state'))
            def scan(**extra):
                result = subprocess.run(['bash', str(ROOT / 'scan-wallpapers.sh'), str(library)],
                                        env=dict(env, **extra), capture_output=True, text=True, timeout=10, check=True)
                return [line.split('\t') for line in result.stdout.splitlines()]
            initial = scan()
            self.assertTrue(all(not row[4] and not row[7] for row in initial))
            for _ in range(100):
                rows = scan(WALLPAPER_PICKER_CACHE_ONLY='1')
                if all(row[4] and row[7] for row in rows):
                    break
                time.sleep(.03)
            self.assertTrue(all(row[4] and 0 <= int(row[7]) <= 100 for row in rows))

    def test_timed_out_render_preserves_previous_preview_and_limits_threads(self):
        with tempfile.TemporaryDirectory(prefix='wallpaper-render-timeout-') as tmp:
            home = Path(tmp)
            source, target = home / 'source.png', home / 'preview.jpg'
            source.touch()
            target.write_bytes(b'previous preview')
            os.utime(target, (1, 1))
            bin_dir = home / 'bin'
            bin_dir.mkdir()
            trace = home / 'timeout.json'
            timeout = bin_dir / 'timeout'
            timeout.write_text('#!/usr/bin/env python3\nimport json, os, sys\n'
                               'with open(os.environ["TEST_TIMEOUT_TRACE"], "w") as f:\n'
                               ' json.dump([sys.argv[1:], os.environ.get("MAGICK_THREAD_LIMIT")], f)\n'
                               'sys.exit(124)\n')
            timeout.chmod(0o755)
            env = dict(os.environ, HOME=tmp, XDG_CONFIG_HOME=str(home / 'config'),
                       PATH=f'{bin_dir}:{os.environ["PATH"]}', TEST_TIMEOUT_TRACE=str(trace))
            result = subprocess.run(['bash', '-c', '. "$1"; ensure_thumb "$2" "$3"',
                                     'fixture', str(ROOT / 'image-lib.sh'), str(source), str(target)],
                                    env=env, capture_output=True, text=True, timeout=5)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(target.read_bytes(), b'previous preview')
            self.assertEqual(list(home.glob('preview.jpg.*')), [])
            args, threads = json.loads(trace.read_text())
            self.assertEqual(args[:2], ['--kill-after=1s', '10s'])
            self.assertEqual(threads, '1')

    def test_animated_webp_generates_one_atomic_thumbnail(self):
        with tempfile.TemporaryDirectory(prefix='wallpaper-animated-') as tmp:
            home = Path(tmp)
            magick = shutil.which('magick') or shutil.which('convert')
            animation = home / 'animation.webp'
            subprocess.run([magick, '-size', '64x40', 'xc:blue', '-delay', '10',
                            'xc:red', '-loop', '0', str(animation)], check=True)
            # Quoting a filename does not stop ImageMagick's own glob expansion.
            # The ordinary sibling makes * and ? select extra input sequences.
            sources = [home / name for name in ('animated [wallpaper].webp',
                                                'animated*.webp', 'animated?.webp',
                                                'animated1.webp')]
            for source in sources:
                shutil.copyfile(animation, source)
            env = dict(os.environ, HOME=tmp, XDG_CONFIG_HOME=str(home / 'config'))
            for index, source in enumerate(sources):
                with self.subTest(source=source.name):
                    target = home / f'thumb-{index}.jpg'
                    result = subprocess.run(['bash', '-c', '. "$1"; ensure_thumb "$2" "$3"',
                                             'fixture', str(ROOT / 'image-lib.sh'), str(source), str(target)],
                                            env=env, capture_output=True, text=True, timeout=10)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertTrue(target.is_file())
                    self.assertGreater(target.stat().st_size, 0)
                    self.assertEqual(list(home.glob(f'{target.name}.*')), [])

    @unittest.skipUnless(shutil.which('ffmpeg'), 'ffmpeg is optional')
    def test_video_preview_is_generated_after_the_initial_records(self):
        with tempfile.TemporaryDirectory(prefix='wallpaper-video-scan-') as tmp:
            home = Path(tmp)
            library = home / 'walls'
            library.mkdir()
            video = library / 'clip.mp4'
            subprocess.run(['ffmpeg', '-nostdin', '-loglevel', 'error', '-f', 'lavfi',
                            '-i', 'color=c=blue:s=64x40:d=0.2', str(video)], check=True)
            env = {k: v for k, v in os.environ.items() if not k.startswith(('WALLPAPER_', 'AWWW_'))}
            env.update(HOME=tmp, XDG_CONFIG_HOME=str(home / 'config'),
                       XDG_CACHE_HOME=str(home / 'cache'), XDG_STATE_HOME=str(home / 'state'))

            def scan(**extra):
                return subprocess.run(['bash', str(ROOT / 'scan-wallpapers.sh'), str(library)],
                                      env=dict(env, **extra), capture_output=True, text=True,
                                      timeout=10, check=True).stdout.rstrip('\n').split('\t')

            initial = scan()
            self.assertEqual(initial[2], str(video))
            for _ in range(100):
                cached = scan(WALLPAPER_PICKER_CACHE_ONLY='1')
                if cached[2].endswith('.jpg') and cached[4]:
                    break
                time.sleep(.05)
            self.assertTrue(cached[2].endswith('.jpg'), cached)
            self.assertTrue(Path(cached[2]).is_file())
            self.assertRegex(cached[4], r'^#[0-9A-Fa-f]{6}$')

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
