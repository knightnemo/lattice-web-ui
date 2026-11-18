#!/usr/bin/env python3
"""Serve Lattice device management through a private Tailscale Unix socket."""

import argparse
import contextlib
import errno
import fcntl
import hmac
import html
import http.client
import json
import os
import re
import signal
import socket
import socketserver
import stat
import struct
import threading
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlsplit


MAX_RESPONSE_BYTES = 128 * 1024
SESSION_COOKIE = re.compile(r"lattice_session=([a-f0-9]{32});")
# Preserve the ID returned by the companion. Current builds use compact UUIDs.
DEVICE_ID_PATTERN = r"(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})"
DEVICE_ID = re.compile(DEVICE_ID_PATTERN)
REVOKE_PATH = re.compile(rf"/api/devices/{DEVICE_ID_PATTERN}/revoke")
INVITE_CODE = re.compile(r"[A-Za-z0-9_-]{32,128}")
CONTENT_SECURITY_POLICY = (
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; "
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
)


class UpstreamError(Exception):
    """A pairing operation could not be completed."""

    def __init__(self, status=502):
        self.status = status


def https_origin(value):
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or not re.fullmatch(r"[a-z0-9.-]+", parsed.hostname)
        or not re.fullmatch(r"[a-z0-9.-]+(?::[1-9][0-9]{0,4})?", parsed.netloc)
        or value != f"https://{parsed.netloc}"
        or (parsed.port is not None and not 1 <= parsed.port <= 65535)
        or parsed.port == 443
    ):
        raise ValueError("Use a canonical HTTPS origin without a path or default port.")
    return value


def private_value(path, pattern, maximum):
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as file:
        metadata = os.fstat(file.fileno())
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_mode & 0o077:
            raise ValueError("The credential file must be a private regular file.")
        contents = file.read(maximum + 3)
        if len(contents) > maximum + 2:
            raise ValueError("The credential file is too long.")
        value = contents.decode("ascii").strip()
    if not pattern.fullmatch(value):
        raise ValueError("Invalid credential file format.")
    return value


def safe_device(device):
    if not isinstance(device, dict):
        raise UpstreamError()
    device_id = device.get("id")
    label = device.get("label")
    expires = device.get("expiresAt")
    if (
        not isinstance(device_id, str)
        or not DEVICE_ID.fullmatch(device_id)
        or not isinstance(label, str)
        or not 1 <= len(label) <= 64
        or type(expires) is not int
        or not 0 < expires < 253402300800
    ):
        raise UpstreamError()
    return {"id": device_id, "label": label, "expiresAt": expires}


class LatticePairing:
    def __init__(self, port, public_origin, token_file):
        self.port = port
        self.public_origin = public_origin
        self.public_authority = urlsplit(public_origin).netloc
        self.token_file = token_file
        self.cookie = None
        self.lock = threading.Lock()

    def request(self, method, path, body=None):
        headers = {
            "Host": self.public_authority,
            "Origin": self.public_origin,
            "Accept": "application/json",
        }
        if body is not None:
            headers["Content-Type"] = "application/json"
        if self.cookie is not None:
            headers["Cookie"] = self.cookie
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            connection.request(method, path, body, headers)
            response = connection.getresponse()
            if response.status != 200:
                return response.status, [], None
            raw = response.read(MAX_RESPONSE_BYTES + 1)
            if len(raw) > MAX_RESPONSE_BYTES:
                raise UpstreamError()
            data = json.loads(raw)
            if not isinstance(data, dict):
                raise UpstreamError()
            cookies = [
                match.group(1)
                for key, value in response.getheaders()
                if key.lower() == "set-cookie" and (match := SESSION_COOKIE.match(value))
            ]
            return response.status, cookies, data
        finally:
            connection.close()

    def login(self):
        token = private_value(self.token_file, re.compile(r"[A-Za-z0-9_-]{32,512}"), 512)
        status, cookies, data = self.request("POST", "/api/session", json.dumps({"token": token}))
        if (
            status != 200
            or len(cookies) != 1
            or any(data.get(key) is not True for key in (
                "authenticated", "devicePairing", "canManageDevices"
            ))
        ):
            raise UpstreamError()
        self.cookie = f"lattice_session={cookies[0]}"

    def operation(self, method, path):
        with self.lock:
            if self.cookie is None:
                self.login()
            status, _, data = self.request(method, path)
            if status in (401, 403):
                self.cookie = None
                self.login()
                status, _, data = self.request(method, path)
        if status != 200:
            raise UpstreamError(429 if status == 429 else 502)
        if path == "/api/devices":
            devices = data.get("devices")
            if not isinstance(devices, list) or len(devices) > 256:
                raise UpstreamError()
            return {"devices": [safe_device(device) for device in devices]}
        if path == "/api/devices/invites":
            return self.invite(data)
        if data.get("revoked") is not True:
            raise UpstreamError()
        return {"revoked": True}

    def invite(self, data):
        url = data.get("url")
        matrix = data.get("qr")
        expires = data.get("expiresIn")
        prefix = f"{self.public_origin}/#pair="
        if (
            not isinstance(url, str)
            or not url.startswith(prefix)
            or not INVITE_CODE.fullmatch(url[len(prefix):])
            or not isinstance(matrix, list)
            or not 21 <= len(matrix) <= 177
            or any(
                not isinstance(row, str) or len(row) != len(matrix) or set(row) - {"0", "1"}
                for row in matrix
            )
            or type(expires) is not int
            or not 0 < expires <= 300
        ):
            raise UpstreamError()
        return {"url": url, "qr": matrix, "expiresIn": expires}


class OwnerHandler(BaseHTTPRequestHandler):
    def setup(self):
        self.request.settimeout(6)
        super().setup()

    def log_message(self, *_):
        pass

    def version_string(self):
        return "Lattice-web-ui"

    def send_content(self, status, body, content_type):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", CONTENT_SECURITY_POLICY)
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, status, data):
        self.send_content(status, json.dumps(data).encode("ascii"), "application/json")

    def do_GET(self):
        self.handle_request()

    def do_POST(self):
        self.handle_request()

    def handle_request(self):
        origin = self.headers.get_all("Origin", [])
        logins = self.headers.get_all("Tailscale-User-Login", [])
        # Serve rewrites Host to localhost for its Unix socket handlers. Its
        # protected socket carries the original HTTPS authority separately.
        if (
            self.headers.get_all("Host", []) != ["localhost"]
            or self.headers.get_all("X-Forwarded-Host", []) != [self.server.private_authority]
            or self.headers.get_all("X-Forwarded-Proto", []) != ["https"]
            or self.headers.get_all("Tailscale-Funnel-Request", [])
            or len(logins) != 1
            or not hmac.compare_digest(logins[0].encode("latin-1"), self.server.owner)
        ):
            self.send_json(403, {"error": "This entrance requires the owner's Tailscale account."})
            return
        if (
            len(origin) > 1
            or (origin and origin != [self.server.private_origin])
            or (self.command == "POST" and origin != [self.server.private_origin])
        ):
            self.send_json(403, {"error": "Open this page directly to manage devices."})
            return
        if (
            self.headers.get_all("Content-Length", []) not in ([], ["0"])
            or self.headers.get_all("Transfer-Encoding", [])
        ):
            self.send_json(400, {"error": "This request cannot contain a body."})
            return
        if self.command == "GET" and self.path in self.server.assets:
            body, content_type = self.server.assets[self.path]
            self.send_content(200, body, content_type)
            return
        if not (
            (self.command == "GET" and self.path == "/api/devices")
            or (self.command == "POST" and (
                self.path == "/api/devices/invites" or REVOKE_PATH.fullmatch(self.path)
            ))
        ):
            self.send_json(404, {"error": "Unknown device management route."})
            return
        try:
            data = self.server.pairing.operation(self.command, self.path)
        except UpstreamError as error:
            self.send_json(error.status, {"error": (
                "Too many active invitations." if error.status == 429
                else "The workspace is temporarily unavailable. Try again."
            )})
        except (OSError, ValueError, http.client.HTTPException):
            self.send_json(502, {"error": "The workspace is temporarily unavailable. Try again."})
        else:
            self.send_json(200, data)


class OwnerServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    request_queue_size = 8

    def __init__(self, args):
        self.owner = private_value(
            args.owner_file, re.compile(r"[A-Za-z0-9._+@-]{1,254}"), 254
        ).encode("ascii")
        self.ingress_uid = args.ingress_uid
        self.private_origin = args.private_origin
        self.private_authority = urlsplit(args.private_origin).netloc
        self.pairing = LatticePairing(args.upstream_port, args.public_origin, args.token_file)
        directory = Path(__file__).resolve().parent
        page = (directory / "index.html").read_text(encoding="utf-8")
        self.assets = {
            "/": (
                page.replace("{{PUBLIC_ORIGIN}}", html.escape(args.public_origin)).encode(),
                "text/html; charset=utf-8",
            ),
            "/owner.js": ((directory / "owner.js").read_bytes(), "text/javascript; charset=utf-8"),
            "/owner.css": ((directory / "owner.css").read_bytes(), "text/css; charset=utf-8"),
        }
        super().__init__(str(args.socket), OwnerHandler)

    def verify_request(self, request, _address):
        if hasattr(socket, "SO_PEERCRED"):
            try:
                credentials = request.getsockopt(
                    socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")
                )
                _, uid, _ = struct.unpack("3i", credentials)
                return uid == self.ingress_uid
            except OSError:
                return False
        # The private socket's filesystem permissions also apply on macOS/BSD.
        return True

    def handle_error(self, *_):
        # Never log request fields, paths, socket addresses, or upstream errors.
        pass


@contextlib.contextmanager
def private_socket(path):
    parent = path.parent.lstat()
    if (
        not path.is_absolute()
        or not stat.S_ISDIR(parent.st_mode)
        or parent.st_uid != os.geteuid()
        or stat.S_IMODE(parent.st_mode) != 0o700
    ):
        raise ValueError("The socket parent must be an absolute private directory (mode 0700).")
    lock_path = path.with_name(f"{path.name}.lock")
    flags = os.O_WRONLY | os.O_NOFOLLOW | os.O_CREAT | os.O_NONBLOCK
    with os.fdopen(os.open(lock_path, flags, 0o600), "w") as lock:
        if not stat.S_ISREG(os.fstat(lock.fileno()).st_mode):
            raise ValueError("Invalid socket lock file.")
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if path.exists() or path.is_symlink():
            existing = path.lstat()
            if not stat.S_ISSOCK(existing.st_mode) or existing.st_uid != os.geteuid():
                raise ValueError("The configured socket path is already in use.")
            with socket.socket(socket.AF_UNIX) as client:
                client.settimeout(2)
                try:
                    client.connect(str(path))
                except OSError as error:
                    if error.errno != errno.ECONNREFUSED:
                        raise
                else:
                    raise ValueError("The configured socket is already listening.")
            path.unlink()
        try:
            yield
        finally:
            if path.is_socket():
                path.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--socket", type=Path, required=True)
    parser.add_argument("--owner-file", type=Path, required=True)
    parser.add_argument("--token-file", type=Path, required=True)
    parser.add_argument("--private-origin", type=https_origin, required=True)
    parser.add_argument("--public-origin", type=https_origin, required=True)
    parser.add_argument("--upstream-port", type=int, required=True)
    parser.add_argument("--ingress-uid", type=int, default=0)
    args = parser.parse_args()
    if args.private_origin == args.public_origin:
        parser.error("The private and public HTTPS origins must differ.")
    if not 1 <= args.upstream_port <= 65535 or not 0 <= args.ingress_uid < 2**32 - 1:
        parser.error("Invalid upstream port or ingress UID.")
    os.umask(0o077)

    def stop(_signal, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop)
    try:
        with private_socket(args.socket), OwnerServer(args) as server:
            args.socket.chmod(0o600)
            server.serve_forever()
    except KeyboardInterrupt:
        pass
    except (OSError, ValueError):
        parser.exit(1, "Could not start the private owner gateway. Check its socket and configuration.\n")


if __name__ == "__main__":
    main()
