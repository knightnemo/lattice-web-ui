import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from urllib.error import HTTPError, URLError

spec = importlib.util.spec_from_file_location("updater", Path(__file__).resolve().parents[1] / "scripts/check-host-update.py")
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)


class ReleaseCheck(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.directory = Path(tmp.name)
        self.archive = "lattice-remote-source-1.10.0.tar.gz"
        self.sums = "SHA256SUMS-v1.10.0.txt"
        self.data = b"synthetic archive"
        self.base = "https://github.com/knightnemo/lattice-web-ui/releases/download/v1.10.0/"
        self.metadata = {
            "tag_name": "v1.10.0", "draft": False, "prerelease": False,
            "assets": [{"name": self.archive, "state": "uploaded", "size": len(self.data)},
                       {"name": self.sums, "state": "uploaded"}],
        }
        self.responses = {
            self.base + self.archive: self.data,
            self.base + self.sums: f"{hashlib.sha256(self.data).hexdigest()}  {self.archive}\n".encode(),
        }
        self.calls = []

    def fetch(self, url):
        self.calls.append(url)
        if url == updater.LATEST:
            return io.BytesIO(json.dumps(self.metadata).encode())
        return io.BytesIO(self.responses[url])

    def check(self, installed="1.9.0", prepare=True, fetch=None):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            updater.run(installed, self.directory if prepare else None, fetch or self.fetch)
        return output.getvalue()

    def test_check_only_current_ahead_and_newer(self):
        for installed, message in [("1.9.0", "available"), ("1.10.0", "current stable"), ("1.11.0", "ahead")]:
            with self.subTest(installed=installed):
                self.calls.clear()
                self.assertIn(message, self.check(installed, prepare=installed != "1.9.0"))
                self.assertEqual(self.calls, [updater.LATEST])
                self.assertEqual(list(self.directory.iterdir()), [])

    def test_no_stable_release_and_offline_are_distinct(self):
        def missing(url):
            raise HTTPError(url, 404, "Not Found", {}, None)

        def offline(_url):
            raise URLError("offline")
        self.assertIn("no published stable", self.check(fetch=missing))
        with self.assertRaises(URLError):
            self.check(fetch=offline)
        self.assertEqual(list(self.directory.iterdir()), [])

    def test_refuses_prereleases_drafts_and_unexpected_tags(self):
        for field, value in [("draft", True), ("prerelease", True), ("tag_name", "v1.10.0-beta.1")]:
            with self.subTest(field=field):
                saved = self.metadata[field]
                self.metadata[field] = value
                with self.assertRaises(ValueError):
                    self.check()
                self.metadata[field] = saved
        self.assertTrue(all(url == updater.LATEST for url in self.calls))

    def test_verified_archive_is_staged_once(self):
        self.assertIn("Verified", self.check())
        final = self.directory / self.archive
        self.assertEqual(list(self.directory.iterdir()), [final])
        self.assertEqual(final.read_bytes(), self.data)
        final.write_bytes(b"keep local file")
        with self.assertRaises(FileExistsError):
            self.check()
        self.assertEqual(final.read_bytes(), b"keep local file")

    def test_rejects_bad_hash_truncation_and_ambiguous_checksum(self):
        sums = self.responses[self.base + self.sums]
        for data, checksums in [(b"x" * len(self.data), sums), (b"short", sums), (self.data, sums * 2)]:
            with self.subTest(data=data, checksums=checksums):
                self.responses[self.base + self.archive] = data
                self.responses[self.base + self.sums] = checksums
                with self.assertRaises(ValueError):
                    self.check()
                self.assertEqual(list(self.directory.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
