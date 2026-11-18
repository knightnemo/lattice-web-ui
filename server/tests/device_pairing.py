#!/usr/bin/env python3
"""Run the real Axum pairing routes against an isolated store and test project."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import http.client
import json
import os
import socket
import subprocess
import time
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit

import smoke

ORIGIN = "https://workspace.example.test"


class DevicePairing(unittest.TestCase):
    request = smoke.HeadlessSmoke.__dict__["request"]

    @classmethod
    def setUpClass(cls):
        flags = ["--secure-cookies", "--device-pairing", "--public-origin", ORIGIN]
        with patch.dict(os.environ, {"LATTICE_TEST_SERVER_ARGS": json.dumps(flags)}):
            smoke.HeadlessSmoke.setUpClass.__func__(cls)

    @classmethod
    def tearDownClass(cls):
        smoke.HeadlessSmoke.tearDownClass.__func__(cls)

    @classmethod
    def login(cls):
        status, headers, payload = cls.request(
            "POST", "/api/session", {"token": cls.token}, origin=ORIGIN
        )
        assert status == 200, payload
        assert json.loads(payload)["canManageDevices"] is True
        return headers["set-cookie"].split(";", 1)[0]

    def invite(self, cookie):
        status, headers, payload = self.request(
            "POST", "/api/devices/invites", {}, cookie=cookie, origin=ORIGIN
        )
        self.assertEqual(status, 200, payload)
        self.assertEqual(headers["cache-control"], "no-store")
        reply = json.loads(payload)
        self.assertEqual(reply["expiresIn"], 120)
        self.assertGreater(len(reply["qr"]), 21)
        self.assertTrue(all(len(row) == len(reply["qr"]) for row in reply["qr"]))
        url = urlsplit(reply["url"])
        self.assertEqual(f"{url.scheme}://{url.netloc}", ORIGIN)
        code = url.fragment.removeprefix("pair=")
        self.assertRegex(code, r"^[0-9a-f]{64}$")
        return code

    def pair(self, code, label, origin=ORIGIN):
        return self.request("POST", "/api/devices/pair", {"code": code, "label": label}, origin=origin)

    def resume(self, device):
        status, headers, payload = self.request(
            "POST", "/api/devices/resume", {}, cookie=device, origin=ORIGIN
        )
        self.assertEqual(status, 200)
        self.assertFalse(json.loads(payload)["canManageDevices"])
        return headers["set-cookie"].split(";", 1)[0]

    def restart(self):
        cls = type(self)
        args = cls.server.args
        cls.server.terminate()
        cls.server.wait(timeout=6)
        cls.server = subprocess.Popen(args, stdout=cls.log, stderr=cls.log)
        for _ in range(100):
            if cls.server.poll() is not None:
                cls.log.seek(0)
                self.fail(cls.log.read())
            try:
                if self.request("GET", "/api/session")[0] == 200:
                    return
            except OSError:
                pass
            time.sleep(0.03)
        self.fail("Pairing server did not restart.")

    def test_pairing_lifecycle_with_two_devices(self):
        owner = self.login()
        args = list(self.server.args)
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            args[args.index("--listen") + 1] = f"127.0.0.1:{listener.getsockname()[1]}"
        duplicate = subprocess.run(args, capture_output=True, text=True, timeout=5)
        self.assertNotEqual(duplicate.returncode, 0)
        self.assertIn("exclusively lock the paired-device store", duplicate.stderr)
        self.assertEqual(self.request("GET", "/api/devices", bearer=True)[0], 403)
        self.assertEqual(self.request("GET", "/api/projects", bearer=True)[0], 401)
        self.assertEqual(self.request("POST", "/api/session", {"token": self.token})[0], 403)
        status = self.request("POST", "/api/devices/invites", {}, cookie=owner, origin="https://elsewhere.test")[0]
        self.assertEqual(status, 403)
        gateway = self.request("GET", "/api/session", origin=ORIGIN, extra_headers={"X-Lattice-Account-Proxy": self.token})
        self.assertFalse(json.loads(gateway[2])["authenticated"])
        self.assertNotIn("set-cookie", gateway[1])

        code = self.invite(owner)
        self.assertEqual(self.pair(code, "A", origin="https://elsewhere.test")[0], 403)
        with ThreadPoolExecutor(max_workers=2) as executor:
            race = list(executor.map(lambda _: self.pair(code, "First phone"), range(2)))
        self.assertEqual(sorted(result[0] for result in race), [200, 401])
        _, headers, _ = next(result for result in race if result[0] == 200)
        first_device = headers["set-cookie"].split(";", 1)[0]
        self.assertTrue(first_device.startswith("__Host-lattice_device="))
        for attribute in ("Secure", "HttpOnly", "Path=/", "SameSite=Strict"):
            self.assertIn(attribute, headers["set-cookie"])
        first = self.resume(first_device)
        self.assertEqual(self.resume(first_device), first)
        self.assertEqual(self.request("GET", "/api/capabilities", cookie=first_device)[0], 401)
        self.assertEqual(self.request("POST", "/api/devices/invites", {}, cookie=first, origin=ORIGIN)[0], 403)
        self.assertEqual(self.pair(code, "Replay")[0], 401)
        path = self.base / "state" / "paired-devices.json"
        saved = path.read_text()
        secret = first_device.split("=", 1)[1]
        self.assertNotIn(secret, saved)
        self.assertIn(hashlib.sha256(secret.encode()).hexdigest(), saved)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)

        _, headers, _ = self.pair(self.invite(owner), "Second phone")
        second_device = headers["set-cookie"].split(";", 1)[0]
        second = self.resume(second_device)
        status, _, payload = self.request(
            "POST", "/api/invoke",
            {"command":"write_project_file","args":{"path":"notes.md","content":"Paired edit\n","baseContent":"alpha original\n"}},
            cookie=second, origin=ORIGIN,
        )
        self.assertEqual(status, 200, payload)
        self.assertEqual((self.workspace / "alpha" / "notes.md").read_text(), "Paired edit\n")

        _, _, payload = self.request("GET", "/api/devices", cookie=owner)
        devices = json.loads(payload)["devices"]
        self.assertEqual([device["label"] for device in devices], ["First phone", "Second phone"])
        self.assertNotIn("credentialDigest", payload.decode())
        revoke = f"/api/devices/{devices[0]['id']}/revoke"
        self.assertEqual(self.request("POST", revoke, {}, cookie=second, origin=ORIGIN)[0], 403)

        stream = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            stream.request("GET", "/api/events", headers={"Cookie": first})
            response = stream.getresponse()
            self.assertEqual(response.status, 200)
            self.assertIn(b"server-ready", response.readline())
            self.assertEqual(self.request("POST", revoke, {}, cookie=owner, origin=ORIGIN)[0], 200)
            # Frames already queued before revocation may be buffered on the
            # socket. A write that starts after revocation must never arrive.
            new_file = "after-revocation.txt"
            status, _, payload = self.request(
                "POST", "/api/invoke",
                {"command": "write_project_file", "args": {"path": new_file, "content": "still paired\n"}},
                cookie=second, origin=ORIGIN,
            )
            self.assertEqual(status, 200, payload)
            self.assertNotIn(new_file.encode(), response.read())
            self.assertEqual(self.request("GET", "/api/projects", cookie=first)[0], 401)
            self.assertEqual(self.request("GET", "/api/projects", cookie=second)[0], 200)
        finally:
            stream.close()

        pending = self.invite(owner)
        self.restart()
        self.assertEqual(self.pair(pending, "Stale invite")[0], 401)
        self.assertEqual(self.request("GET", "/api/projects", cookie=second)[0], 401)
        self.assertEqual(self.request("POST", "/api/devices/resume", {}, cookie=first_device, origin=ORIGIN)[0], 401)
        self.assertEqual(self.request("GET", "/api/projects", cookie=self.resume(second_device))[0], 200)
        status, headers, _ = self.request("DELETE", "/api/session", cookie=second_device, origin=ORIGIN)
        self.assertEqual(status, 204)
        self.assertIn("Max-Age=0", headers["set-cookie"])
        for _ in range(31):
            limited = self.pair("0" * 64, "Invalid")
        self.assertEqual(limited[0], 429)
        self.assertIn("retry-after", limited[1])
        self.assertEqual(self.request("GET", "/api/projects", cookie=self.resume(second_device))[0], 200)


if __name__ == "__main__":
    unittest.main()
