#!/usr/bin/env python3
"""Install an isolated Linux user service and optionally a private Tailscale Serve handler."""

import argparse
from contextlib import ExitStack
import fcntl
import getpass
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import time
import urllib.request
import urllib.parse

MARKER = "# Managed by Lattice headless installer"
UPDATE_MARKER = "# Managed by Lattice headless updater"
UPDATE_FILES = ("check-host-update.py", "manage-host-update.py")


def run(*args, check=True):
    result = subprocess.run(args, text=True, capture_output=True)
    if check and result.returncode:
        raise RuntimeError(
            result.stderr.strip() or result.stdout.strip() or f"{args[0]} failed"
        )
    return result


def unit_arg(value):
    # ExecStart is systemd syntax, not a shell. Percent specifiers and quotes
    # must be escaped independently; never interpolate a path into shell code.
    return (
        '"'
        + str(value).replace("%", "%%").replace("\\", "\\\\").replace('"', '\\"')
        + '"'
    )


def serve_port_state(status, https_port, target):
    if str(https_port) not in status.get("TCP", {}):
        return "free"
    handlers = [
        value.get("Handlers", {})
        for name, value in status.get("Web", {}).items()
        if name.endswith(f":{https_port}")
    ]
    if len(handlers) == 1 and handlers[0] == {"/": {"Proxy": target}}:
        return "ours"
    raise RuntimeError(
        f"Tailscale Serve port {https_port} already has an unrelated handler; choose another port."
    )


def update_units(data, service, port, tool_path):
    name = service.removesuffix(".service") + "-updater"
    command = [
        sys.executable, data / "updates/manage-host-update.py",
        "--data-dir", data, "--service", service, "--port", port,
    ]
    return {
        name + ".service": "\n".join([
            UPDATE_MARKER, "[Unit]", "Description=Prepare or apply a Lattice host update",
            "After=network-online.target", "[Service]", "Type=oneshot",
            "UMask=0077", "PrivateTmp=true", "NoNewPrivileges=true",
            f'Environment="PATH={tool_path}"',
            "ExecStart=:" + " ".join(unit_arg(part) for part in command),
            "TimeoutStartSec=60min", "",
        ]),
        name + ".timer": "\n".join([
            UPDATE_MARKER, "[Unit]", "Description=Check Lattice host update requests",
            "[Timer]", "OnActiveSec=20s", "OnUnitInactiveSec=25s", "AccuracySec=1s",
            "[Install]", "WantedBy=timers.target", "",
        ]),
    }


def lock_updates(stack, directory):
    # Keep manual reinstall and automated switch from changing the same pointer.
    for name in ("worker.lock", "work.lock"):
        fd = os.open(directory / name, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        handle = stack.enter_context(os.fdopen(fd, "rb"))
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("The updater or workspace is busy. Finish active sessions and retry.") from None
    if (directory / "trial.json").exists():
        raise RuntimeError("Let the updater finish recovering the previous release before reinstalling.")


def install_release(config, unit, data, binary, assets, release_version, units):
    with ExitStack() as locks:
        if release_version:
            updates = data / "updates"
            updates.mkdir(exist_ok=True, mode=0o700)
            lock_updates(locks, updates)
            for name in UPDATE_FILES:
                shutil.copy2(binary.parent / name, updates / name)
        release = data / "releases" / str(time.time_ns())
        release.mkdir(parents=True, mode=0o700)
        shutil.copy2(binary, release / "lattice-server")
        shutil.copytree(assets, release / "assets")
        if release_version:
            (release / "release-version.txt").write_text(release_version + "\n")
        pending = data / "current.next"
        pending.unlink(missing_ok=True)
        pending.symlink_to(release, target_is_directory=True)
        pending.replace(data / "current")
        config.parent.mkdir(parents=True, exist_ok=True)
        config.write_text(unit)
        for name, contents in units.items():
            config.with_name(name).write_text(contents)
        run("systemctl", "--user", "daemon-reload")
        run("systemctl", "--user", "enable", "--now", config.name)
        run("systemctl", "--user", "restart", config.name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--assets", type=Path, required=True)
    parser.add_argument("--workspace-root", type=Path, required=True)
    parser.add_argument("--project", type=Path)
    parser.add_argument("--service-name", default="lattice-headless", help="Name of the systemd user service without .service")
    parser.add_argument(
        "--data-dir", type=Path, default=Path.home() / ".local/share/lattice-headless"
    )
    parser.add_argument("--port", type=int, default=18482)
    parser.add_argument("--https-port", type=int, default=8443)
    parser.add_argument(
        "--tailscale",
        action="store_true",
        help="Add a private HTTPS handler; never enable Funnel",
    )
    parser.add_argument(
        "--account-gateway", action="store_true",
        help="Use a separate HTTPS account gateway to create browser sessions",
    )
    parser.add_argument(
        "--device-pairing", action="store_true",
        help="Let the owner pair trusted devices through a dedicated HTTPS origin",
    )
    parser.add_argument(
        "--agent-runtime",
        type=Path,
        help="Prepared Linux agent runtime; provider login stays in the persistent state directory",
    )
    parser.add_argument("--agent-port", type=int, default=18583)
    parser.add_argument("--agent-https-port", type=int, default=8444)
    parser.add_argument(
        "--public-origin",
        help="Browser origin of the main workspace, including its HTTPS port",
    )
    parser.add_argument(
        "--agent-public-origin",
        help="Isolated agent origin: same hostname and scheme, different port",
    )
    parser.add_argument(
        "--disable-agent",
        action="store_true",
        help="Explicitly remove an existing agent configuration",
    )
    parser.add_argument(
        "--extra-path",
        default="",
        help="Absolute user tool directories, separated by ':' (for TeX)",
    )
    parser.add_argument(
        "--managed-updates", action="store_true",
        help="Enable verified, owner-approved host updates from official Web UI releases",
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if platform.system() != "Linux" and not args.dry_run:
        parser.error("The user service installer runs on Linux.")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", args.service_name):
        parser.error("Use letters, digits, hyphens or underscores for the service name.")
    service = args.service_name + ".service"
    if args.account_gateway and (
        args.tailscale or args.device_pairing or args.agent_runtime or args.agent_public_origin
        or not (args.public_origin or "").startswith("https://")
    ):
        parser.error("An account gateway requires an HTTPS --public-origin and its own service without --tailscale or an agent listener.")
    if args.device_pairing and (
        args.agent_runtime or args.agent_public_origin or not (args.public_origin or "").startswith("https://")
    ):
        parser.error("Device pairing requires an HTTPS --public-origin without a separate agent listener.")
    if any(
        not 1024 <= port <= 65535
        for port in (args.port, args.https_port, args.agent_port, args.agent_https_port)
    ):
        parser.error("Use unprivileged ports in 1024..65535.")
    if args.disable_agent and args.agent_runtime:
        parser.error("Choose either --agent-runtime or --disable-agent.")
    binary, assets, workspace = (
        p.expanduser().resolve(strict=True)
        for p in (args.binary, args.assets, args.workspace_root)
    )
    if (
        not binary.is_file()
        or not os.access(binary, os.X_OK)
        or not (assets / "index.html").is_file()
        or not workspace.is_dir()
    ):
        parser.error(
            "Provide an executable server, built frontend assets, and a workspace directory."
        )
    data = args.data_dir.expanduser().resolve()
    project = (
        args.project.expanduser().resolve(strict=True) if args.project else workspace
    )
    if not project.is_relative_to(workspace):
        parser.error("The initial project must be inside the workspace root.")
    for path in [binary, assets, workspace, project, data]:
        if any(character in str(path) for character in "\n\r\x00"):
            parser.error("Paths cannot contain control characters.")
    extra_paths = args.extra_path.split(":") if args.extra_path else []
    if any(
        not Path(path).is_absolute() or any(c in path for c in '\n\r"%')
        for path in extra_paths
    ):
        parser.error(
            "Extra tool directories must be absolute paths without quotes, newlines or '%'."
        )
    tool_path = ":".join(
        extra_paths
        + [str(Path.home() / ".local/bin"), "/usr/local/bin", "/usr/bin", "/bin"]
    )
    command = [
        data / "current/lattice-server",
        "serve",
        "--workspace-root",
        workspace,
        "--project",
        project,
        "--state-dir",
        data / "state",
        "--token-file",
        data / "access-token",
        "--listen",
        f"127.0.0.1:{args.port}",
        "--assets",
        data / "current/assets",
    ]
    config = (
        Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
        / "systemd/user" / service
    )
    previous = config.read_text() if config.exists() else ""
    secure = args.tailscale or args.account_gateway or args.device_pairing or "--secure-cookies" in previous
    if previous and MARKER not in previous:
        raise RuntimeError(f"Refusing to replace an unrelated service at {config}")
    if '"--host-update-dir"' in previous and not args.managed_updates:
        parser.error("Repeat --managed-updates for this service.")
    release_version = None
    units = {}
    if args.managed_updates:
        if sys.version_info < (3, 11):
            parser.error("Managed host updates require Python 3.11 or newer.")
        if args.account_gateway:
            parser.error("Managed updates require owner token sign-in, optionally with device pairing.")
        if data.is_relative_to(workspace) or workspace.is_relative_to(data):
            parser.error("Managed updates need --data-dir and workspace root in separate directories.")
        if any(not path.is_file() or path.is_symlink() for path in (
            binary.parent / name for name in (*UPDATE_FILES, "release-version.txt")
        )):
            parser.error("Use --binary from an extracted Lattice-web-ui host kit with the updater files.")
        release_version = (binary.parent / "release-version.txt").read_text().strip()
        if not re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", release_version):
            parser.error("Expected X.Y.Z in the host kit's release-version.txt.")
        command.extend(["--host-update-dir", data / "updates"])
        units = update_units(data, service, args.port, tool_path)
        for name in units:
            path = config.with_name(name)
            if path.is_symlink() or (path.exists() and (
                not path.is_file() or not path.read_text().startswith(UPDATE_MARKER + "\n")
            )):
                raise RuntimeError(f"Refusing to replace an unrelated unit at {path}")
    if previous and (
        ('"--account-gateway"' in previous) != args.account_gateway
        or ('"--device-pairing"' in previous) != args.device_pairing
    ):
        parser.error("Choose an unused --service-name and --data-dir when switching gateway modes.")
    for other in config.parent.glob("*.service"):
        if other == config or not other.is_file():
            continue
        contents = other.read_text(errors="replace")
        if MARKER in contents and unit_arg(command[0]) in contents:
            parser.error(f"{other.name} already uses this data directory. Choose a separate --data-dir.")
    if (
        '"--agent-runtime"' in previous
        and not args.agent_runtime
        and not args.disable_agent
    ):
        parser.error(
            "Preserve the existing agent runtime/origin arguments, or explicitly use --disable-agent."
        )
    for value in (args.public_origin, args.agent_public_origin):
        if value is None:
            continue
        origin = urllib.parse.urlsplit(value)
        if any(c in value for c in "\n\r\x00") or (
            origin.scheme not in ("http", "https")
            or not origin.hostname
            or origin.username
            or origin.password
            or origin.path not in ("", "/")
            or origin.query
            or origin.fragment
        ):
            parser.error(
                "Use plain HTTP(S) browser origins without credentials, paths, queries or fragments."
            )
    if args.agent_runtime:
        agent_runtime = args.agent_runtime.expanduser().resolve(strict=True)
        if not agent_runtime.is_dir() or any(
            c in str(agent_runtime) for c in "\n\r\x00"
        ):
            parser.error("Provide a prepared agent runtime directory.")
        if not args.public_origin or not args.agent_public_origin:
            parser.error(
                "Agent deployments require --public-origin and --agent-public-origin."
            )
        origins = [
            urllib.parse.urlsplit(value)
            for value in (args.public_origin, args.agent_public_origin)
        ]
        main_origin, agent_origin = origins
        if secure and main_origin.scheme != "https":
            parser.error("An HTTPS service needs HTTPS workspace and agent origins.")
        if (main_origin.scheme, main_origin.hostname) != (
            agent_origin.scheme,
            agent_origin.hostname,
        ) or main_origin.port == agent_origin.port:
            parser.error(
                "The agent origin must use the same hostname and scheme on a different port."
            )
        if args.port == args.agent_port:
            parser.error("The agent listener needs its own loopback port.")
        if args.tailscale and (
            main_origin.scheme != "https"
            or main_origin.port != args.https_port
            or agent_origin.port != args.agent_https_port
            or args.https_port == args.agent_https_port
        ):
            parser.error(
                "Tailscale agent origins must match the two distinct HTTPS handler ports."
            )
        command.extend(
            [
                "--agent-runtime",
                agent_runtime,
                "--agent-listen",
                f"127.0.0.1:{args.agent_port}",
                "--agent-public-origin",
                args.agent_public_origin.rstrip("/"),
            ]
        )
    elif args.agent_public_origin:
        parser.error("--agent-public-origin requires --agent-runtime.")
    if args.public_origin:
        command.extend(["--public-origin", args.public_origin.rstrip("/")])
    # An update without --tailscale must not downgrade an existing HTTPS session.
    if secure:
        command.append("--secure-cookies")
    if args.account_gateway:
        command.append("--account-gateway")
    if args.device_pairing:
        command.append("--device-pairing")
    unit = "\n".join(
        [
            MARKER,
            "[Unit]",
            "Description=Lattice private headless workspace",
            "After=network.target",
            "",
            "[Service]",
            "Type=simple",
            "UMask=0077",
            f'Environment="PATH={tool_path}"',
            "ExecStart=" + " ".join(unit_arg(part) for part in command),
            "Restart=on-failure",
            "RestartSec=3",
            "NoNewPrivileges=true",
            "PrivateTmp=true",
            "",
            "[Install]",
            "WantedBy=default.target",
            "",
        ]
    )
    if args.dry_run:
        print(unit)
        for name, contents in units.items():
            print(f"# {name}\n{contents}")
        return
    handlers = [(args.https_port, f"http://127.0.0.1:{args.port}")]
    if args.agent_runtime:
        handlers.append((args.agent_https_port, f"http://127.0.0.1:{args.agent_port}"))
    # Validate every handler before switching the running release. An existing
    # workspace handler must not skip setup of the isolated agent origin.
    port_states = []
    if args.tailscale:
        current = run("tailscale", "serve", "status", "--json")
        status = json.loads(current.stdout or "{}")
        port_states = [
            (port, target, serve_port_state(status, port, target))
            for port, target in handlers
        ]
    data.mkdir(parents=True, exist_ok=True, mode=0o700)
    data.chmod(0o700)
    install_release(config, unit, data, binary, assets, release_version, units)
    for attempt in range(30):
        try:
            with urllib.request.urlopen(
                f"http://127.0.0.1:{args.port}/api/session", timeout=2
            ) as response:
                if json.load(response).get("headless") is True:
                    break
        except (OSError, ValueError):
            pass
        time.sleep(0.2)
    else:
        raise RuntimeError(
            f"The service did not become healthy; inspect journalctl --user -u {service}"
        )
    if units:
        run("systemctl", "--user", "enable", "--now", next(name for name in units if name.endswith(".timer")))
    print(
        f"Service healthy on loopback port {args.port}. Access token file: {data / 'access-token'} (contents not displayed)."
    )
    linger = run(
        "loginctl",
        "show-user",
        getpass.getuser(),
        "-p",
        "Linger",
        "--value",
        check=False,
    ).stdout.strip()
    if linger != "yes":
        print(
            f"Persistent startup needs an administrator: sudo loginctl enable-linger {getpass.getuser()}",
            file=sys.stderr,
        )
    if args.tailscale:
        for port, target, port_state in port_states:
            if port_state == "ours":
                print(
                    f"Existing private Serve handler on {port} already points to this service."
                )
                continue
            served = run(
                "tailscale", "serve", "--bg", f"--https={port}", target, check=False
            )
            if served.returncode:
                print(served.stderr.strip() or served.stdout.strip(), file=sys.stderr)
                raise RuntimeError(
                    f"Service installed; Tailscale needs operator permission or Serve approval. An administrator can run: sudo tailscale set --operator={getpass.getuser()}"
                )
            print(served.stdout.strip())
    if linger != "yes":
        raise RuntimeError(
            "Service is running, but boot/logout persistence is not configured yet."
        )


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError) as error:
        print(f"lattice deployment: {error}", file=sys.stderr)
        sys.exit(1)
