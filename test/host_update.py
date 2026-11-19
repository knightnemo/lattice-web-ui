import contextlib
import hashlib
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
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
        self.base = "https://github.com/lattice-writer/lattice-web-ui/releases/download/v1.10.0/"
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

    def test_timer_status_is_atomic_public_data_and_survives_an_error(self):
        state = self.directory / "private"
        public = self.directory / "web"
        public.mkdir()
        private_status = state / "lattice-web-ui" / updater.STATUS_FILE
        public_status = public / updater.STATUS_FILE
        with patch.dict(os.environ, {"XDG_STATE_HOME": str(state)}), contextlib.redirect_stdout(io.StringIO()):
            updater.run("1.9.0", open_url=self.fetch, record_status=True)
            self.assertFalse(public_status.exists())
            updater.run("1.9.0", open_url=self.fetch, record_status=True, public_status_dir=public)
            body = public_status.read_text()
            self.assertEqual(json.loads(body), {"schema": 1, "installedVersion": "1.9.0", "latestVersion": "1.10.0"})
            self.assertEqual(private_status.read_text(), body)
            self.assertEqual(private_status.stat().st_mode & 0o777, 0o600)
            self.assertEqual(public_status.stat().st_mode & 0o777, 0o644)
            def offline(_url):
                raise URLError("offline")
            with self.assertRaises(URLError):
                updater.run("1.9.0", open_url=offline, record_status=True, public_status_dir=public)
            self.assertEqual(private_status.read_text(), body)
            self.assertEqual(public_status.read_text(), body)
            with public_status.open() as old_descriptor:
                def missing(url):
                    raise HTTPError(url, 404, "Not Found", {}, None)
                updater.run("1.9.0", open_url=missing, record_status=True, public_status_dir=public)
                self.assertEqual(old_descriptor.read(), body)
            self.assertEqual(json.loads(public_status.read_text())["latestVersion"], None)

    def test_isolated_timer_install_reconfigure_and_remove(self):
        config = self.directory / "config"
        tools = self.directory / "bin"
        tools.mkdir()
        fake = tools / "systemctl"
        log = self.directory / "commands"
        fake.write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$FAKE_SYSTEMCTL_LOG"\n')
        fake.chmod(0o755)
        public = self.directory / 'web %h $HOME "quoted"'
        public.mkdir()
        units = config / "systemd/user"
        service = units / "lattice-host-update.service"
        timer = units / "lattice-host-update.timer"
        environment = {"PATH": str(tools) + os.pathsep + os.environ["PATH"],
                       "XDG_CONFIG_HOME": str(config), "FAKE_SYSTEMCTL_LOG": str(log)}
        with patch.dict(os.environ, environment), patch.object(sys, "platform", "linux"), contextlib.redirect_stdout(io.StringIO()):
            updater.configure_timer(False, "1.9.0", public)
            self.assertIn('ExecStart=:', service.read_text())
            self.assertIn('web %%h $HOME \\"quoted\\"', service.read_text())
            self.assertIn('TimeoutStartSec=60s', service.read_text())
            self.assertIn('OnActiveSec=1min', timer.read_text())
            self.assertIn('OnUnitActiveSec=15min', timer.read_text())
            self.assertIn('RandomizedDelaySec=30s', timer.read_text())
            analyzer = shutil.which("systemd-analyze")
            if os.environ.get("GITHUB_ACTIONS") == "true" and os.environ.get("RUNNER_OS") == "Linux":
                self.assertIsNotNone(analyzer, "The Linux CI must validate the generated units with systemd-analyze")
            if analyzer:
                subprocess.run([analyzer, "verify", "--man=no", str(service), str(timer)], check=True)
            updater.configure_timer(False, "1.9.0")
            self.assertNotIn('--public-status-dir', service.read_text())
            updater.configure_timer(True)
            updater.configure_timer(True)
            self.assertFalse(timer.exists())
            self.assertFalse(service.exists())
            commands = log.read_text().splitlines()
            self.assertEqual(commands, [
                "--user daemon-reload", "--user enable --now lattice-host-update.timer",
                "--user daemon-reload", "--user enable --now lattice-host-update.timer",
                "--user disable --now lattice-host-update.timer", "--user stop lattice-host-update.service", "--user daemon-reload",
            ])
            service.write_text("# my own service")
            with self.assertRaisesRegex(ValueError, "Another unit"):
                updater.configure_timer(False)
            with self.assertRaisesRegex(ValueError, "Another unit"):
                updater.configure_timer(True)
            self.assertEqual(service.read_text(), "# my own service")
            self.assertEqual(commands, log.read_text().splitlines())

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
