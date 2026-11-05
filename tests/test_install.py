"""The installer works from other directories and never uses sudo."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class Installer(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="wallpaper install ")
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.root = self.home / "source tree"
        self.root.mkdir()
        (self.root / "vicinae").mkdir()
        shutil.copyfile(ROOT / "install.sh", self.root / "install.sh")
        self.bin = self.home / "bin"
        self.bin.mkdir()
        self.trace = self.home / "commands.jsonl"
        for tool in ("node", "npm", "npx", "awww", "awww-daemon", "flock", "realpath", "sha1sum", "find", "sort", "timeout"):
            path = self.bin / tool
            path.write_text(f"#!{sys.executable}\nimport os, json, sys\n"
                            "with open(os.environ['TEST_TRACE'], 'a') as f:\n"
                            f"    f.write(json.dumps([{tool!r}, *sys.argv[1:]]) + '\\n')\n")
            path.chmod(0o755)
        self.env = dict(os.environ, HOME=str(self.home), PATH=f"{self.bin}:/usr/bin:/bin", TEST_TRACE=str(self.trace))

    def run_install(self, *args):
        return subprocess.run(["/bin/bash", str(self.root / "install.sh"), *args], cwd=self.home,
                              env=self.env, capture_output=True, text=True, timeout=10)

    def calls(self):
        return [json.loads(line) for line in self.trace.read_text().splitlines()]

    def test_check_is_read_only(self):
        result = self.run_install("--check")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([c[0] for c in self.calls()], ["node"])

    def test_build_output_is_relative_to_invocation_and_handles_spaces(self):
        result = self.run_install("--output", "bundle output")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(["npm", "ci", "--no-audit", "--no-fund"], self.calls())
        self.assertIn(["npx", "--no-install", "vici", "build", "--out", str(self.home / "bundle output")], self.calls())

    def test_invalid_arguments_do_not_install(self):
        for args in [("--output",), ("--output", "--check"), ("--unknown",),
                     ("--check", "--build-only"), ("--build-only", "--check"),
                     ("--check", "--output", "out"), ("--output", "out", "--check")]:
            with self.subTest(args=args):
                self.assertEqual(self.run_install(*args).returncode, 2)
        self.assertFalse(self.trace.exists())

    def test_build_only_does_not_require_desktop_tools(self):
        for tool in ('awww', 'awww-daemon', 'flock', 'realpath', 'sha1sum', 'find', 'sort', 'timeout'):
            (self.bin / tool).unlink()
        for tool in ('dirname', 'uname'):
            (self.bin / tool).symlink_to(shutil.which(tool))
        self.env['PATH'] = str(self.bin)
        result = self.run_install('--build-only')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(['npm', 'ci', '--no-audit', '--no-fund'], self.calls())

    def test_missing_dependencies_do_not_trigger_package_installs(self):
        (self.bin / 'npm').unlink()
        for tool in ('dirname', 'uname'):
            (self.bin / tool).symlink_to(shutil.which(tool))
        self.env['PATH'] = str(self.bin)
        result = self.run_install('--check')
        self.assertEqual(result.returncode, 127)
        self.assertIn('npm', result.stderr)
        self.assertFalse(self.trace.exists())
