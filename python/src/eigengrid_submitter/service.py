"""systemd-only per-UID submitter. No socket creation or journal reset endpoint."""

from __future__ import annotations

import os
import pwd
import signal
import socket
import stat
import sys
import traceback
from pathlib import Path

from .authority import AuthorityError
from .backend import ProtectedSlurmBackend
from .boundary import SubmitterBoundary, send_frame
from .journal import JournalError, TransportJournal
from .site import (
    confine_service,
    current_policy,
    load_service_config,
    protected_path,
    verify_kernel_ptrace_scope,
)


def activation_descriptors() -> dict[str, int]:
    names = os.environ.get("LISTEN_FDNAMES", "").split(":")
    if (
        os.environ.get("LISTEN_PID") != str(os.getpid())
        or os.environ.get("LISTEN_FDS") != "3"
        or len(names) != 3
        or set(names) != {"submission", "journal", "launch-authority"}
    ):
        raise AuthorityError("Exactly the named systemd descriptors are required")
    descriptors = {name: 3 + index for index, name in enumerate(names)}
    for fd in descriptors.values():
        os.set_inheritable(fd, False)
    for name in ("LISTEN_PID", "LISTEN_FDS", "LISTEN_FDNAMES"):
        os.environ.pop(name, None)
    return descriptors


def submission_listener(fd: int, config: dict) -> socket.socket:
    path = config["socketPath"]
    protected_path(str(Path(path).parent))
    info = os.lstat(path)
    head_gid = pwd.getpwuid(config["headUid"]).pw_gid
    if (
        not stat.S_ISSOCK(info.st_mode)
        or info.st_uid != 0
        or info.st_gid != head_gid
        or stat.S_IMODE(info.st_mode) != 0o660
        or info.st_nlink != 1
    ):
        raise AuthorityError("Submission socket lacks protected Head-only provisioning")
    listener = socket.socket(fileno=fd)
    try:
        if (
            listener.family != socket.AF_UNIX
            or listener.type != socket.SOCK_STREAM
            or listener.getsockname() != path
            or listener.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN) != 1
        ):
            raise AuthorityError("Inherited descriptor is not the provisioned listener")
        listener.settimeout(1)
        return listener
    except BaseException:
        listener.close()
        raise


def run_service(config_path: str) -> int:
    config = load_service_config(config_path)
    confine_service(config)
    descriptors = activation_descriptors()
    journal = backend = listener = None
    try:
        journal = TransportJournal(descriptors["journal"], config["journalId"], config["uid"])
        backend = ProtectedSlurmBackend(config, descriptors["launch-authority"])
        listener = submission_listener(descriptors["submission"], config)
        descriptors.pop("submission")  # socket object now owns this descriptor
        for fd in descriptors.values():
            os.close(fd)
        descriptors.clear()
        policy = current_policy(config)  # fail startup if fresh site authority is unavailable
        backend.check(policy.site_profile_digest)  # root FD, profile and binaries; NO effect

        def live_policy():
            verify_kernel_ptrace_scope()
            return current_policy(config)

        boundary = SubmitterBoundary(journal, live_policy, backend)
        stopping = False

        def stop(_signum, _frame):
            nonlocal stopping
            stopping = True

        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        print("eigengrid submitter ready (canonical capabilities only)", flush=True)
        while not stopping:
            try:
                connection, _address = listener.accept()
            except TimeoutError:
                continue
            with connection:
                try:
                    boundary.serve_one(connection)
                except Exception as error:
                    # No requests, paths, commands or key material in logs/wire.
                    fatal = isinstance(error, JournalError) or journal.poisoned
                    print(
                        "eigengrid submitter dispatch fenced"
                        if fatal
                        else "eigengrid submitter request rejected",
                        flush=True,
                    )
                    try:
                        send_frame(connection, {"status": "rejected", "resubmitAllowed": False})
                    except (OSError, TimeoutError):
                        pass
                    if fatal:
                        return 78  # requires explicit reconciliation, not an automatic restart
        return 0
    finally:
        if backend is not None:
            backend.close()
        if journal is not None:
            journal.close()
        if listener is not None:
            listener.close()
        for fd in descriptors.values():
            try:
                os.close(fd)
            except OSError:
                pass


def main() -> int:
    if len(sys.argv) != 3 or sys.argv[1] != "--service-config":
        print("eigengrid submitter requires root service configuration", file=sys.stderr)
        return 78
    try:
        return run_service(sys.argv[2])
    except Exception as error:
        # Log code locations only: exception messages may include request or key bytes.
        frames = traceback.extract_tb(error.__traceback__)
        locations = ",".join(f"{frame.name}:{frame.lineno}" for frame in frames[-6:])
        print(
            f"eigengrid submitter startup/transport fenced ({type(error).__name__}; {locations})",
            file=sys.stderr,
        )
        return 78


if __name__ == "__main__":
    raise SystemExit(main())
