"""Two-phase child protocol. A prepared child cannot submit before journal fsync.

Only the protected, hash-pinned backend is launched, with one read-only launch
descriptor. The journal, listener, peer socket and service environment are NOT
inherited. One process group is retained until cleanup, even after leader exit.
"""

from __future__ import annotations

import base64
import os
import pwd
import selectors
import signal
import struct
import subprocess
import time

from .authority import MAX_WIRE_BYTES, AuthorityError, VerifiedRequest, compact_json, strict_json
from .site import verify_backend_binary, verify_launch_descriptor

PREPARE_SECONDS = 20
EFFECT_SECONDS = 25
MAX_RESPONSE_BYTES = 64 * 1024


class _BackendProcess:
    def __init__(self, process: subprocess.Popen):
        self.process = process
        self.closed = False
        assert process.stdin is not None and process.stdout is not None
        self.input_fd, self.output_fd = process.stdin.fileno(), process.stdout.fileno()
        os.set_blocking(self.input_fd, False)
        os.set_blocking(self.output_fd, False)

    @staticmethod
    def _wait(fd: int, event: int, deadline: float):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("Backend exchange deadline exceeded")
        with selectors.DefaultSelector() as selector:
            selector.register(fd, event)
            if not selector.select(remaining):
                raise TimeoutError("Backend exchange deadline exceeded")

    def send(self, value: dict, deadline: float):
        data = compact_json(value)
        if not 0 < len(data) <= MAX_WIRE_BYTES:
            raise AuthorityError("Backend request exceeds its bound")
        remaining = memoryview(struct.pack("!I", len(data)) + data)
        while remaining:
            self._wait(self.input_fd, selectors.EVENT_WRITE, deadline)
            try:
                count = os.write(self.input_fd, remaining[:65536])
            except BlockingIOError:
                continue
            if count <= 0:
                raise AuthorityError("Backend pipe closed before request")
            remaining = remaining[count:]

    def _read(self, size: int, deadline: float) -> bytes:
        while True:
            self._wait(self.output_fd, selectors.EVENT_READ, deadline)
            try:
                return os.read(self.output_fd, size)
            except BlockingIOError:
                continue

    def _exact(self, size: int, deadline: float) -> bytes:
        result = bytearray()
        while len(result) < size:
            part = self._read(size - len(result), deadline)
            if not part:
                raise AuthorityError("Backend response is incomplete")
            result.extend(part)
        return bytes(result)

    def receive(self, deadline: float) -> dict:
        length = struct.unpack("!I", self._exact(4, deadline))[0]
        if not 0 < length <= MAX_RESPONSE_BYTES:
            raise AuthorityError("Backend response exceeds its bound")
        raw = self._exact(length, deadline)
        value = strict_json(raw)
        if not isinstance(value, dict) or compact_json(value) != raw:
            raise AuthorityError("Backend response is not exact JSON")
        return value

    def finish(self, deadline: float):
        if self._read(1, deadline):
            raise AuthorityError("Unexpected bytes after backend result")
        # Do not reap the leader before killing any descendants. Retaining its
        # PID prevents a recycled PID/group from being targeted during cleanup.
        while os.waitid(os.P_PID, self.process.pid, os.WEXITED | os.WNOWAIT | os.WNOHANG) is None:
            if time.monotonic() >= deadline:
                raise TimeoutError("Backend did not exit after its result")
            time.sleep(0.01)
        self.close()
        if self.process.returncode != 0:
            raise AuthorityError("Backend exited unsuccessfully after its result")

    def close(self):
        if self.closed:
            return
        self.closed = True
        try:
            os.killpg(self.process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        else:
            time.sleep(0.05)
        try:
            # Also terminate children that ignore TERM, after their parent exits.
            os.killpg(self.process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        finally:
            self.process.stdin.close()
            self.process.stdout.close()
            self.process.wait(timeout=2)


class ProtectedSlurmBackend:
    def __init__(self, config: dict, launch_fd: int):
        verify_launch_descriptor(launch_fd, config)
        self.config = dict(config)
        self.launch_fd = os.dup(launch_fd)
        os.set_inheritable(self.launch_fd, False)
        self._pending: dict[object, tuple[_BackendProcess, str, str]] = {}

    def _launch(self, *, check_only=False) -> _BackendProcess:
        if self.launch_fd < 0:
            raise AuthorityError("Protected backend is closed")
        verify_launch_descriptor(self.launch_fd, self.config)
        verify_backend_binary(self.config)
        arguments = [
            self.config["backendExecutable"],
            "--service-config",
            self.config["configPath"],
            "--launch-fd",
            str(self.launch_fd),
        ]
        if check_only:
            arguments.append("--check-only")
        # Bun's os.userInfo() uses USER for its name. Resolve the real kernel UID
        # through the OS account database; never inherit a caller's identity env
        # or accept identity fields from the request. The child independently
        # checks UID/GID and its root-provisioned profile/home ownership.
        identity = pwd.getpwuid(os.getuid())
        process = subprocess.Popen(
            arguments,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            # The check-only child accepts no request and emits a fixed startup-stage label.
            stderr=None if check_only else subprocess.DEVNULL,
            bufsize=0,
            close_fds=True,
            pass_fds=(self.launch_fd,),
            start_new_session=True,
            cwd="/",
            env={
                "PATH": "/usr/bin:/bin",
                "LC_ALL": "C",
                "TZ": "UTC",
                "BUN_JSC_useJIT": "0",
                "HOME": identity.pw_dir,
                "USER": identity.pw_name,
                "LOGNAME": identity.pw_name,
            },
        )
        return _BackendProcess(process)

    def check(self, site_profile_digest: str):
        child = self._launch(check_only=True)
        try:
            child.process.stdin.close()
            deadline = time.monotonic() + PREPARE_SECONDS
            expected = {
                "status": "site_ready",
                "uid": self.config["uid"],
                "gid": self.config["gid"],
                "siteProfileDigest": site_profile_digest,
            }
            if child.receive(deadline) != expected:
                raise AuthorityError("Protected backend site preflight failed")
            child.finish(deadline)
        finally:
            child.close()

    def prepare(self, request: VerifiedRequest):
        child = self._launch()
        try:
            deadline = time.monotonic() + PREPARE_SECONDS
            child.send(
                {"capability": request.capability, "body": base64.b64encode(request.body).decode()},
                deadline,
            )
            operation = request.capability["operationId"]
            if child.receive(deadline) != {"status": "prepared", "operationId": operation}:
                raise AuthorityError("Backend did not prepare the exact operation")
            token = object()
            self._pending[token] = child, request.capability["action"], operation
            return token
        except BaseException:
            child.close()
            raise

    def _effect(self, token, action: str) -> dict:
        record = self._pending.pop(token, None)  # consume before writing any effect frame
        if record is None:
            raise AuthorityError("Backend preparation is not live")
        child, expected, _operation = record
        try:
            if action != expected:
                raise AuthorityError("Backend action differs from prepared authority")
            deadline = time.monotonic() + EFFECT_SECONDS
            child.send({"action": action}, deadline)
            child.process.stdin.close()  # EOF is part of the one-command protocol
            response = child.receive(deadline)
            if (
                set(response) != {"status", "result"}
                or response["status"] != "result"
                or not isinstance(response["result"], dict)
            ):
                raise AuthorityError("Invalid backend result")
            child.finish(deadline)
            return response["result"]
        finally:
            child.close()

    def submit(self, prepared) -> dict:
        return self._effect(prepared, "submit")

    def observe(self, prepared) -> dict:
        return self._effect(prepared, "observe")

    def accounting(self, prepared) -> dict:
        return self._effect(prepared, "accounting")

    def release(self, prepared):
        record = self._pending.pop(prepared, None)
        if record is not None:
            record[0].close()

    def close(self):
        try:
            for token in list(self._pending):
                self.release(token)
        finally:
            if self.launch_fd >= 0:
                os.close(self.launch_fd)
                self.launch_fd = -1
