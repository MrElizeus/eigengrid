"""One authenticated RPC per Unix connection, one consumed claim per logical effect.

The application backend must validate a typed scientific request in prepare(),
then use the narrow Slurm transport in submit()/observe(). No generic commands,
script upload, subprocess path or database API is exposed by this boundary.
"""

from __future__ import annotations

import socket
import struct
import threading
import time
from typing import Callable, Protocol

from .authority import (
    MAX_WIRE_BYTES,
    AuthorityError,
    SubmitterPolicy,
    VerifiedRequest,
    authenticate_request,
    compact_json,
)
from .journal import JournalError, TransportJournal


class SubmitterBackend(Protocol):
    def prepare(self, request: VerifiedRequest): ...
    def submit(self, prepared) -> dict: ...
    def observe(self, prepared) -> dict: ...
    def accounting(self, prepared) -> dict: ...
    def release(self, prepared) -> None: ...


def receive_frame(connection: socket.socket) -> bytes:
    deadline = time.monotonic() + 5

    def exact(length):
        result = bytearray()
        while len(result) < length:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Frame deadline exceeded")
            connection.settimeout(remaining)
            part = connection.recv(length - len(result))
            if not part:
                raise AuthorityError("Truncated request frame")
            result.extend(part)
        return bytes(result)

    length = struct.unpack("!I", exact(4))[0]
    if not 0 < length <= MAX_WIRE_BYTES:
        raise AuthorityError("Invalid request frame size")
    return exact(length)


def send_frame(connection: socket.socket, value: dict):
    data = compact_json(value)
    if len(data) > 64 * 1024:
        raise JournalError("Response exceeds transport bound")
    connection.settimeout(5)
    connection.sendall(struct.pack("!I", len(data)) + data)


class SubmitterBoundary:
    def __init__(
        self,
        journal: TransportJournal,
        policy: Callable[[], SubmitterPolicy],
        backend: SubmitterBackend,
        now_ms: Callable[[], int] | None = None,
    ):
        self.journal, self.policy, self.backend = journal, policy, backend
        self.now_ms = now_ms or (lambda: time.time_ns() // 1_000_000)
        self._request_lock = threading.Lock()

    def handle(self, raw: bytes, peer_uid: int) -> dict:
        with self._request_lock:
            return self._handle(raw, peer_uid)

    def _handle(self, raw: bytes, peer_uid: int) -> dict:
        policy = self.policy()  # Fresh, root-provisioned authority; not restored DB/session state.
        if peer_uid != policy.head_uid:
            raise AuthorityError("Caller is not the provisioned Head UID")
        request = authenticate_request(raw, policy, self.now_ms)
        prepared = self.backend.prepare(request)
        try:
            return self._finish_prepared(raw, request, prepared)
        finally:
            # Includes duplicate delivery, revoked authority, failed journal
            # fsync, observation without claim and loss of backend ACK.
            self.backend.release(prepared)

    def _finish_prepared(self, raw: bytes, request: VerifiedRequest, prepared) -> dict:
        # Preparation may perform I/O; recheck revocation/expiry before consuming the effect.
        current = authenticate_request(raw, self.policy(), self.now_ms)
        if current != request:
            raise AuthorityError("Authority changed during preparation")
        operation = request.capability["operationId"]
        if request.capability["action"] == "accounting":
            if self.journal.claims.get(operation) != request.identity:
                raise AuthorityError("Accounting has no exact previously consumed claim")
            result = self.backend.accounting(prepared)
            # A read may outlive its authority; do not disclose stale/revoked results.
            if authenticate_request(raw, self.policy(), self.now_ms) != request:
                raise AuthorityError("Authority changed during accounting")
            if (
                not isinstance(result, dict)
                or set(result) != {"observation", "accounting"}
                or not isinstance(result["observation"], dict)
                or (result["accounting"] is not None and not isinstance(result["accounting"], dict))
            ):
                raise AuthorityError("Invalid closed accounting result")
            response = {
                "version": "eigengrid.submitter-response/v2",
                "status": "accounting",
                "operationId": operation,
                "resubmitAllowed": False,
                **result,
            }
            if len(compact_json(response)) > 64 * 1024:
                raise AuthorityError("Accounting response exceeds transport bound")
            return response
        if request.capability["action"] == "observe":
            if self.journal.claims.get(operation) != request.identity:
                raise AuthorityError("Observation has no exact previously consumed claim")
            return {
                "status": "observation",
                "operationId": operation,
                "resubmitAllowed": False,
                "observation": self.backend.observe(prepared),
            }
        fresh = self.journal.claim(request.identity)  # append + fsync BEFORE any submission
        if not fresh:
            return {
                "status": "already_consumed",
                "operationId": operation,
                "resubmitAllowed": False,
                "receipt": self.journal.receipts.get(operation, {}).get("result"),
                "requiresReconciliation": True,
            }
        try:
            # A slow fsync must not extend the signed capability's lifetime.
            authenticate_request(raw, self.policy(), self.now_ms)
            result = self.backend.submit(prepared)
            TransportJournal._validate_receipt({"operationId": operation, "result": result})
        except Exception:
            # Any post-claim error is uncertain. Never put exception text, paths or secrets on wire.
            result = {"status": "indeterminate", "resubmitAllowed": False}
        self.journal.receipt(
            operation, result
        )  # Lost ACK here is still fenced by the durable claim.
        return {
            "status": "consumed",
            "operationId": operation,
            "resubmitAllowed": False,
            "receipt": result,
            "requiresReconciliation": True,
        }

    def serve_one(self, connection: socket.socket):
        if connection.family != socket.AF_UNIX or connection.type != socket.SOCK_STREAM:
            raise AuthorityError("Only local Unix stream sockets are supported")
        credentials = connection.getsockopt(
            socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")
        )
        pid, uid, _gid = struct.unpack("3i", credentials)
        # Authenticate before reading any caller-controlled data, even from a socketpair.
        if pid <= 0 or uid != self.policy().head_uid:
            raise AuthorityError("Caller is not the provisioned Head UID")
        response = self.handle(receive_frame(connection), uid)
        send_frame(connection, response)
