"""A failed or concurrent video import must not lose other clips."""

import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class ImportLive(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="wallpaper-import-")
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.bin = self.home / "bin"
        self.bin.mkdir()
        self.dest = self.home / "Live"
        self.env = {k: v for k, v in os.environ.items() if not k.startswith(("WALLPAPER_", "AWWW_"))}
        self.env.update(HOME=str(self.home), PATH=f"{self.bin}:/usr/bin:/bin",
                        XDG_CONFIG_HOME=str(self.home / "config"), XDG_CACHE_HOME=str(self.home / "cache"),
                        WALLPAPER_LIVE_DIR=str(self.dest), WALLPAPER_LIVE_SIZE="64x40",
                        WALLPAPER_LIVE_MIN_LOOP="1", TEST_FAIL_STAGE="", TEST_OUTPUT_RACE="0")
        self.program("ffprobe", """
if 'stream=avg_frame_rate,width,height' in sys.argv:
    print(json.dumps({'streams': [{'avg_frame_rate': '30/1', 'width': 64, 'height': 40}]}))
else:
    print('0' if 'broken' in sys.argv[-1] and os.environ['TEST_FAIL_STAGE'] == 'duration' else '1')
""")
        self.program("ffmpeg", """
source = Path(sys.argv[sys.argv.index('-i') + 1])
output = Path(sys.argv[-1])
output.write_bytes(b'partial')
loop = '-stream_loop' in sys.argv
stage = 'loop' if loop else 'encode'
if 'broken' in source.name and os.environ['TEST_FAIL_STAGE'] == stage:
    sys.exit(9)
output.write_bytes(b'encoded')
if os.environ['TEST_OUTPUT_RACE'] == '1' and not loop:
    Path(str(output).split('.mp4.', 1)[0] + '.mp4').write_bytes(b'existing import')
""")

    def program(self, name, body):
        file = self.bin / name
        file.write_text(f"#!{sys.executable}\nimport json, os, sys\nfrom pathlib import Path\n" + body)
        file.chmod(0o755)

    def run_import(self, *names):
        sources = []
        for name in names:
            source = self.home / name
            source.write_bytes(b'input')
            sources.append(str(source))
        return subprocess.run(['bash', str(ROOT / 'import-live.sh'), *sources], env=self.env,
                              capture_output=True, text=True, timeout=10)

    def test_encoding_failure_does_not_stop_later_imports(self):
        self.env['TEST_FAIL_STAGE'] = 'encode'
        result = self.run_import('broken.mp4', 'good.mp4')
        self.assertEqual(result.returncode, 1)
        self.assertIn('video encoding failed', result.stderr)
        self.assertEqual({p.name for p in self.dest.iterdir()}, {'good.mp4'})
        self.assertEqual((self.dest / 'good.mp4').read_bytes(), b'encoded')

    def test_loop_failure_does_not_leave_partial_files_or_stop_batch(self):
        self.env.update(TEST_FAIL_STAGE='loop', WALLPAPER_LIVE_MIN_LOOP='2')
        result = self.run_import('broken.mp4', 'good.mp4')
        self.assertEqual(result.returncode, 1)
        self.assertIn('extending the video loop failed', result.stderr)
        self.assertEqual({p.name for p in self.dest.iterdir()}, {'good.mp4'})

    def test_invalid_duration_does_not_stop_later_imports(self):
        self.env['TEST_FAIL_STAGE'] = 'duration'
        result = self.run_import('broken.mp4', 'good.mp4')
        self.assertEqual(result.returncode, 1)
        self.assertIn('could not read clip duration', result.stderr)
        self.assertNotIn('Traceback', result.stderr)
        self.assertEqual({p.name for p in self.dest.iterdir()}, {'good.mp4'})

    def test_concurrent_destination_is_not_overwritten(self):
        self.env['TEST_OUTPUT_RACE'] = '1'
        result = self.run_import('good.mp4')
        self.assertEqual(result.returncode, 1)
        self.assertIn('destination already exists', result.stderr)
        self.assertEqual((self.dest / 'good.mp4').read_bytes(), b'existing import')
        self.assertEqual({p.name for p in self.dest.iterdir()}, {'good.mp4'})
