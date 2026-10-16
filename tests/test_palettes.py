"""Check extraction failures and concurrent previews with disposable caches."""

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class Palettes(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='wallpaper-palettes-')
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.bin = self.home / 'bin'
        self.bin.mkdir()
        self.source = self.home / 'rainy city.png'
        self.source.write_bytes(b'fixture')
        os.utime(self.source, (1, 1))
        self.trace = self.home / 'extracts.jsonl'
        self.cache = self.home / 'cache'
        thumb = self.cache / 'wallpaper-picker/thumbs' / (hashlib.sha1(os.fsencode(self.source)).hexdigest() + '.jpg')
        thumb.parent.mkdir(parents=True)
        thumb.write_bytes(b'cached thumbnail')
        self.env = dict(os.environ, HOME=str(self.home), XDG_CACHE_HOME=str(self.cache),
                        PATH=f'{self.bin}:/usr/bin:/bin', TEST_PALETTE_TRACE=str(self.trace),
                        TEST_PALETTE_FAIL='0', TEST_PALETTE_DELAY='0', TEST_PALETTE_ONLY_DOMINANT='0')
        matugen = self.bin / 'matugen'
        matugen.write_text(f'#!{sys.executable}\n' + '''
import json, os, sys, time
index = int(sys.argv[sys.argv.index('--source-color-index') + 1])
with open(os.environ['TEST_PALETTE_TRACE'], 'a') as trace:
    trace.write(json.dumps(index) + '\\n')
time.sleep(float(os.environ['TEST_PALETTE_DELAY']))
if os.environ['TEST_PALETTE_FAIL'] == '1' or (index > 0 and os.environ['TEST_PALETTE_ONLY_DOMINANT'] == '1'):
    sys.exit(7)
print(json.dumps({'colors': {key: {'dark': {'color': color}} for key, color in {
    'source_color': '#4488ff', 'primary': '#aabbff', 'tertiary': '#ddaaff', 'surface': '#121212'
}.items()}}))
''')
        matugen.chmod(0o755)

    def run_scan(self, path=None):
        return subprocess.run([str(ROOT / 'scan-colors.sh'), str(path or self.source)],
                              cwd=self.home, env=self.env, capture_output=True, text=True, timeout=15)

    def cache_file(self):
        return self.cache / 'wallpaper-picker/schemes' / hashlib.md5(os.fsencode(self.source)).hexdigest()

    def test_concurrent_previews_share_one_extraction(self):
        self.env['TEST_PALETTE_DELAY'] = '.2'
        processes = [subprocess.Popen([str(ROOT / 'scan-colors.sh'), str(self.source)],
                                     env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                     for _ in range(2)]
        try:
            for process in processes:
                stdout, stderr = process.communicate(timeout=15)
                self.assertEqual(process.returncode, 0, stderr)
                self.assertEqual({line.split()[0] for line in stdout.splitlines()}, {'0', '1', '2', '3'})
        finally:
            for process in processes:
                if process.poll() is None:
                    process.kill()
                process.communicate(timeout=5)
        self.assertEqual(len(self.trace.read_text().splitlines()), 4)

    def test_failed_extraction_reports_error_and_leaves_no_palette(self):
        self.env['TEST_PALETTE_FAIL'] = '1'
        result = self.run_scan()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, '')
        self.assertIn('Could not extract a palette', result.stderr)
        self.assertFalse(self.cache_file().exists())

    def test_single_colour_cache_is_reused_for_relative_and_absolute_paths(self):
        self.env['TEST_PALETTE_ONLY_DOMINANT'] = '1'
        first = self.run_scan(self.source.name)
        second = self.run_scan()
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(first.stdout, second.stdout)
        self.assertEqual(len(first.stdout.splitlines()), 1)
        self.assertEqual(len(self.trace.read_text().splitlines()), 4)

    def test_malformed_cache_is_rebuilt(self):
        cache = self.cache_file()
        cache.parent.mkdir(parents=True)
        # Seven hex digits used to pass the shell validator but get rejected
        # by the extension, leaving a permanently empty palette view.
        cache.write_text('0 #4488fff #aabbff #ddaaff #121212\n')
        result = self.run_scan()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(result.stdout.splitlines()), 4)
        self.assertEqual(len(cache.read_text().splitlines()), 4)


if __name__ == '__main__':
    unittest.main()
