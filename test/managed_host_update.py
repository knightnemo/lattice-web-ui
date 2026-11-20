import contextlib
import functools
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import io
import json
from pathlib import Path
import fcntl
import tarfile
import tempfile
import threading
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "managed_update", Path(__file__).resolve().parents[1] / "scripts/manage-host-update.py"
)
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)

BEFORE = "1.2.0"
AFTER = "1.3.0"
BUILD = {BEFORE: "a" * 24, AFTER: "b" * 24}


def entry(version):
    return (f'<head><meta name="lattice-web-build" content="{BUILD[version]}">'
            '<script type="module" src="/assets/app.js"></script></head>')


def content(package, name, data, mode=0o600):
    if isinstance(data, str):
        data = data.encode()
    member = tarfile.TarInfo(name)
    member.mode = mode
    member.size = len(data)
    package.addfile(member, io.BytesIO(data))


def source_archive(target):
    name = f"lattice-remote-source-{target}"
    shell = """#!/usr/bin/env bash
set -euo pipefail
COPYFILE_DISABLE=1 tar -czf "$2" -C "$1" lattice-remote-host
"""
    archive = io.BytesIO()
    with tarfile.open(fileobj=archive, mode="w:gz") as package:
        content(package, f"{name}/release-version.txt", target)
        content(package, f"{name}/build-linux.sh", shell, 0o700)
        host = f"{name}/source/lattice-remote-host"
        content(package, f"{host}/release-version.txt", target)
        content(package, f"{host}/lattice-server", "#!/bin/sh\n", 0o700)
        content(package, f"{host}/web/index.html", entry(target))
        content(package, f"{host}/web/assets/app.js", target)
    return archive.getvalue()


class LocalService(BaseHTTPRequestHandler):
    def __init__(self, fixture, *args, **kwargs):
        self.fixture = fixture
        super().__init__(*args, **kwargs)

    def log_message(self, *_args):
        pass

    def do_GET(self):
        live = self.fixture.live
        version = (live / "release-version.txt").read_text().strip()
        if self.path == "/api/host-update/health":
            data = json.dumps({"version": version}).encode()
        elif self.path == "/":
            data = (live / "assets/index.html").read_bytes()
        elif self.path == "/assets/app.js":
            if version in self.fixture.bad_assets:
                data = b"not the expected JavaScript"
            else:
                data = (live / "assets/assets/app.js").read_bytes()
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class ManagedHost(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        data = Path(temp.name).resolve()
        self.bad_assets = set()
        service = ThreadingHTTPServer(
            ("127.0.0.1", 0), functools.partial(LocalService, self)
        )
        thread = threading.Thread(target=service.serve_forever, kwargs={"poll_interval": 0.02})
        thread.start()
        self.addCleanup(service.server_close)
        self.addCleanup(thread.join)
        self.addCleanup(service.shutdown)
        self.host = updater.Host(data, "test-lattice.service", service.server_port)
        self.host.updates.mkdir()
        self.host.releases.mkdir()
        self.before = self.host.releases / "1"
        (self.before / "assets/assets").mkdir(parents=True)
        (self.before / "release-version.txt").write_text(BEFORE)
        (self.before / "assets/index.html").write_text(entry(BEFORE))
        (self.before / "assets/assets/app.js").write_text(BEFORE)
        self.host.point(self.before)
        self.live = self.before
        self.restarts = []
        self.archive = source_archive(AFTER)
        self.release = {"tag_name": f"v{AFTER}", "assets": [{
            "name": f"lattice-remote-source-{AFTER}.tar.gz",
            "size": len(self.archive), "state": "uploaded",
        }, {"name": f"SHA256SUMS-v{AFTER}.txt", "state": "uploaded"}]}
        self.downloads = []
        for target, name, options in [
            (updater, "HEALTH_TIMEOUT", {"new": 0.2}),
            (updater, "HEALTH_INTERVAL", {"new": 0.01}),
            (updater.release_check, "latest_stable", {"side_effect": lambda: self.release}),
            (updater.release_check, "fetch", {"side_effect": self.download}),
            (self.host, "restart", {"side_effect": self.restart}),
        ]:
            mock = patch.object(target, name, **options)
            mock.start()
            self.addCleanup(mock.stop)

    def restart(self):
        self.live = self.host.current()
        self.restarts.append(self.live.name)

    def download(self, url):
        self.downloads.append(url)
        self.assertIn(f"/download/v{AFTER}/", url)
        if url.endswith(".txt"):
            digest = updater.hashlib.sha256(self.archive).hexdigest()
            return io.BytesIO(f"{digest}  lattice-remote-source-{AFTER}.tar.gz\n".encode())
        return io.BytesIO(self.archive)

    def tick(self):
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.host.tick()

    def phase(self):
        return updater.read_json(self.host.status)["phase"]

    def request(self, target=AFTER):
        self.host.request.write_text(f"{target}\n")

    def test_download_only_until_owner_requests_and_server_becomes_idle(self):
        self.tick()
        self.assertEqual(self.phase(), "ready")
        self.assertEqual(len(self.downloads), 2)
        self.assertEqual(self.restarts, [])
        self.assertEqual(list(self.host.releases.iterdir()), [self.before])
        self.request()
        with self.host.work_lock.open("wb") as active_sync:
            fcntl.flock(active_sync, fcntl.LOCK_SH)
            self.tick()
            self.assertEqual(self.phase(), "waiting")
            self.assertEqual(len(self.downloads), 2)
            self.assertEqual(self.host.current(), self.before)
            self.assertTrue(self.host.request.is_file())
        self.tick()
        self.assertEqual(self.phase(), "current")
        self.assertEqual(self.restarts, [f"managed-{AFTER}"])
        self.assertEqual(updater.read_version(self.live / "release-version.txt"), AFTER)
        self.assertTrue(self.before.is_dir())
        self.assertFalse(self.host.request.exists())
        self.assertFalse(self.host.trial.exists())

    def test_asset_mismatch_restores_previous_server(self):
        self.tick()
        self.request()
        self.bad_assets.add(AFTER)
        self.tick()
        self.assertEqual(self.restarts, [f"managed-{AFTER}", self.before.name])
        self.assertEqual(self.phase(), "rolled_back")
        self.assertEqual(self.host.current(), self.before)
        self.assertTrue(self.host.healthy(self.before))
        self.assertFalse(self.host.trial.exists())
        self.tick()
        self.assertEqual(self.restarts, [f"managed-{AFTER}", self.before.name])
        self.bad_assets.clear()
        self.request()
        self.tick()
        self.assertEqual(self.phase(), "current")

    def test_interrupted_activation_uses_durable_journal(self):
        candidate = self.host.releases / f"managed-{AFTER}"
        candidate.mkdir()
        (candidate / "release-version.txt").write_text(AFTER)
        updater.write_json(self.host.trial, {"previous": self.before.name, "version": AFTER})
        self.host.point(candidate)
        self.request()
        self.tick()
        self.assertEqual(self.restarts, [self.before.name])
        self.assertEqual(self.phase(), "rolled_back")
        self.assertEqual(self.host.current(), self.before)
        self.assertFalse(self.host.request.exists())
        self.assertFalse(self.host.trial.exists())

    def test_failed_rollback_keeps_recovery_record(self):
        updater.write_json(self.host.trial, {"previous": self.before.name, "version": AFTER})
        self.bad_assets.add(BEFORE)
        with self.assertRaisesRegex(RuntimeError, "previous release"):
            self.tick()
        self.assertTrue(self.host.trial.exists())
        self.assertEqual(self.phase(), "failed")
        self.bad_assets.clear()
        self.tick()
        self.assertFalse(self.host.trial.exists())
        self.assertEqual(self.phase(), "rolled_back")

    def test_corrupt_staged_source_is_rejected_without_restart(self):
        self.tick()
        source = self.host.updates / f"source-{AFTER}" / f"lattice-remote-source-{AFTER}.tar.gz"
        source.write_bytes(b"damaged")
        self.request()
        with self.assertRaisesRegex(ValueError, "checksum mismatch"):
            self.tick()
        self.assertFalse(source.exists())
        self.assertEqual(self.phase(), "failed")
        self.assertEqual(self.restarts, [])
        self.request()
        self.tick()
        self.assertEqual(self.phase(), "current")

    def test_stale_request_and_withdrawn_release_do_not_switch(self):
        self.tick()
        self.request("1.1.0")
        self.tick()
        self.assertEqual(self.phase(), "ready")
        self.assertEqual(self.restarts, [])
        self.host.checked.unlink()
        self.release = None
        self.request()
        self.tick()
        self.assertEqual(self.phase(), "current")
        self.assertEqual(self.restarts, [])
        self.assertFalse(self.host.request.exists())

    def test_other_updater_instance_is_not_disturbed(self):
        with (self.host.updates / "worker.lock").open("wb") as worker:
            fcntl.flock(worker, fcntl.LOCK_EX)
            self.tick()
        self.assertFalse(self.host.status.exists())
        self.assertEqual(self.downloads, [])

    def test_archive_with_external_path_or_link_is_rejected(self):
        for name, kind in [
            ("source/../../outside", tarfile.REGTYPE), ("source/external", tarfile.SYMTYPE),
            ("/source/absolute", tarfile.REGTYPE), ("source/hardlink", tarfile.LNKTYPE),
        ]:
            with self.subTest(name=name):
                archive = self.host.updates / "test.tar.gz"
                with tarfile.open(archive, "w:gz") as package:
                    member = tarfile.TarInfo(name)
                    member.type = kind
                    package.addfile(member)
                with self.assertRaisesRegex(ValueError, "Unexpected path"):
                    updater.unpack(archive, self.host.updates, "source")


if __name__ == "__main__":
    unittest.main()
