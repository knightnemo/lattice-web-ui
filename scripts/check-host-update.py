#!/usr/bin/env python3
"""Check the official stable release and optionally stage a verified Linux source kit."""

import argparse
import hashlib
from http.client import HTTPException
import json
import os
from pathlib import Path
import re
import sys
import subprocess
import tempfile
from urllib.error import HTTPError
from urllib.request import Request, urlopen

REPOSITORY = "lattice-writer/lattice-web-ui"
LATEST = f"https://api.github.com/repos/{REPOSITORY}/releases/latest"
VERSION = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")
KIT_VERSION = Path(__file__).resolve().parent / "release-version.txt"
STATUS_FILE = "lattice-host-update.json"
UNIT = "lattice-host-update"
MARKER = "# Managed by Lattice-web-ui host update check"


def version_parts(value):
    match = VERSION.fullmatch(value)
    if not match:
        raise ValueError("Expected a release version in X.Y.Z format.")
    return tuple(int(part) for part in match.groups())


def read_metadata(response, limit):
    data = response.read(limit + 1)
    if len(data) > limit:
        raise ValueError("Release metadata exceeded its size limit.")
    return data


def fetch(url):
    request = Request(url, headers={"User-Agent": "lattice-web-ui-host-update"})
    return urlopen(request, timeout=30)


def stage(release, tag, destination, open_url):
    name = f"lattice-remote-source-{tag[1:]}.tar.gz"
    sums = f"SHA256SUMS-{tag}.txt"
    available = {asset["name"]: asset for asset in release["assets"] if asset["state"] == "uploaded"}
    if name not in available or sums not in available:
        raise ValueError("This release is missing its source kit or checksum file.")
    size = available[name]["size"]
    if type(size) is not int or size <= 0:
        raise ValueError("The published source kit has an invalid size.")
    base = f"https://github.com/{REPOSITORY}/releases/download/{tag}"
    with open_url(f"{base}/{sums}") as response:
        checksums = read_metadata(response, 16_384).decode("ascii")
    matches = re.findall(rf"^([0-9a-f]{{64}})  {re.escape(name)}$", checksums, re.M)
    if len(matches) != 1:
        raise ValueError("The release must contain exactly one SHA-256 checksum for the source kit.")

    destination.mkdir(parents=True, exist_ok=True)
    final = destination / name
    if os.path.lexists(final):
        raise FileExistsError(f"Choose a staging directory without an existing {name}.")
    with tempfile.TemporaryDirectory(prefix=".lattice-update-", dir=destination) as tmp:
        partial = Path(tmp) / name
        digest = hashlib.sha256()
        downloaded = 0
        with open_url(f"{base}/{name}") as source, partial.open("xb") as output:
            while chunk := source.read(1024 * 1024):
                downloaded += len(chunk)
                if downloaded > size:
                    raise ValueError("The source kit exceeds its published size.")
                digest.update(chunk)
                output.write(chunk)
        if downloaded != size or digest.hexdigest() != matches[0]:
            raise ValueError("Source kit verification failed. Check its size and SHA-256 checksum.")
        # Publish only complete bytes and refuse to replace a file created by another run.
        os.link(partial, final)
    print(f"Verified {final} (SHA-256 {matches[0]}).")


def atomic_write(path, text, mode):
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        tmp = handle.name
        try:
            handle.write(text)
            handle.flush()
            os.fchmod(handle.fileno(), mode)
            os.replace(tmp, path)
        finally:
            Path(tmp).unlink(missing_ok=True)


def xdg(name, fallback):
    directory = Path(os.environ.get(name, ""))
    return directory if directory.is_absolute() else Path.home() / fallback


def run(installed, destination=None, open_url=fetch, *, record_status=False, public_status_dir=None):
    current = version_parts(installed)
    latest = None
    try:
        stream = open_url(LATEST)
    except HTTPError as error:
        if error.code != 404:
            raise
        error.close()
        print(f"Installed {installed}. GitHub has no published stable release.")
    else:
        with stream:
            release = json.loads(read_metadata(stream, 1024 * 1024))
        if release["draft"] is not False or release["prerelease"] is not False:
            raise ValueError("GitHub did not return a published stable release.")
        tag = release["tag_name"]
        if not isinstance(tag, str) or not tag.startswith("v"):
            raise ValueError("Unexpected official release tag.")
        latest = tag[1:]
        upstream = version_parts(latest)
        if upstream == current:
            print(f"Installed {installed} is the current stable release.")
        elif upstream < current:
            print(f"Installed {installed} is ahead of stable {tag}.")
        else:
            print(f"Installed {installed}. Stable update available: {tag}.")
            if destination:
                stage(release, tag, destination, open_url)
    # Only publish validated version numbers. Network failures keep the last good observation.
    status = json.dumps({"schema": 1, "installedVersion": installed, "latestVersion": latest}) + "\n"
    if record_status:
        private = xdg("XDG_STATE_HOME", ".local/state") / "lattice-web-ui"
        private.mkdir(mode=0o700, parents=True, exist_ok=True)
        atomic_write(private / STATUS_FILE, status, 0o600)
    if public_status_dir:
        atomic_write(public_status_dir / STATUS_FILE, status, 0o644)


def unit_arg(value):
    text = str(value)
    if any(ord(char) < 32 or ord(char) == 127 for char in text):
        raise ValueError("Control characters are unsupported in systemd paths.")
    return '"' + text.replace("%", "%%").replace("\\", "\\\\").replace('"', '\\"') + '"'


def configure_timer(remove, version_override=None, public_status_dir=None):
    if not sys.platform.startswith("linux"):
        raise ValueError("The update timer requires a Linux systemd user manager.")
    directory = xdg("XDG_CONFIG_HOME", ".config") / "systemd/user"
    timer = directory / f"{UNIT}.timer"
    service = directory / f"{UNIT}.service"
    existing = []
    for path in (timer, service):
        if os.path.lexists(path):
            if path.is_symlink() or not path.is_file() or not path.read_text().startswith(MARKER + "\n"):
                raise ValueError(f"Another unit already owns {path}.")
            existing.append(path)

    def systemctl(*args):
        subprocess.run(["systemctl", "--user", *args], check=True)

    if remove:
        if timer in existing:
            systemctl("disable", "--now", timer.name)
        if service in existing:
            systemctl("stop", service.name)
        for path in existing:
            path.unlink()
        if existing:
            systemctl("daemon-reload")
        print("Host update timer removed.")
        return

    args = [sys.executable, Path(__file__).resolve(), "--record-status"]
    if version_override:
        args.extend(["--installed-version", version_override])
    if public_status_dir:
        args.extend(["--public-status-dir", public_status_dir.resolve(strict=True)])
    command = " ".join(unit_arg(value) for value in args)
    directory.mkdir(parents=True, exist_ok=True)
    # ':' disables systemd's environment-variable expansion in literal argument paths.
    atomic_write(service, f"""{MARKER}
[Unit]
Description=Check for a stable Lattice-web-ui host update

[Service]
Type=oneshot
ExecStart=:{command}
TimeoutStartSec=60s
NoNewPrivileges=yes
""", 0o644)
    atomic_write(timer, f"""{MARKER}
[Unit]
Description=Check for Lattice-web-ui host updates every 15 minutes

[Timer]
OnActiveSec=1min
OnUnitActiveSec=15min
RandomizedDelaySec=30s
AccuracySec=15s

[Install]
WantedBy=timers.target
""", 0o644)
    systemctl("daemon-reload")
    systemctl("enable", "--now", timer.name)
    print(f"Update timer enabled. View checks with journalctl --user -u {service.name}.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--installed-version", metavar="X.Y.Z",
                        help="release version of an older installation without release-version.txt")
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument("--install-timer", action="store_true", help="enable recurring checks for this Linux user")
    actions.add_argument("--uninstall-timer", action="store_true", help="disable and remove this user's update timer")
    actions.add_argument("--prepare", metavar="DIR", type=Path,
                        help="download a newer, checksum-verified source kit into DIR")
    parser.add_argument("--record-status", action="store_true", help="save the last successful check in the user state directory")
    parser.add_argument("--public-status-dir", metavar="DIR", type=Path,
                        help="also write public version metadata into this existing directory")
    args = parser.parse_args()
    if args.uninstall_timer:
        try:
            configure_timer(True)
        except (OSError, ValueError, subprocess.CalledProcessError) as error:
            parser.exit(1, f"Could not remove host update timer: {error}\n")
        return
    if args.public_status_dir and not args.public_status_dir.is_dir():
        parser.error("--public-status-dir must be an existing directory.")
    if args.installed_version is None and not KIT_VERSION.is_file():
        parser.error("Pass --installed-version X.Y.Z from the installed kit or its original archive name.")
    try:
        installed = args.installed_version if args.installed_version is not None else KIT_VERSION.read_text().strip()
        if args.install_timer:
            version_parts(installed)
            configure_timer(False, args.installed_version, args.public_status_dir)
        else:
            run(installed, args.prepare, record_status=args.record_status, public_status_dir=args.public_status_dir)
    except (ValueError, KeyError, TypeError, OSError, HTTPException, subprocess.CalledProcessError) as error:
        parser.exit(1, f"Host update check failed: {error}\n")


if __name__ == "__main__":
    main()
