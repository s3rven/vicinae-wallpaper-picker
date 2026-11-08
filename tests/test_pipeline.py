"""Exercise applies, live playback, hooks and failure recovery with fake tools."""

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
        self.state = self.home / "state/wallpaper-picker"
        self.state.mkdir(parents=True)
        self.current = self.state / "current"
        self.old = self.home / "old image.png"
        self.new = self.home / "new image #1 (夜).png"
        self.old.touch()
        self.new.touch()
        self.current.write_text(str(self.old) + "\n")
        (self.state / "current-image").symlink_to(self.old)
        self.env = {key: value for key, value in os.environ.items()
                    if not key.startswith(("WALLPAPER_", "AWWW_", "MATUGEN_"))}
        self.env.update(
            HOME=str(self.home), PATH=f"{self.bin}:/usr/bin:/bin",
            XDG_STATE_HOME=str(self.home / "state"), XDG_CACHE_HOME=str(self.home / "cache"),
            XDG_CONFIG_HOME=str(self.home / "config"), XDG_RUNTIME_DIR=str(self.home),
            HYPRLAND_INSTANCE_SIGNATURE="fixture", AWWW_BLACKOUT_MATCH="portrait",
            TEST_TRACE=str(self.trace), TEST_AWWW_STATUS="0",
            TEST_MONITORS=json.dumps([
                {"name": "eDP-2", "description": "Laptop", "refreshRate": 60},
                {"name": "DP-3", "description": "Portrait Panel", "refreshRate": 180},
            ]),
        )
        self.program("hyprctl", "print(os.environ['TEST_MONITORS'])")
        self.program("awww", """
if sys.argv[1:2] == ['query']:
    if '--json' in sys.argv:
        print(os.environ.get('TEST_AWWW_OUTPUTS', '{}'))
    count = sum(json.loads(line)[:2] == ['awww', 'query'] for line in open(os.environ['TEST_TRACE']))
    sys.exit(1 if count <= int(os.environ.get('TEST_QUERY_FAILURES', '0')) else 0)
if sys.argv[1:2] == ['img']:
    sys.exit(int(os.environ['TEST_AWWW_STATUS']))
""")
        # Never start or signal anything in the real desktop session.
        for name in ("awww-daemon", "notify-send", "systemctl", "systemd-run", "mpvpaper", "hook"):
            self.program(name, "pass")
        self.program("matugen", "raise AssertionError('The picker must never call matugen')")

    def program(self, name, code):
        path = self.bin / name
        path.write_text(f"#!{sys.executable}\nimport json, os, sys\n"
                        "with open(os.environ['TEST_TRACE'], 'a') as trace:\n"
                        f"    trace.write(json.dumps([{name!r}, *sys.argv[1:]]) + '\\n')\n" + code + "\n")
        path.chmod(0o755)

    def run_script(self, name="apply-wallpaper.sh", *args):
        return subprocess.run(["bash", str(ROOT / name), *map(str, args)], env=self.env,
                              capture_output=True, text=True, timeout=15)

    def apply(self):
        return self.run_script("apply-wallpaper.sh", self.new, "none")

    def calls(self, name):
        if not self.trace.exists():
            return []
        return [c[1:] for line in self.trace.read_text().splitlines()
                if (c := json.loads(line))[0] == name]

    def images(self):
        return [c for c in self.calls("awww") if c[0] == "img"]

    def test_apply_routes_and_saves_without_theming(self):
        result = self.apply()
        self.assertEqual(result.returncode, 0, result.stderr)
        image = next(c for c in self.images() if str(self.new) in c)
        self.assertEqual(image[image.index("-o") + 1], "eDP-2")
        self.assertEqual(image[image.index("--transition-fps") + 1], "60")
        self.assertTrue(any("0x000000" in c and "DP-3" in c for c in self.images()))
        self.assertEqual(self.current.read_text(), str(self.new) + "\n")
        self.assertEqual((self.state / "current-image").resolve(), self.new)
        self.assertEqual((self.state / "previous").read_text(), str(self.old) + "\n")
        self.assertEqual(self.calls("matugen"), [])
        self.assertEqual(self.calls("hook"), [])
        self.assertEqual(self.current.stat().st_mode & 0o777, 0o600)

    def test_failed_send_keeps_state_and_reports_failure(self):
        self.env["TEST_AWWW_STATUS"] = "9"
        result = self.apply()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.current.read_text(), str(self.old) + "\n")
        self.assertEqual((self.state / "current-image").resolve(), self.old)
        self.assertFalse((self.state / "previous").exists())
        self.assertFalse((self.state / "applying").exists())
        self.assertTrue(self.calls("notify-send"))
        self.assertIn(str(self.old), self.images()[-2])

    def test_commit_failure_restores_image_state_and_link(self):
        blocked = self.home / "blocked-fit"
        blocked.mkdir()
        self.env["WALLPAPER_PICKER_FIT_STATE"] = str(blocked)
        result = self.apply()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.current.read_text(), str(self.old) + "\n")
        self.assertEqual((self.state / "current-image").resolve(), self.old)
        self.assertFalse((self.state / "applying").exists())
        self.assertFalse((self.state / "previous").exists())

    def test_previous_swaps_and_same_image_does_not_replace_itself(self):
        self.assertEqual(self.apply().returncode, 0)
        self.assertEqual(self.apply().returncode, 0)
        self.assertEqual((self.state / "previous").read_text(), str(self.old) + "\n")
        self.assertEqual(self.run_script("apply-wallpaper.sh", self.old, "none").returncode, 0)
        self.assertEqual((self.state / "previous").read_text(), str(self.new) + "\n")

    def test_fit_and_restore_share_the_same_contract(self):
        self.env.update(WALLPAPER_RESIZE_MODE="fit", WALLPAPER_SCALING_FILTER="Lanczos3", WALLPAPER_CROP_GRAVITY="top")
        self.assertEqual(self.apply().returncode, 0)
        self.trace.unlink()
        result = self.run_script("restore-wallpaper.sh")
        self.assertEqual(result.returncode, 0, result.stderr)
        image = self.images()[0]
        for flag, value in [("--resize", "fit"), ("--filter", "Lanczos3"), ("--crop-gravity", "top")]:
            self.assertEqual(image[image.index(flag) + 1], value)
        self.assertEqual(image[image.index("--transition-type") + 1], "none")
        self.assertEqual(self.calls("hook"), [])

    def test_no_blackout_sends_to_every_output(self):
        self.env.pop("AWWW_BLACKOUT_MATCH")
        self.assertEqual(self.apply().returncode, 0)
        [image] = self.images()
        self.assertNotIn("-o", image)
        self.assertEqual(image[image.index("--transition-fps") + 1], "180")

    def test_native_transition_choices_reach_awww(self):
        for effect in ("left", "right", "top", "bottom", "any", "random"):
            with self.subTest(effect=effect):
                self.trace.unlink(missing_ok=True)
                result = self.run_script("apply-wallpaper.sh", self.new, effect)
                self.assertEqual(result.returncode, 0, result.stderr)
                image = next(c for c in self.images() if str(self.new) in c)
                self.assertEqual(image[image.index("--transition-type") + 1], effect)

    def test_solid_colours_fill_the_display_and_restore_with_that_fit(self):
        colour = self.state / "colours/colour-4488ff.png"
        colour.parent.mkdir()
        colour.touch()
        self.env["WALLPAPER_RESIZE_MODE"] = "no"
        result = self.run_script("apply-wallpaper.sh", colour, "none")
        self.assertEqual(result.returncode, 0, result.stderr)
        image = next(c for c in self.images() if str(colour) in c)
        self.assertEqual(image[image.index("--resize") + 1], "stretch")
        self.trace.unlink()
        result = self.run_script("restore-wallpaper.sh")
        self.assertEqual(result.returncode, 0, result.stderr)
        image = next(c for c in self.images() if str(colour) in c)
        self.assertEqual(image[image.index("--resize") + 1], "stretch")

    def test_old_doom_choices_use_fast_native_fade(self):
        result = self.run_script("apply-wallpaper.sh", self.new, "doom")
        self.assertEqual(result.returncode, 0, result.stderr)
        image = next(c for c in self.images() if str(self.new) in c)
        self.assertEqual(image[image.index("--transition-type") + 1], "fade")
        self.assertEqual(image[image.index("--transition-duration") + 1], "0.28")
        self.assertFalse(any(call[1].endswith(".webp") for call in self.images()))
        self.assertFalse((self.home / "cache/wallpaper-picker/doom").exists())

    def test_native_presets_have_short_durations_and_their_own_direction(self):
        presets = [("soft-fade", "fade", "0.28", "90"),
                   ("diagonal-wipe", "wipe", "0.32", "35"),
                   ("spotlight-wave", "grow", "0.4", "90"),
                   ("iris-close", "outer", "0.4", "90"),
                   ("wave-sweep", "wave", "0.38", "90")]
        for name, effect, duration, angle in presets:
            with self.subTest(name=name):
                self.trace.unlink(missing_ok=True)
                result = self.run_script("apply-wallpaper.sh", self.new, name)
                self.assertEqual(result.returncode, 0, result.stderr)
                image = next(c for c in self.images() if str(self.new) in c)
                for flag, value in [("--transition-type", effect), ("--transition-duration", duration),
                                    ("--transition-angle", angle), ("--transition-bezier", ".22,1,.36,1")]:
                    self.assertEqual(image[image.index(flag) + 1], value)

    def test_transition_tuning_keeps_explicit_overrides(self):
        self.env.update(WALLPAPER_TRANSITION_DURATION="0.2", WALLPAPER_TRANSITION_ANGLE="120",
                        WALLPAPER_TRANSITION_BEZIER=".3,0,.6,1")
        result = self.run_script("apply-wallpaper.sh", self.new, "diagonal-wipe")
        self.assertEqual(result.returncode, 0, result.stderr)
        image = next(c for c in self.images() if str(self.new) in c)
        for flag, value in [("--transition-duration", "0.2"), ("--transition-angle", "120"),
                            ("--transition-bezier", ".3,0,.6,1")]:
            self.assertEqual(image[image.index(flag) + 1], value)

    def test_unavailable_monitor_routing_falls_back_to_all_outputs(self):
        self.env["TEST_MONITORS"] = "bad json"
        self.assertEqual(self.apply().returncode, 0)
        [image] = self.images()
        self.assertNotIn("-o", image)

    def test_env_file_is_read_from_xdg_config(self):
        config = self.home / "config/wallpaper-picker/env"
        config.parent.mkdir(parents=True)
        config.write_text('WALLPAPER_RESIZE_MODE=fit\nAWWW_BLACKOUT_MATCH=""\n')
        self.assertEqual(self.apply().returncode, 0)
        [image] = self.images()
        self.assertEqual(image[image.index("--resize") + 1], "fit")
        self.assertNotIn("-o", image)

    def test_hook_is_opt_in_and_receives_original_and_still_paths(self):
        self.env["WALLPAPER_PICKER_POST_APPLY"] = str(self.bin / "hook")
        self.program("hook", "assert os.environ['WALLPAPER_PICKER_CURRENT_IMAGE'] == sys.argv[1]")
        result = self.apply()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls("hook"), [[str(self.new)]])
        self.assertEqual(self.calls("matugen"), [])

    def test_failed_hook_does_not_undo_successful_wallpaper(self):
        self.env["WALLPAPER_PICKER_POST_APPLY"] = str(self.bin / "hook")
        self.program("hook", "sys.exit(7)")
        result = self.apply()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.current.read_text(), str(self.new) + "\n")
        self.assertIn("hook failed", result.stderr)

    def test_chosen_accent_is_saved_and_reaches_the_hook(self):
        self.env.update(WALLPAPER_PICKER_ACCENT="#AABBCC", WALLPAPER_PICKER_POST_APPLY=str(self.bin / "hook"))
        (self.state / "source-index").write_text("2\n")
        self.program("hook", "assert os.environ['WALLPAPER_PICKER_ACCENT'] == '#aabbcc'\n"
                            "assert os.environ['WALLPAPER_PICKER_ACCENT_CHANGED'] == '1'")
        result = self.apply()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.state / "custom-accent").read_text(), "#aabbcc\n")
        self.assertFalse((self.state / "source-index").exists())
        self.assertEqual(self.calls("matugen"), [])

    def test_direct_apply_keeps_the_accent_and_auto_clears_it(self):
        accent = self.state / "custom-accent"
        accent.write_text("#4488ff\n")
        self.env["WALLPAPER_PICKER_POST_APPLY"] = str(self.bin / "hook")
        self.program("hook", "assert os.environ['WALLPAPER_PICKER_ACCENT'] == '#4488ff'\n"
                            "assert os.environ['WALLPAPER_PICKER_ACCENT_CHANGED'] == '0'")
        self.assertEqual(self.apply().returncode, 0)
        self.assertEqual(accent.read_text(), "#4488ff\n")
        self.env["WALLPAPER_PICKER_ACCENT"] = ""
        self.program("hook", "assert os.environ['WALLPAPER_PICKER_ACCENT'] == ''\n"
                            "assert os.environ['WALLPAPER_PICKER_ACCENT_CHANGED'] == '1'")
        result = self.apply()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(accent.exists())
        self.assertEqual((self.state / "source-index").read_text(), "0\n")

    def test_image_palette_clears_the_pin_and_reaches_the_hook(self):
        (self.state / "custom-accent").write_text("#4488ff\n")
        self.env.update(WALLPAPER_PICKER_PALETTE="2", WALLPAPER_PICKER_POST_APPLY=str(self.bin / "hook"))
        self.program("hook", "assert os.environ['WALLPAPER_PICKER_ACCENT'] == ''\n"
                            "assert os.environ['WALLPAPER_PICKER_ACCENT_CHANGED'] == '1'\n"
                            "assert os.environ['WALLPAPER_PICKER_PALETTE_INDEX'] == '2'")
        result = self.apply()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.calls("hook")), 1)
        self.assertFalse((self.state / "custom-accent").exists())
        self.assertEqual((self.state / "source-index").read_text(), "2\n")

    def test_direct_apply_of_another_image_resets_its_palette(self):
        source = self.state / "source-index"
        source.write_text("3\n")
        self.assertEqual(self.run_script("apply-wallpaper.sh", self.old, "none").returncode, 0)
        self.assertEqual(source.read_text(), "3\n")
        self.assertEqual(self.apply().returncode, 0)
        self.assertEqual(source.read_text(), "0\n")

    def test_invalid_palette_is_rejected_before_changing_wallpaper(self):
        for env in ({"WALLPAPER_PICKER_PALETTE": "4"},
                    {"WALLPAPER_PICKER_PALETTE": "1", "WALLPAPER_PICKER_ACCENT": "#4488ff"}):
            self.env.update(env)
            self.assertEqual(self.apply().returncode, 2)
        self.assertEqual(self.images(), [])
        self.assertEqual(self.current.read_text(), str(self.old) + "\n")

    def test_invalid_accent_is_rejected_before_changing_wallpaper(self):
        self.env["WALLPAPER_PICKER_ACCENT"] = "#4488ff; touch nope"
        result = self.apply()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.images(), [])
        self.assertEqual(self.current.read_text(), str(self.old) + "\n")

    def test_failed_commit_restores_previous_accent_and_source_index(self):
        accent = self.state / "custom-accent"
        source = self.state / "source-index"
        accent.write_text("#112233\n")
        source.write_text("2\n")
        blocked = self.state / "blocked-current"
        blocked.mkdir()
        self.env.update(WALLPAPER_PICKER_ACCENT="#445566", WALLPAPER_STATE_FILE=str(blocked))
        result = self.apply()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(accent.read_text(), "#112233\n")
        self.assertEqual(source.read_text(), "2\n")

    def test_example_theming_hook_honours_selected_and_automatic_colours(self):
        config = self.home / "matugen.toml"
        config.touch()
        self.env.update(WALLPAPER_PICKER_POST_APPLY=str(ROOT / "examples/matugen/post-apply.sh"),
                        MATUGEN_CONFIG=str(config), WALLPAPER_PICKER_ACCENT="#4488ff")
        self.program("matugen", "pass")
        result = self.apply()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls("matugen"), [["--config", str(config), "color", "hex", "#4488ff",
                                                  "--type", "scheme-fidelity", "--mode", "dark"]])
        self.env["WALLPAPER_PICKER_ACCENT"] = ""
        result = self.apply()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls("matugen")[-1], ["--config", str(config), "image", str(self.new),
                                                    "--mode", "dark", "--source-color-index", "0",
                                                    "--resize-filter", "nearest"])
        del self.env["WALLPAPER_PICKER_ACCENT"]
        self.env["WALLPAPER_PICKER_PALETTE"] = "1"
        result = self.apply()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls("matugen")[-1][6:8], ["--source-color-index", "1"])

    def test_launcher_failures_have_private_diagnostics(self):
        self.env.update(WALLPAPER_PICKER_LOG="1", TEST_AWWW_STATUS="9")
        self.assertNotEqual(self.apply().returncode, 0)
        log = self.state / "last-apply.log"
        self.assertIn("Wallpaper apply failed", log.read_text())
        self.assertEqual(log.stat().st_mode & 0o777, 0o600)

    def test_daemon_readiness_is_checked_before_send(self):
        self.env["TEST_QUERY_FAILURES"] = "2"
        result = self.apply()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len([c for c in self.calls("awww") if c[0] == "query"]), 3)
        self.assertEqual(len(self.calls("awww-daemon")), 1)

    def test_video_requires_a_user_service_before_changing_image(self):
        video = self.home / "clip.mp4"
        video.touch()
        self.program("systemctl", "sys.exit(1)")
        result = self.run_script("apply-wallpaper.sh", video, "none")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("systemd user session", result.stderr)
        self.assertEqual(self.images(), [])
        self.assertEqual(self.current.read_text(), str(self.old) + "\n")

    def test_video_plays_only_on_wallpaper_outputs(self):
        video = self.home / "clip.mp4"
        subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=teal:s=64x40:d=0.2", str(video)], check=True)
        result = self.run_script("apply-wallpaper.sh", video, "none")
        self.assertEqual(result.returncode, 0, result.stderr)
        image = next(c for c in self.images() if "eDP-2" in c)
        self.assertTrue(image[1].endswith(".png"))
        self.assertEqual(str((self.state / "current-image").resolve()), image[1])
        for _ in range(100):
            if self.calls("systemd-run"): break
            time.sleep(.02)
        [player] = self.calls("systemd-run")
        self.assertEqual(player[-3:], ["run", str(video), "eDP-2"])
        self.assertIn("XDG_RUNTIME_DIR=" + str(self.home), player)

    def test_restore_waits_for_apply_lock(self):
        fit = self.state / "fit"
        with (self.state / "apply.lock").open("w") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            proc = subprocess.Popen(["bash", str(ROOT / "restore-wallpaper.sh")], env=self.env, stderr=subprocess.PIPE)
            try:
                time.sleep(.1)
                self.assertEqual(self.calls("awww"), [])
                fit.write_text("fit\nLanczos3\ntop\n")
            finally:
                fcntl.flock(handle, fcntl.LOCK_UN)
                _, stderr = proc.communicate(timeout=10)
        self.assertEqual(proc.returncode, 0, stderr)
        self.assertIn("Lanczos3", self.images()[0])

    def test_still_changes_skip_stopping_an_inactive_live_player(self):
        self.assertEqual(self.apply().returncode, 0)
        self.assertFalse(any("stop" in call for call in self.calls("systemctl")))
        runtime = self.home / "wallpaper-picker/runtime"
        runtime.mkdir(parents=True)
        (runtime / "live-token").touch()
        self.assertEqual(self.apply().returncode, 0)
        self.assertTrue(any("stop" in call for call in self.calls("systemctl")))
        self.assertFalse((runtime / "live-token").exists())

    def test_waiting_wallpaper_requests_skip_superseded_choices(self):
        newest = self.home / "newest.png"
        newest.touch()
        processes = []
        request = self.state / "latest-request"
        with (self.state / "apply.lock").open("w") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            try:
                for image in (self.new, newest):
                    previous = request.read_text() if request.exists() else ""
                    process = subprocess.Popen(["bash", str(ROOT / "apply-wallpaper.sh"), str(image), "none"],
                                               env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                    processes.append(process)
                    for _ in range(100):
                        if request.exists() and request.read_text() != previous:
                            break
                        time.sleep(.01)
                    else:
                        self.fail("request did not enter the apply queue")
            finally:
                fcntl.flock(handle, fcntl.LOCK_UN)
                for process in processes:
                    _, stderr = process.communicate(timeout=10)
                    self.assertEqual(process.returncode, 0, stderr)
        self.assertFalse(any(str(self.new) in call for call in self.images()))
        self.assertTrue(any(str(newest) in call for call in self.images()))
        self.assertEqual(self.current.read_text().strip(), str(newest))


if __name__ == "__main__":
    unittest.main()
