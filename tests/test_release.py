"""Release archives must exclude local files, metadata and symlink targets."""

import importlib.util
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("release", ROOT / "scripts/prepare-release.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class Release(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="wallpaper-release-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / "scripts").mkdir()
        (self.root / "scripts/release-manifest.json").write_text(json.dumps({"backend": [], "source": ["README.md"]}))
        (self.root / "README.md").write_text("Public source\n")
        self.target = self.root / "source.tar.gz"

    def test_only_reviewed_files_and_normalized_metadata_are_exported(self):
        (self.root / ".env").write_text("PRIVATE=local-only")
        (self.root / "private-helper.sh").write_text("private")
        (self.root / ".git").mkdir()
        (self.root / ".git/config").write_text("private identity")
        release.build_archive(self.root, self.target)
        original = self.target.read_bytes()
        with tarfile.open(self.target) as tar:
            self.assertEqual(tar.getnames(), [f"{release.PREFIX}/README.md"])
            entry = tar.getmembers()[0]
            self.assertEqual((entry.uid, entry.gid, entry.uname, entry.gname, entry.mtime), (0, 0, "", "", 0))
        release.build_archive(self.root, self.target)
        self.assertEqual(original, self.target.read_bytes())

    def test_symlinks_cannot_export_external_files(self):
        (self.root / "README.md").unlink()
        (self.root / "README.md").symlink_to(ROOT / "LICENSE")
        with self.assertRaisesRegex(ValueError, "symlink"):
            release.build_archive(self.root, self.target)
        self.assertFalse(self.target.exists())

    def test_sensitive_content_is_rejected_without_printing_it(self):
        private_path = "/home/" + "example-account/private/wallpaper.png"
        (self.root / "README.md").write_text(private_path)
        with self.assertRaisesRegex(ValueError, "absolute home path") as error:
            release.build_archive(self.root, self.target)
        self.assertNotIn(private_path, str(error.exception))

    def test_parent_traversal_is_rejected(self):
        (self.root / "scripts/release-manifest.json").write_text(json.dumps({"backend": [], "source": ["../private"]}))
        with self.assertRaisesRegex(ValueError, "Invalid release entry"):
            release.build_archive(self.root, self.target)
