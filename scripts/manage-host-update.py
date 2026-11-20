#!/usr/bin/env python3
"""Prepare stable host releases and switch one managed Lattice user service."""

import argparse
from contextlib import contextmanager
import fcntl
import hashlib
from html.parser import HTMLParser
from http.client import HTTPConnection, HTTPException
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import time

spec = importlib.util.spec_from_file_location(
    "lattice_release", Path(__file__).resolve().with_name("check-host-update.py")
)
release_check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release_check)

CHECK_INTERVAL = 15 * 60
MAX_ARCHIVE = 512 * 1024 * 1024
MAX_UNPACKED = 2 * 1024 * 1024 * 1024
MAX_ASSET = 16 * 1024 * 1024
HEALTH_TIMEOUT = 18
HEALTH_INTERVAL = 0.5
SERVICE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.service")
RELEASE_DIR = re.compile(r"(?:[0-9]+|managed-[0-9]+\.[0-9]+\.[0-9]+)")
ASSET_PATH = re.compile(r"/assets/[A-Za-z0-9_.-]+\.js")
CHECK_ERRORS = (OSError, ValueError, TypeError, KeyError, HTTPException,
                tarfile.TarError, subprocess.SubprocessError)
UPDATE_ERRORS = (*CHECK_ERRORS, RuntimeError)


def sync_dir(path):
    directory = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def sync_release(path):
    # Once a trial is committed there is no journal left to recover from.
    # Persist both candidate contents and directory entries before switching.
    for directory, _, files in os.walk(path, topdown=False):
        for filename in files:
            with (Path(directory) / filename).open("rb") as stream:
                os.fsync(stream.fileno())
        sync_dir(directory)


def write_json(path, value):
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        try:
            json.dump(value, stream)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
            temporary.replace(path)
            sync_dir(path.parent)
        finally:
            temporary.unlink(missing_ok=True)


def read_json(path):
    try:
        with path.open("rb") as stream:
            return json.loads(release_check.read_metadata(stream, 1024 * 1024))
    except FileNotFoundError:
        return None


def read_version(path):
    try:
        with path.open("rb") as stream:
            value = release_check.read_metadata(stream, 128).decode("ascii").strip()
    except FileNotFoundError:
        return None
    release_check.version_parts(value)
    return value


def hash_file(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def run_build(command, *, cwd, environment):
    with subprocess.Popen(
        command, cwd=cwd, env=environment, stdin=subprocess.DEVNULL, start_new_session=True,
    ) as process:
        try:
            status = process.wait(timeout=45 * 60)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            raise
        if status != 0:
            raise subprocess.CalledProcessError(status, command)


@contextmanager
def try_lock(path):
    # Python and the server both use flock, on the same inode for the life of
    # this installation. Never remove or replace either lock file.
    descriptor = os.open(path, os.O_RDONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            yield False
        else:
            yield True
    finally:
        os.close(descriptor)


def unpack(archive, destination, expected_root):
    """Extract only regular files/directories under the expected root."""
    files = uncompressed = 0
    with tarfile.open(archive, "r|gz") as package:
        for member in package:
            name = PurePosixPath(member.name)
            files += 1
            uncompressed += member.size
            if (not name.parts or name.parts[0] != expected_root or name.is_absolute()
                or ".." in name.parts or not (member.isdir() or member.isreg())
                or member.size < 0 or uncompressed > MAX_UNPACKED or files > 50_000):
                raise ValueError("Unexpected path, file type or size in host update archive.")
            path = destination.joinpath(*name.parts)
            if member.isdir():
                path.mkdir(mode=0o700, parents=True, exist_ok=True)
            else:
                path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                with package.extractfile(member) as payload, path.open("xb") as stream:
                    shutil.copyfileobj(payload, stream)
                path.chmod(0o700 if member.mode & 0o111 else 0o600)
    return destination / expected_root


class EntryHTML(HTMLParser):
    def __init__(self, source):
        super().__init__()
        self.stamp = None
        self.modules = []
        self.feed(source)

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag == "meta" and values.get("name") == "lattice-web-build":
            self.stamp = values.get("content")
        if tag == "script" and values.get("type") == "module":
            self.modules.append(values.get("src"))

    def signature(self):
        if (not re.fullmatch(r"[0-9a-f]{24}", self.stamp or "") or not self.modules
            or any(not isinstance(path, str) or not ASSET_PATH.fullmatch(path) for path in self.modules)):
            raise ValueError("The host build is missing its entry module or build stamp.")
        return self.stamp, self.modules


class Host:
    def __init__(self, data_dir, service, port):
        self.data = data_dir
        self.updates = data_dir / "updates"
        self.releases = data_dir / "releases"
        self.pointer = data_dir / "current"
        self.status = self.updates / "status.json"
        self.request = self.updates / "request"
        self.trial = self.updates / "trial.json"
        self.checked = self.updates / "checked.json"
        self.work_lock = self.updates / "work.lock"
        self.service = service
        self.port = port

    def release(self, name):
        if not isinstance(name, str) or not RELEASE_DIR.fullmatch(name):
            raise ValueError("The managed release directory name is invalid.")
        directory = self.releases / name
        if directory.is_symlink() or not directory.is_dir():
            raise ValueError("The managed release directory is unavailable.")
        return directory

    def current(self):
        if not self.pointer.is_symlink():
            raise ValueError("The managed host has no current release pointer.")
        directory = self.pointer.resolve(strict=True)
        if (directory.parent != self.releases or self.release(directory.name) != directory
            or read_version(directory / "release-version.txt") is None):
            raise ValueError("The current release is outside the managed versioned layout.")
        return directory

    def report(self, installed, latest, phase):
        result = {"schema": 1, "installedVersion": installed, "latestVersion": latest, "phase": phase}
        if read_json(self.status) != result:
            write_json(self.status, result)

    def latest(self):
        cached = read_json(self.checked)
        if cached is not None and 0 <= time.time() - cached["checkedAt"] < CHECK_INTERVAL:
            return cached["release"], False
        # An expired response never authorizes a switch while GitHub is unreachable.
        release = release_check.latest_stable()
        write_json(self.checked, {"checkedAt": time.time(), "release": release})
        return release, True

    def source(self, release, target):
        basename = f"lattice-remote-source-{target}"
        cached = self.updates / f"source-{target}"
        if not cached.exists():
            with tempfile.TemporaryDirectory(prefix="download-", dir=self.updates) as staging:
                staged = Path(staging)
                digest = release_check.stage(
                    release, f"v{target}", staged, release_check.fetch, max_size=MAX_ARCHIVE
                )
                write_json(staged / "verified.json", {"sha256": digest})
                staged.rename(cached)
            # Only one verified download is useful. Keep built releases for rollback.
            for earlier in self.updates.glob("source-*"):
                if earlier != cached and earlier.is_dir() and not earlier.is_symlink():
                    shutil.rmtree(earlier)
        return cached / f"{basename}.tar.gz"

    def build(self, source, target):
        filename = f"lattice-remote-source-{target}"
        checksum = read_json(source.parent / "verified.json")
        if not checksum or hash_file(source) != checksum.get("sha256"):
            shutil.rmtree(source.parent)
            raise ValueError("Cached source kit checksum mismatch; retry to fetch it again.")
        with tempfile.TemporaryDirectory(prefix="build-", dir=self.updates) as staging:
            stage = Path(staging)
            kit = unpack(source, stage, filename)
            if read_version(kit / "release-version.txt") != target:
                raise ValueError("The verified source kit release version does not match.")
            output = stage / "host.tar.gz"
            # The verified release source controls the build script. Do not
            # inherit the service/provider environment or a mutable working dir.
            environment = {
                key: value for key, value in os.environ.items()
                if key in {"HOME", "PATH", "LANG", "RUSTUP_HOME", "CARGO_HOME", "PNPM_HOME"}
            }
            environment["TMPDIR"] = str(stage)
            run_build(
                ["bash", kit / "build-linux.sh", kit / "source", output],
                cwd=kit, environment=environment,
            )
            built = unpack(output, stage, "lattice-remote-host")
            if (read_version(built / "release-version.txt") != target
                or not os.access(built / "lattice-server", os.X_OK)):
                raise ValueError("The built host does not match the selected release.")
            (built / "web").rename(built / "assets")
            self.frontend(built)
            sync_release(built)
            candidate = self.releases / f"managed-{target}"
            built.rename(candidate)
            sync_dir(self.releases)
        return candidate

    def get(self, path, limit):
        connection = HTTPConnection("127.0.0.1", self.port, timeout=2)
        try:
            connection.request("GET", path, headers={"Cache-Control": "no-cache"})
            response = connection.getresponse()
            if response.status != 200:
                raise ValueError("The host health probe received a non-OK response.")
            return release_check.read_metadata(response, limit)
        finally:
            connection.close()

    def frontend(self, directory):
        index = directory / "assets/index.html"
        with index.open("rb") as stream:
            signature = EntryHTML(release_check.read_metadata(stream, 64 * 1024).decode()).signature()
        expected = {}
        for module in signature[1]:
            path = directory / "assets" / module.lstrip("/")
            if not path.is_file() or not 0 < path.stat().st_size <= MAX_ASSET:
                raise ValueError("The build is missing an entry module.")
            expected[module] = hash_file(path)
        return signature, expected

    def healthy(self, directory, wait=False):
        version = read_version(directory / "release-version.txt")
        signature, expected = self.frontend(directory)
        deadline = time.monotonic() + (HEALTH_TIMEOUT if wait else 0)
        consecutive = 0
        while True:
            try:
                health = json.loads(self.get("/api/host-update/health", 1024))
                live_index = self.get("/", 64 * 1024).decode()
                if (not isinstance(health, dict) or health.get("version") != version
                    or EntryHTML(live_index).signature() != signature
                    or any(hashlib.sha256(self.get(path, MAX_ASSET)).hexdigest() != digest
                           for path, digest in expected.items())):
                    raise ValueError("The host is not serving the expected release.")
                consecutive += 1
                if not wait or consecutive == 3:
                    return True
            except (OSError, ValueError, HTTPException):
                consecutive = 0
            if time.monotonic() >= deadline:
                return False
            time.sleep(HEALTH_INTERVAL)

    def restart(self):
        subprocess.run(
            ["systemctl", "--user", "restart", self.service],
            timeout=45, check=True, stdin=subprocess.DEVNULL,
        )

    def point(self, release):
        temporary = self.data / "current.update-next"
        temporary.unlink(missing_ok=True)
        temporary.symlink_to(release, target_is_directory=True)
        temporary.replace(self.pointer)
        sync_dir(self.data)

    def clear_request(self):
        try:
            self.request.unlink()
        except FileNotFoundError:
            return
        sync_dir(self.updates)

    def finish_trial(self):
        self.trial.unlink()
        sync_dir(self.updates)

    def rollback(self, trial):
        previous = self.release(trial["previous"])
        installed = read_version(previous / "release-version.txt")
        target = trial["version"]
        release_check.version_parts(target)
        self.report(installed, target, "switching")
        self.clear_request()
        try:
            self.point(previous)
            self.restart()
            if not self.healthy(previous, wait=True):
                raise RuntimeError("The previous release failed its health check.")
        except UPDATE_ERRORS:
            self.report(installed, target, "failed")
            raise
        self.report(installed, target, "rolled_back")
        self.finish_trial()
        print(f"Restored Lattice-web-ui {installed} after an unsuccessful update.", flush=True)

    def activate(self, current, candidate, installed, target):
        trial = {"previous": current.name, "version": target}
        write_json(self.trial, trial)
        self.report(installed, target, "switching")
        self.clear_request()
        try:
            self.point(candidate)
            self.restart()
            if not self.healthy(candidate, wait=True):
                raise RuntimeError("The candidate release failed its health check.")
        except UPDATE_ERRORS as error:
            print(f"Host activation failed: {error}", file=sys.stderr, flush=True)
            self.rollback(trial)
            return
        self.report(target, target, "current")
        self.finish_trial()

    def tick(self):
        if (self.updates.is_symlink() or self.releases.is_symlink()
            or not self.updates.is_dir() or not self.releases.is_dir()):
            raise ValueError("The managed installation directories are unavailable.")
        with try_lock(self.updates / "worker.lock") as worker:
            if worker:
                for scratch in (*self.updates.glob("download-*"), *self.updates.glob("build-*")):
                    if scratch.is_dir() and not scratch.is_symlink():
                        shutil.rmtree(scratch)
                self.run_locked()

    def run_locked(self):
        if trial := read_json(self.trial):
            with try_lock(self.work_lock) as idle:
                if idle:
                    self.rollback(trial)
            return

        current = self.current()
        installed = read_version(current / "release-version.txt")
        release, refreshed = self.latest()
        latest = release["tag_name"][1:] if release else None
        if latest is None or release_check.version_parts(latest) <= release_check.version_parts(installed):
            self.report(installed, latest, "current")
            self.clear_request()
            return

        requested = read_version(self.request) == latest
        status = read_json(self.status) or {}
        if not requested and status.get("latestVersion") == latest:
            if status.get("phase") == "rolled_back" or (status.get("phase") == "failed" and not refreshed):
                return
        try:
            if not (self.updates / f"source-{latest}").exists():
                self.report(installed, latest, "preparing")
            source = self.source(release, latest)
            if not requested:
                self.report(installed, latest, "ready")
                return
            candidate = self.releases / f"managed-{latest}"
            if not candidate.exists():
                self.report(installed, latest, "preparing")
                candidate = self.build(source, latest)
            if read_version(self.release(candidate.name) / "release-version.txt") != latest:
                raise ValueError("The staged host does not contain the expected release.")
        except CHECK_ERRORS:
            self.clear_request()
            self.report(installed, latest, "failed")
            raise

        # Re-observe the official release after long builds before taking the
        # exclusive work lock, which should never wait on an internet request.
        newest, _ = self.latest()
        if not newest or newest["tag_name"] != release["tag_name"]:
            self.clear_request()
            self.report(installed, None if newest is None else newest["tag_name"][1:], "current")
            return
        with try_lock(self.work_lock) as idle:
            if not idle or not self.healthy(current):
                self.report(installed, latest, "waiting")
                return
            self.activate(current, candidate, installed, latest)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", required=True, type=Path)
    parser.add_argument("--service", required=True)
    parser.add_argument("--port", required=True, type=int)
    args = parser.parse_args()
    if not sys.platform.startswith("linux"):
        parser.error("Managed host updates require a Linux systemd user manager.")
    if not SERVICE.fullmatch(args.service) or not 1024 <= args.port <= 65535:
        parser.error("Pass a valid host unit name and an unprivileged loopback port.")
    try:
        Host(args.data_dir.resolve(strict=True), args.service, args.port).tick()
    except UPDATE_ERRORS as error:
        parser.exit(1, f"Managed host update: {error}\n")


if __name__ == "__main__":
    main()
