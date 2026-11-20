"""lattice-host without systemd: staging, verification, unit files, update and rollback.

Run: python3 test/host_kit.py
"""

import hashlib
import importlib.util
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
TOOL = HERE.parent / "host" / "lattice-host.py"

FAKE_APPIMAGE = """#!/bin/sh
# Stands in for a Lattice AppImage: only --appimage-extract is supported.
[ "$1" = "--appimage-extract" ] || exit 64
mkdir -p squashfs-root/usr/bin
printf '#!/bin/sh\necho bundled-opener\n' > squashfs-root/usr/bin/xdg-open
printf '#!/bin/sh\\necho lattice VERSION "$@"\\n' > squashfs-root/AppRun
chmod +x squashfs-root/AppRun
"""


def load_tool(config_home: Path):
    os.environ["XDG_CONFIG_HOME"] = str(config_home)
    spec = importlib.util.spec_from_file_location("lattice_host", TOOL)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class HostKitTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.root = base / "host"
        self.config_home = base / "config"
        self.tool = load_tool(self.config_home)
        self.releases = []
        for version in ("0.18.0", "0.19.0"):
            image = base / f"Lattice_{version}.AppImage"
            image.write_text(FAKE_APPIMAGE.replace("VERSION", version))
            image.chmod(0o755)
            self.releases.append({"version": version, "url": f"file://{image}", "sha256": hashlib.sha256(image.read_bytes()).hexdigest()})
        self.releases[0]["frontendRewrite"] = {"http": 4, "ws": 2, "protocol": 1, "hostname": 2, "port": 1}
        self.manifest = base / "lattice-releases.json"
        self.manifest.write_text(json.dumps({"default": "0.18.0", "releases": self.releases}))
        self.gateway = base / "lattice-gateway"
        self.gateway.write_text("#!/bin/sh\n")
        self.gateway.chmod(0o755)
        self.xvfb = base / "Xvfb"
        self.xvfb.write_text("#!/bin/sh\n")
        self.xvfb.chmod(0o755)

    def tearDown(self):
        self.temp.cleanup()

    def run_tool(self, *argv):
        return self.tool.main(["--root", str(self.root), *argv])

    def install(self, *extra):
        return self.run_tool(
            "install", "--public-origin", "https://w.example.ts.net", "--manifest", str(self.manifest),
            "--gateway-binary", str(self.gateway), "--xvfb", str(self.xvfb), "--no-start", *extra,
        )

    def test_install_writes_a_private_tree_and_three_units(self):
        self.assertEqual(self.install(), 0)
        self.assertEqual(stat.S_IMODE(self.root.stat().st_mode), 0o700)
        self.assertEqual(os.readlink(self.root / "current"), "releases/0.18.0")
        self.assertEqual(stat.S_IMODE((self.root / "host.json").stat().st_mode), 0o600)
        units = self.config_home / "systemd/user"
        for unit in self.tool.UNITS:
            self.assertTrue((units / unit).exists(), unit)
        gateway_unit = (units / "lattice-gateway.service").read_text()
        self.assertIn("--public-origin https://w.example.ts.net", gateway_unit)
        self.assertIn("--upstream 127.0.0.1:18452", gateway_unit)
        launcher = (self.root / "bin/run-lattice").read_text()
        self.assertIn("exec env -i", launcher)
        self.assertIn("DISPLAY=:99", launcher)
        self.assertIn("dbus-run-session --", launcher)
        self.assertIn("current/squashfs-root/AppRun --browser-host", launcher)
        self.assertIn(f"PATH={self.root / 'bin'}:", launcher, "the no-op xdg-open comes first")
        self.assertNotIn("WAYLAND_DISPLAY", launcher)

    def test_lattice_opener_forwards_only_entry_addresses(self):
        import subprocess
        self.assertEqual(self.install("--projects-root", "~/papers"), 0)
        spool = self.root / "state/open-requests"
        self.assertEqual(stat.S_IMODE(spool.stat().st_mode), 0o700)
        bundled = self.root / "releases/0.18.0/squashfs-root/usr/bin/xdg-open"
        self.assertEqual(bundled.read_text(), (self.root / "bin/xdg-open").read_text(), "the AppImage's own opener is replaced")
        for url in ("https://example.org/", "http://127.0.0.1:18452/", "file:///etc/passwd"):
            subprocess.run([str(bundled), url], check=True)
        self.assertEqual(list(spool.iterdir()), [])
        subprocess.run([str(bundled), "http://127.0.0.1:18452/?entry=abc123"], check=True)
        files = list(spool.iterdir())
        self.assertEqual(len(files), 1)
        self.assertEqual(files[0].read_text(), "http://127.0.0.1:18452/?entry=abc123\n")
        unit = (self.config_home / "systemd/user/lattice-gateway.service").read_text()
        self.assertIn("--rewrite-loopback-page", unit)
        self.assertIn(f"--open-requests {spool}", unit)
        self.assertIn(f"--projects-root {Path('~/papers').expanduser()}", unit)

    def test_refuses_a_file_whose_checksum_does_not_match(self):
        self.releases[0]["sha256"] = "0" * 64
        self.manifest.write_text(json.dumps({"default": "0.18.0", "releases": self.releases}))
        self.assertEqual(self.install(), 1)
        self.assertFalse((self.root / "releases/0.18.0").exists())
        self.assertFalse((self.root / "current").exists())

    def test_update_and_rollback_move_the_current_link(self):
        self.assertEqual(self.install(), 0)
        self.assertEqual(self.run_tool("update", "--to", "0.19.0", "--no-start"), 0)
        self.assertEqual(os.readlink(self.root / "current"), "releases/0.19.0")
        self.assertEqual(os.readlink(self.root / "previous"), "releases/0.18.0")
        self.assertIn("0.19.0", (self.config_home / "systemd/user/lattice-browser-host.service").read_text())
        self.assertNotIn("--rewrite-loopback-page", (self.config_home / "systemd/user/lattice-gateway.service").read_text(),
                         "a release that pins no rewrites gets none")
        self.assertEqual(self.run_tool("rollback", "--no-start"), 0)
        self.assertEqual(os.readlink(self.root / "current"), "releases/0.18.0")
        self.assertEqual(self.run_tool("update", "--to", "9.9.9", "--no-start"), 1)

    def test_owner_page_needs_a_login(self):
        self.assertEqual(self.install("--owner-origin", "https://h.example.ts.net:9443"), 1)
        self.assertEqual(self.install("--owner-origin", "https://h.example.ts.net:9443", "--owner-login", "me@example.com"), 0)
        unit = (self.config_home / "systemd/user/lattice-gateway.service").read_text()
        self.assertIn("--owner-socket", unit)
        self.assertEqual((self.root / "owner-logins").read_text(), "me@example.com\n")


if __name__ == "__main__":
    sys.exit(0 if unittest.main(exit=False, verbosity=2).result.wasSuccessful() else 1)
