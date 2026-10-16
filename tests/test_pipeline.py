"""Exercise wallpaper sends and failure recovery without changing the desktop."""

import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]


class Pipeline(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="wallpaper-pipeline-")
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.bin = self.home / "bin"
        self.bin.mkdir()
        self.trace = self.home / "trace.jsonl"
        self.state = self.home / "state"
        self.wallpaper_state = self.state / "theme/generated/wallpaper/path.txt"
        self.wallpaper_state.parent.mkdir(parents=True)
        self.old = self.home / "old image.png"
        self.new = self.home / "new image.png"
        self.old.touch()
        self.new.touch()
        self.wallpaper_state.write_text(str(self.old) + "\n")
        self.env = dict(os.environ)
        self.env.update(
            HOME=str(self.home), PATH=f"{self.bin}:/usr/bin:/bin",
            XDG_STATE_HOME=str(self.state), XDG_CACHE_HOME=str(self.home / "cache"),
            XDG_CONFIG_HOME=str(self.home / 'config'),
            HYPRLAND_INSTANCE_SIGNATURE="fixture",
            MATUGEN_CONFIG=str(self.home / "config.toml"),
            MATUGEN_NEUTRAL_CONFIG=str(self.home / "neutral.toml"),
            WALLPAPER_PICKER_LOCK=str(self.state / "wallpaper-picker/apply.lock"),
            TEST_TRACE=str(self.trace), TEST_MATUGEN_STATUS="0", TEST_AWWW_STATUS="0",
            TEST_MONITORS=json.dumps([
                {"name": "eDP-2", "description": "Laptop", "refreshRate": 60},
                {"name": "DP-3", "description": "Portrait Panel", "refreshRate": 180},
            ]),
        )
        # Avoid inherited overrides changing the simulated workflow.
        for key in list(self.env):
            if key.startswith(("WALLPAPER_", "AWWW_")) and key != "WALLPAPER_PICKER_LOCK":
                self.env.pop(key)
        self.env["AWWW_BLACKOUT_MATCH"] = "portrait"
        self.program("hyprctl", "if sys.argv[1:] == ['monitors', '-j']: print(os.environ['TEST_MONITORS'])")
        self.program("pgrep", "sys.exit(0 if 'awww-daemon' in sys.argv else 1)")
        self.program("awww", """
if sys.argv[1:2] == ['query']:
    queries = sum(json.loads(line)[:2] == ['awww', 'query']
                  for line in open(os.environ['TEST_TRACE']))
    sys.exit(1 if queries <= int(os.environ.get('TEST_QUERY_FAILURES', '0')) else 0)
if sys.argv[1:2] == ['img']:
    images = sum(json.loads(line)[:2] == ['awww', 'img']
                 for line in open(os.environ['TEST_TRACE']))
    if images <= int(os.environ.get('TEST_IMAGE_FAILURES', '0')): sys.exit(9)
sys.exit(int(os.environ['TEST_AWWW_STATUS']) if sys.argv[1:2] == ['img'] else 0)
""")
        self.program("notify-send", "pass")
        self.program("matugen", """
from pathlib import Path
p = Path(os.environ['XDG_STATE_HOME']) / 'theme/generated/wallpaper/path.txt'
p.parent.mkdir(parents=True, exist_ok=True)
p.write_text('Null\\n' if 'color' in sys.argv else '/cached/thumbnail.jpg\\n')
sys.exit(int(os.environ['TEST_MATUGEN_STATUS']))
""")

    def program(self, name, code):
        path = self.bin / name
        path.write_text(f"#!{sys.executable}\nimport json, os, sys\n"
                        "with open(os.environ['TEST_TRACE'], 'a') as trace:\n"
                        f"    trace.write(json.dumps([{name!r}, *sys.argv[1:]]) + '\\n')\n" + code + "\n")
        path.chmod(0o755)

    def run_script(self, name, *args):
        return subprocess.run([str(ROOT / name), *map(str, args)], env=self.env,
                              capture_output=True, text=True, timeout=15)

    def calls(self, name):
        if not self.trace.exists():
            return []
        return [c[1:] for line in self.trace.read_text().splitlines()
                if (c := json.loads(line))[0] == name]

    def test_apply_routes_once_and_paces_wallpaper_panel(self):
        result = self.run_script("apply-wallpaper-theme.sh", self.new, 2, "none")
        self.assertEqual(result.returncode, 0, result.stderr)
        images = self.calls("awww")
        image = next(c for c in images if str(self.new) in c)
        self.assertEqual(image[image.index('-o') + 1], 'eDP-2')
        self.assertEqual(image[image.index('--transition-fps') + 1], '60')
        self.assertTrue(any('0x000000' in c and 'DP-3' in c for c in images))
        self.assertEqual(len(self.calls("hyprctl")), 1)
        self.assertEqual(self.wallpaper_state.read_text(), str(self.new) + '\n')
        self.assertEqual((self.state / "wallpaper-picker/source-index").read_text(), '2\n')

    def test_wallpaper_only_preserves_theme_and_commits_image_fit_and_link(self):
        picker_state = self.state / 'wallpaper-picker'
        picker_state.mkdir()
        for name, value in [('custom-accent', '#112233\n'), ('source-index', '2\n'), ('neutral-mode', '')]:
            (picker_state / name).write_text(value)
        before = {p.name: p.read_bytes() for p in picker_state.iterdir()}
        # This mode must also work without Matugen installed.
        (self.bin / 'matugen').unlink()
        self.env.update(WALLPAPER_PICKER_WALLPAPER_ONLY='1', WALLPAPER_RESIZE_MODE='fit',
                        WALLPAPER_CROP_GRAVITY='top')
        result = self.run_script('apply-wallpaper-theme.sh', self.new, 0, 'none')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls('matugen'), [])
        self.assertEqual(self.calls('hook'), [])
        self.assertEqual(self.wallpaper_state.read_text(), str(self.new) + '\n')
        self.assertEqual((self.wallpaper_state.parent / 'current').resolve(), self.new)
        self.assertEqual((picker_state / 'fit').read_text(), 'fit\nCatmullRom\ntop\n')
        for name, value in before.items():
            self.assertEqual((picker_state / name).read_bytes(), value)

    def test_wallpaper_only_failure_keeps_previous_image_and_preferences(self):
        self.env.update(WALLPAPER_PICKER_WALLPAPER_ONLY='1', TEST_AWWW_STATUS='9')
        result = self.run_script('apply-wallpaper-theme.sh', self.new, 0, 'none')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.wallpaper_state.read_text(), str(self.old) + '\n')
        self.assertEqual(self.calls('matugen'), [])
        self.assertFalse((self.state / 'wallpaper-picker/fit').exists())

    def test_wallpaper_only_commit_failure_restores_image_state_and_lock_screen_link(self):
        link = self.wallpaper_state.parent / 'current'
        link.symlink_to(self.old)
        blocked_parent = self.home / 'not-a-directory'
        blocked_parent.touch()
        self.env.update(WALLPAPER_PICKER_WALLPAPER_ONLY='1',
                        WALLPAPER_PICKER_FIT_STATE=str(blocked_parent / 'fit'))
        result = self.run_script('apply-wallpaper-theme.sh', self.new, 0, 'none')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.wallpaper_state.read_text(), str(self.old) + '\n')
        self.assertEqual(link.resolve(), self.old)
        self.assertTrue(any(str(self.old) in c for c in self.calls('awww')))
        self.assertFalse((self.state / 'wallpaper-picker/applying').exists())

    def test_apply_waits_for_socket_before_sending_image(self):
        self.env['TEST_QUERY_FAILURES'] = '3'
        result = self.run_script('apply-wallpaper-theme.sh', self.new, 0, 'none')
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls('awww')
        self.assertEqual(calls[:4], [['query']] * 4)
        self.assertEqual(calls[4][0], 'img')

    def test_unavailable_daemon_never_sends_image_or_generates_theme(self):
        self.env['TEST_QUERY_FAILURES'] = '999'
        result = self.run_script('apply-wallpaper-theme.sh', self.new, 0, 'none')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(c[0] == 'img' for c in self.calls('awww')))
        self.assertEqual(self.calls('matugen'), [])
        self.assertEqual(self.wallpaper_state.read_text(), str(self.old) + '\n')
        self.assertIn('wallpaper daemon', result.stderr)

    def test_explicit_transition_pacing_overrides_monitor_detection(self):
        self.env['WALLPAPER_TRANSITION_FPS'] = '120'
        result = self.run_script('apply-wallpaper-theme.sh', self.new, 0, 'wave-sweep')
        self.assertEqual(result.returncode, 0, result.stderr)
        image = next(c for c in self.calls('awww') if str(self.new) in c)
        self.assertEqual(image[image.index('--transition-fps') + 1], '120')
        self.assertEqual(image.count('--transition-fps'), 1)
        self.assertEqual(image[image.index('--transition-angle') + 1], '90')
        self.assertEqual(len(self.calls('hyprctl')), 1)

    def test_failed_thumbnail_render_does_not_report_stale_image_as_success(self):
        thumb = self.home / 'stale thumbnail.jpg'
        thumb.write_text('old thumbnail')
        os.utime(thumb, (1, 1))
        self.program('magick', 'sys.exit(1)')
        result = subprocess.run(
            ['bash', '-c', '. "$1"; ensure_thumb "$2" "$3"', 'test',
             str(ROOT / 'thumb-lib.sh'), str(self.new), str(thumb)],
            env=self.env, capture_output=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(thumb.read_text(), 'old thumbnail')
        self.assertEqual(list(self.home.glob('*.tmp')), [])

    def test_failed_generation_preserves_state_and_reports_failure(self):
        fit = self.state / 'wallpaper-picker/fit'
        fit.parent.mkdir(parents=True)
        fit.write_text('fit\nLanczos3\ntop\n')
        self.env['TEST_MATUGEN_STATUS'] = '7'
        result = self.run_script("apply-wallpaper-theme.sh", self.new, 0, "none")
        self.assertEqual(result.returncode, 7, result.stderr)
        self.assertEqual(self.wallpaper_state.read_text(), str(self.old) + '\n')
        self.assertTrue(any(str(self.old) in c for c in self.calls('awww')))
        rollback = next(c for c in self.calls('awww') if str(self.old) in c)
        for flag, value in [('--resize', 'fit'), ('--filter', 'Lanczos3'), ('--crop-gravity', 'top')]:
            self.assertEqual(rollback[rollback.index(flag) + 1], value)
        self.assertEqual(len(self.calls('notify-send')), 1)
        self.assertEqual(self.calls('hook'), [])
        self.assertFalse((self.state / "wallpaper-picker/applying").exists())

    def test_failed_custom_accent_does_not_persist_null_or_replace_pin(self):
        pin = self.state / "wallpaper-picker/custom-accent"
        pin.parent.mkdir(parents=True)
        pin.write_text('#112233\n')
        self.env['TEST_MATUGEN_STATUS'] = '7'
        result = self.run_script("apply-wallpaper-theme.sh", self.new, -1, "none", '#4488ff')
        self.assertEqual(result.returncode, 7, result.stderr)
        self.assertEqual(pin.read_text(), '#112233\n')
        self.assertEqual(self.wallpaper_state.read_text(), str(self.old) + '\n')

    def test_failed_first_generation_removes_temporary_wallpaper_state(self):
        self.wallpaper_state.unlink()
        self.env['TEST_MATUGEN_STATUS'] = '7'
        result = self.run_script("apply-wallpaper-theme.sh", self.new, 0, "none")
        self.assertEqual(result.returncode, 7, result.stderr)
        self.assertFalse(self.wallpaper_state.exists())

    def test_failed_blackout_send_does_not_generate_or_commit_theme(self):
        self.env['TEST_MONITORS'] = json.dumps([{'name': 'DP-3', 'description': 'Portrait Panel'}])
        self.env['TEST_AWWW_STATUS'] = '9'
        result = self.run_script("apply-wallpaper-theme.sh", self.new, 0, "none")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(self.calls('matugen'), [])
        self.assertEqual(self.wallpaper_state.read_text(), str(self.old) + '\n')

    def test_invalid_source_index_never_changes_wallpaper(self):
        marker = self.state / 'wallpaper-picker/applying'
        marker.parent.mkdir(parents=True)
        marker.write_text('another apply\n')
        result = self.run_script("apply-wallpaper-theme.sh", self.new, 99, "none")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(self.calls('awww'), [])
        self.assertEqual(len(self.calls('notify-send')), 1)
        self.assertEqual(marker.read_text(), 'another apply\n')

    def test_detached_failure_keeps_diagnostics(self):
        self.env.update(TEST_MATUGEN_STATUS='7', WALLPAPER_PICKER_LOG='1')
        result = self.run_script("apply-wallpaper-theme.sh", self.new, 0, "none")
        self.assertEqual(result.returncode, 7)
        log = (self.state / 'wallpaper-picker/last-apply.log').read_text()
        self.assertIn('generating the theme', log)

    def test_restore_uses_committed_fit_after_waiting_for_apply(self):
        lock = Path(self.env['WALLPAPER_PICKER_LOCK'])
        lock.parent.mkdir(parents=True)
        fit = lock.parent / 'fit'
        fit.write_text('crop\nCatmullRom\ncenter\n')
        with lock.open('w') as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            process = subprocess.Popen([str(ROOT / 'restore-wallpaper.sh')], env=self.env,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                with self.assertRaises(subprocess.TimeoutExpired):
                    process.communicate(timeout=0.2)
                self.assertFalse(self.trace.exists())
                self.wallpaper_state.write_text(str(self.new) + '\n')
                fit.write_text('fit\nLanczos3\ntop\n')
            finally:
                fcntl.flock(handle, fcntl.LOCK_UN)
                _, stderr = process.communicate(timeout=10)
        self.assertEqual(process.returncode, 0, stderr.decode())
        image = next(c for c in self.calls('awww') if str(self.new) in c)
        for flag, value in [('--resize', 'fit'), ('--filter', 'Lanczos3'), ('--crop-gravity', 'top')]:
            self.assertEqual(image[image.index(flag) + 1], value)

    def test_malformed_monitor_response_degrades_to_unrouted_send(self):
        self.env['TEST_MONITORS'] = '{bad json'
        result = self.run_script('apply-wallpaper-theme.sh', self.new, 0, 'none')
        self.assertEqual(result.returncode, 0, result.stderr)
        image = next(c for c in self.calls('awww') if str(self.new) in c)
        self.assertNotIn('-o', image)

    def test_relative_apply_saves_absolute_image_and_lock_screen_target(self):
        self.env['WALLPAPER_PICKER_WALLPAPER_ONLY'] = '1'
        result = subprocess.run([str(ROOT / 'apply-wallpaper-theme.sh'), self.new.name, '0', 'none'],
                                cwd=self.home, env=self.env, capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.wallpaper_state.read_text(), str(self.new) + '\n')
        self.assertEqual((self.wallpaper_state.parent / 'current').resolve(), self.new)

    def test_restore_retries_output_registration_before_replaying_cache(self):
        self.env['TEST_IMAGE_FAILURES'] = '3'
        self.env['TEST_MONITORS'] = json.dumps([{'name': 'eDP-2', 'description': 'Laptop'}])
        result = self.run_script('restore-wallpaper.sh')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sum(c[0] == 'img' for c in self.calls('awww')), 4)
        self.assertFalse(any(c[0] == 'restore' for c in self.calls('awww')))
        self.assertEqual(self.calls('matugen'), [])

    def test_theme_reload_preserves_monitor_layout_with_and_without_checked_helper(self):
        (self.home / 'config.toml').write_text('[templates.hyprland]\n')
        for checked in [False, True]:
            with self.subTest(checked=checked):
                if checked:
                    self.program('checked-reload', 'pass')
                    self.env['WALLPAPER_PICKER_HYPR_RELOAD'] = 'checked-reload --config-only'
                self.trace.unlink(missing_ok=True)
                result = self.run_script('apply-wallpaper-theme.sh', self.new, 0, 'none')
                self.assertEqual(result.returncode, 0, result.stderr)
                for _ in range(100):
                    reloads = self.calls('checked-reload') if checked else [c for c in self.calls('hyprctl') if c[0] == 'reload']
                    if reloads: break
                    time.sleep(.01)
                self.assertEqual(reloads, [['--config-only']] if checked else [['reload', 'config-only']])

    def test_no_blackout_match_sends_to_every_output(self):
        self.env.pop('AWWW_BLACKOUT_MATCH')
        result = self.run_script('apply-wallpaper-theme.sh', self.new, 0, 'none')
        self.assertEqual(result.returncode, 0, result.stderr)
        images = [c for c in self.calls('awww') if c[0] == 'img']
        self.assertEqual(len(images), 1)
        self.assertNotIn('-o', images[0])
        # Pacing still follows the fastest output once nothing is blacked out.
        self.assertEqual(images[0][images[0].index('--transition-fps') + 1], '180')

    def test_env_file_supplies_local_settings(self):
        self.env.pop('AWWW_BLACKOUT_MATCH')
        env_file = Path(self.env['XDG_CONFIG_HOME']) / 'wallpaper-picker/env'
        env_file.parent.mkdir(parents=True)
        env_file.write_text('AWWW_BLACKOUT_MATCH=PORTRAIT\n')
        result = self.run_script('apply-wallpaper-theme.sh', self.new, 0, 'none')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(any('0x000000' in c and 'DP-3' in c for c in self.calls('awww')))

    def test_post_apply_hook_reports_theme_mode(self):
        self.program('hook', 'pass')
        self.env['WALLPAPER_PICKER_POST_APPLY'] = str(self.bin / 'hook')
        (self.home / 'neutral.toml').write_text('')
        for neutral, mode in [(False, 'colour'), (True, 'neutral')]:
            with self.subTest(mode=mode):
                marker = self.state / 'wallpaper-picker/neutral-mode'
                if neutral:
                    marker.parent.mkdir(parents=True, exist_ok=True)
                    marker.touch()
                self.trace.unlink(missing_ok=True)
                result = self.run_script('apply-wallpaper-theme.sh', self.new, 0, 'none')
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.calls('hook'), [[mode]])

    def test_wallpaper_only_skips_post_apply_hook(self):
        self.program('hook', 'pass')
        self.env.update(WALLPAPER_PICKER_POST_APPLY=str(self.bin / 'hook'), WALLPAPER_PICKER_WALLPAPER_ONLY='1')
        result = self.run_script('apply-wallpaper-theme.sh', self.new, 0, 'none')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls('hook'), [])


if __name__ == '__main__':
    unittest.main()
