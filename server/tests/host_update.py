#!/usr/bin/env python3
"""Exercise the managed updater boundary against the compiled server."""
import fcntl
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

import device_pairing
import smoke

STATUS = "/api/host-update"
ORIGIN = device_pairing.ORIGIN


class HostUpdate(unittest.TestCase):
    request = smoke.HeadlessSmoke.__dict__["request"]
    login = device_pairing.DevicePairing.__dict__["login"]
    invite = device_pairing.DevicePairing.invite
    pair = device_pairing.DevicePairing.pair
    resume = device_pairing.DevicePairing.resume

    @classmethod
    def setUpClass(cls):
        installation = tempfile.TemporaryDirectory(prefix="lattice-managed-")
        cls.addClassCleanup(installation.cleanup)
        base = Path(installation.name)
        installed = base / "release"
        installed.mkdir()
        cls.updates = base / "updates"
        cls.updates.mkdir()
        binary = installed / "lattice-server"
        shutil.copy2(smoke.BINARY, binary)
        (installed / "release-version.txt").write_text("0.4.8\n")
        with patch.object(smoke, "BINARY", str(binary)), patch.dict("os.environ", {
            "LATTICE_TEST_SERVER_ARGS": json.dumps([
                "--secure-cookies", "--device-pairing", "--public-origin", ORIGIN,
                "--host-update-dir", str(cls.updates),
            ]),
        }):
            smoke.HeadlessSmoke.setUpClass.__func__(cls)
        cls.addClassCleanup(smoke.HeadlessSmoke.tearDownClass.__func__, cls)

    def get(self):
        status, headers, body = self.request("GET", STATUS, cookie=self.cookie)
        self.assertEqual(status, 200, body)
        self.assertEqual(headers["cache-control"], "no-store")
        return json.loads(body)

    def test_owner_queue_and_locking(self):
        health = self.request("GET", STATUS + "/health")
        self.assertEqual(json.loads(health[2]), {"version": "0.4.8"})
        self.assertEqual(self.get()["phase"], "current")
        (self.updates / "status.json").write_text(json.dumps({
            "schema": 1, "installedVersion": "0.4.8", "latestVersion": "0.4.9", "phase": "ready",
        }))
        self.assertEqual(self.get()["phase"], "ready")
        code = self.invite(self.cookie)
        status, headers, _ = self.pair(code, "Phone")
        self.assertEqual(status, 200)
        device = self.resume(headers["set-cookie"].split(";", 1)[0])
        self.assertEqual(self.request("GET", STATUS, cookie=device)[0], 403)
        approval = {"version": "0.4.9"}
        for cookie, origin in [(device, ORIGIN), (self.cookie, "https://wrong.example"), (self.cookie, None)]:
            self.assertEqual(self.request("POST", STATUS, approval, cookie=cookie, origin=origin)[0], 403)
        request = self.updates / "request"
        self.assertFalse(request.exists())
        self.assertEqual(self.request("POST", STATUS, {"version": "9.0.0"}, cookie=self.cookie, origin=ORIGIN)[0], 409)

        command = {"command": "write_project_file", "args": {
            "path": "notes.md", "content": "still editable\n", "baseContent": "alpha original\n",
        }}
        with (self.updates / "work.lock").open("r+b") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            status, _, body = self.request("POST", "/api/invoke", command, cookie=self.cookie)
            self.assertEqual(status, 503)
            self.assertEqual(json.loads(body)["error"]["code"], "host_updating")
            self.assertEqual(self.request("POST", STATUS, approval, cookie=self.cookie, origin=ORIGIN)[0], 503)
        self.assertEqual(self.request("POST", "/api/invoke", command, cookie=self.cookie)[0], 200)
        trial = self.updates / "trial.json"
        trial.write_text("{}")
        self.assertEqual(self.request("POST", "/api/invoke", command, cookie=self.cookie)[0], 503)
        self.assertEqual(self.request("GET", "/index.html")[0], 503)
        self.assertEqual(self.request("GET", "/")[0], 200)
        trial.unlink()
        self.assertEqual(self.request("POST", STATUS, approval, cookie=self.cookie, origin=ORIGIN)[0], 202)
        self.assertEqual(request.read_text(), "0.4.9\n")
        self.assertEqual(self.get()["phase"], "preparing")


if __name__ == "__main__":
    unittest.main(verbosity=2)
