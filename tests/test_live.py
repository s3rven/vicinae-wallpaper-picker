"""Live wallpaper player: pause rules, Hyprland events and the control commands."""

import importlib.util
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("live_wallpaper", ROOT / "live-wallpaper.py")
live = importlib.util.module_from_spec(spec)
spec.loader.exec_module(live)


def monitor(name, ws, special=0):
    return {"name": name, "activeWorkspace": {"id": ws}, "specialWorkspace": {"id": special}}


class Rules(unittest.TestCase):
    workspaces = [
        {"id": 1, "windows": 2, "hasfullscreen": False},
        {"id": 2, "windows": 1, "hasfullscreen": True},
        {"id": 3, "windows": 0, "hasfullscreen": False},
        {"id": -98, "windows": 1, "hasfullscreen": False},
    ]

    def covered(self, policy, *monitors):
        return live.covered_outputs(policy, list(monitors), self.workspaces)

    def test_never_always_plays(self):
        self.assertEqual(self.covered("never", monitor("A", 2)), set())

    def test_covered_pauses_only_behind_fullscreen_or_maximized(self):
        self.assertEqual(self.covered("covered", monitor("A", 1), monitor("B", 2)), {"B"})

    def test_windows_pauses_any_occupied_visible_workspace(self):
        self.assertEqual(self.covered("windows", monitor("A", 1), monitor("B", 3)), {"A"})

    def test_open_scratchpad_counts_as_a_window(self):
        self.assertEqual(self.covered("windows", monitor("A", 3, special=-98)), {"A"})

    def test_unknown_workspace_is_not_covered(self):
        self.assertEqual(self.covered("windows", monitor("A", 42)), set())


class Controls(unittest.TestCase):
    def test_settings_work_without_systemd_or_a_runtime_directory(self):
        with tempfile.TemporaryDirectory(prefix="wallpaper-control-") as tmp:
            root = Path(tmp)
            env = dict(os.environ, HOME=tmp, XDG_STATE_HOME=str(root / "state"),
                       XDG_CACHE_HOME=str(root / "cache"), XDG_RUNTIME_DIR="", PATH="")
            def cli(*args):
                return subprocess.run([sys.executable, str(ROOT / "live-wallpaper.py"), *args],
                                      env=env, capture_output=True, text=True, timeout=5)
            self.assertEqual(cli("pause").returncode, 0)
            self.assertEqual(cli("idle").returncode, 0)
            status = json.loads(cli("status").stdout)
            self.assertEqual((status["paused"], status["running"]), (True, False))
            marker = root / "cache/wallpaper-picker/runtime/live-idle"
            self.assertTrue(marker.exists())
            self.assertEqual(marker.stat().st_mode & 0o777, 0o600)
            self.assertEqual(marker.parent.stat().st_mode & 0o777, 0o700)


class Player(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="live wallpaper-")
        self.addCleanup(self.tmp.cleanup)
        home = Path(self.tmp.name)
        self.state = home / "state"
        self.trace = home / "trace.jsonl"
        hypr = home / "hypr" / "sig"
        hypr.mkdir(parents=True)
        bin_dir = home / "bin"
        bin_dir.mkdir()
        # A stand-in mpvpaper: serves the mpv IPC socket and records every command.
        stub = bin_dir / "mpvpaper"
        stub.write_text(f"""#!{sys.executable}
import json, os, shlex, socket, sys
opts, out = sys.argv[2], sys.argv[3]
path = next(arg.split('=', 1)[1] for arg in shlex.split(opts) if arg.startswith('input-ipc-server='))
trace = open(os.environ['TEST_TRACE'], 'a', buffering=1)
trace.write(json.dumps({{'out': out, 'start_paused': opts.endswith(' pause')}}) + '\\n')
srv = socket.socket(socket.AF_UNIX); srv.bind(path); srv.listen()
while True:
    conn, _ = srv.accept()
    for line in conn.makefile():
        trace.write(json.dumps({{'out': out, 'cmd': json.loads(line)['command']}}) + '\\n')
""")
        stub.chmod(0o755)
        # Never signal or query the real session's wallpaper-live unit.
        (bin_dir / "systemctl").write_text("#!/bin/sh\nexit 3\n")
        (bin_dir / "systemctl").chmod(0o755)
        self.monitors = [monitor("eDP-2", 1), monitor("DP-3", 3)]
        self.workspaces = [{"id": 1, "windows": 1, "hasfullscreen": False},
                           {"id": 3, "windows": 0, "hasfullscreen": False}]
        self.query = self.serve(hypr / ".socket.sock", self.answer)
        self.events = []
        self.event_srv = self.serve(hypr / ".socket2.sock", self.events.append, keep=True)
        self.env = dict(os.environ, XDG_RUNTIME_DIR=str(home), XDG_STATE_HOME=str(self.state),
                        HYPRLAND_INSTANCE_SIGNATURE="sig", TEST_TRACE=str(self.trace),
                        PATH=f"{bin_dir}:{os.environ['PATH']}")

    def serve(self, path, handle, keep=False):
        srv = socket.socket(socket.AF_UNIX)
        srv.bind(str(path))
        srv.listen()
        self.addCleanup(srv.close)

        def loop():
            while True:
                try:
                    conn, _ = srv.accept()
                except OSError:
                    return
                if keep:
                    handle(conn)
                else:
                    with conn:
                        conn.sendall(handle(conn.recv(1024)))
        threading.Thread(target=loop, daemon=True).start()
        return srv

    def answer(self, request):
        return json.dumps(self.monitors if request == b"j/monitors" else self.workspaces).encode()

    def records(self, key):
        if not self.trace.exists():
            return []
        return [r for r in map(json.loads, self.trace.read_text().splitlines()) if key in r]

    def wait_for(self, check):
        for _ in range(100):
            if check():
                return
            time.sleep(0.03)
        self.fail(f"timed out; trace: {self.trace.read_text() if self.trace.exists() else ''}")

    def start(self, policy):
        self.state.mkdir(parents=True, exist_ok=True)
        (self.state / "wallpaper-picker").mkdir(exist_ok=True)
        (self.state / "wallpaper-picker" / "live-pause-when").write_text(policy + "\n")
        proc = subprocess.Popen([sys.executable, str(ROOT / "live-wallpaper.py"), "run", "clip.mp4", "eDP-2,DP-3"],
                                env=self.env)
        self.addCleanup(lambda: (proc.poll() is None and proc.terminate(), proc.wait(5)))
        self.wait_for(lambda: len(self.records("start_paused")) == 2 and self.events)
        return proc

    def test_hidden_output_starts_paused_and_events_resume_it(self):
        proc = self.start("windows")
        starts = {r["out"]: r["start_paused"] for r in self.records("start_paused")}
        self.assertEqual(starts, {"eDP-2": True, "DP-3": False})
        # The window closes: the event triggers a re-check and a resume.
        self.workspaces[0]["windows"] = 0
        self.events[0].sendall(b"activewindow>>kitty,x\n")  # irrelevant: ignored
        self.events[0].sendall(b"closewindow>>abc\n")
        self.wait_for(lambda: self.records("cmd"))
        self.assertEqual(self.records("cmd"), [{"out": "eDP-2", "cmd": ["set_property", "pause", False]}])
        proc.terminate()
        self.assertEqual(proc.wait(5), 0)

    def test_manual_pause_overrides_policy_via_sighup(self):
        proc = self.start("never")
        (self.state / "wallpaper-picker" / "live-paused").touch()
        proc.send_signal(signal.SIGHUP)
        self.wait_for(lambda: len(self.records("cmd")) == 2)
        self.assertEqual({r["out"] for r in self.records("cmd")}, {"eDP-2", "DP-3"})
        self.assertTrue(all(r["cmd"][2] is True for r in self.records("cmd")))

    def test_idle_pauses_without_touching_the_manual_pause(self):
        proc = self.start("never")
        cli = lambda c: subprocess.run([sys.executable, str(ROOT / "live-wallpaper.py"), c], env=self.env)
        cli("idle")
        proc.send_signal(signal.SIGHUP)  # the stub systemctl cannot deliver it
        self.wait_for(lambda: len(self.records("cmd")) == 2)
        self.assertFalse((self.state / "wallpaper-picker" / "live-paused").exists())
        cli("active")
        proc.send_signal(signal.SIGHUP)
        self.wait_for(lambda: len(self.records("cmd")) == 4)
        self.assertTrue(all(r["cmd"][2] is False for r in self.records("cmd")[2:]))

    def test_unplugged_output_keeps_the_others_playing(self):
        proc = self.start("never")
        subprocess.run(["pkill", "-f", f"{self.tmp.name}/bin/mpvpaper -o .* DP-3 "])
        time.sleep(0.3)
        self.assertIsNone(proc.poll())
        (self.state / "wallpaper-picker" / "live-paused").touch()
        proc.send_signal(signal.SIGHUP)
        self.wait_for(lambda: self.records("cmd"))
        self.assertEqual([r["out"] for r in self.records("cmd")], ["eDP-2"])
        subprocess.run(["pkill", "-f", f"{self.tmp.name}/bin/mpvpaper"])
        self.assertNotEqual(proc.wait(5), 0)

    def test_policy_command_validates_and_persists(self):
        cli = lambda *a: subprocess.run([sys.executable, str(ROOT / "live-wallpaper.py"), *a],
                                        env=self.env, capture_output=True, text=True)
        self.assertEqual(cli("policy", "sometimes").returncode, 2)
        self.assertEqual(cli("policy", "windows").returncode, 0)
        self.assertEqual(cli("toggle").returncode, 0)
        status = json.loads(cli("status").stdout)
        self.assertEqual((status["policy"], status["paused"]), ("windows", True))


if __name__ == "__main__":
    unittest.main()
