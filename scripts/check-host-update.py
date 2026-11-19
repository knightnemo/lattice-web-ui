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
import tempfile
from urllib.error import HTTPError
from urllib.request import Request, urlopen

REPOSITORY = "knightnemo/lattice-web-ui"
LATEST = f"https://api.github.com/repos/{REPOSITORY}/releases/latest"
VERSION = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")
KIT_VERSION = Path(__file__).resolve().parent / "release-version.txt"


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


def run(installed, destination=None, open_url=fetch):
    current = version_parts(installed)
    try:
        stream = open_url(LATEST)
    except HTTPError as error:
        if error.code != 404:
            raise
        error.close()
        print(f"Installed {installed}. GitHub has no published stable release.")
        return
    with stream:
        release = json.loads(read_metadata(stream, 1024 * 1024))
    if release["draft"] is not False or release["prerelease"] is not False:
        raise ValueError("GitHub did not return a published stable release.")
    tag = release["tag_name"]
    if not isinstance(tag, str) or not tag.startswith("v"):
        raise ValueError("Unexpected official release tag.")
    upstream = version_parts(tag[1:])
    if upstream == current:
        print(f"Installed {installed} is the current stable release.")
    elif upstream < current:
        print(f"Installed {installed} is ahead of stable {tag}.")
    else:
        print(f"Installed {installed}. Stable update available: {tag}.")
        if destination:
            stage(release, tag, destination, open_url)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--installed-version", metavar="X.Y.Z",
                        help="release version of an older installation without release-version.txt")
    parser.add_argument("--prepare", metavar="DIR", type=Path,
                        help="download a newer, checksum-verified source kit into DIR")
    args = parser.parse_args()
    if args.installed_version is None and not KIT_VERSION.is_file():
        parser.error("Pass --installed-version X.Y.Z from the installed kit or its original archive name.")
    try:
        installed = args.installed_version if args.installed_version is not None else KIT_VERSION.read_text().strip()
        run(installed, args.prepare)
    except (ValueError, KeyError, TypeError, OSError, HTTPException) as error:
        parser.exit(1, f"Host update check failed: {error}\n")


if __name__ == "__main__":
    main()
