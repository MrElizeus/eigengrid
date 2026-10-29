"""Append-only transport claims, never a second mission/attempt state machine.

The caller supplies an ALREADY OPEN root-owned descriptor from systemd OpenFile=.
There is deliberately no create, path-opening, truncation, repair or reset API.
Losing/corrupting this journal closes dispatch until operator reconciliation.
"""

from __future__ import annotations

import fcntl
import hashlib
import os
import stat

from .authority import DIGEST, IDENTIFIER, compact_json, strict_json

MAX_JOURNAL_BYTES = 128 * 1024 * 1024
MAX_RECORD_BYTES = 64 * 1024
ZERO = "0" * 64


class JournalError(RuntimeError):
    """Fatal dispatch fence: restart/repair must not replay an uncertain effect."""


def bootstrap_record(journal_id: str, uid: int) -> bytes:
    """Provisioning bytes only. An administrator must create/fsync the file and directory."""
    if not IDENTIFIER.fullmatch(journal_id) or type(uid) is not int or not 0 < uid < 2**32 - 1:
        raise JournalError("Invalid journal bootstrap identity")
    material = {
        "version": "eigengrid.submitter-journal/v1",
        "sequence": 0,
        "previous": ZERO,
        "kind": "bootstrap",
        "value": {"journalId": journal_id, "uid": uid},
    }
    return (
        compact_json({**material, "digest": hashlib.sha256(compact_json(material)).hexdigest()})
        + b"\n"
    )


class TransportJournal:
    def __init__(self, fd: int, journal_id: str, uid: int, *, owner_uid: int = 0):
        self.fd = os.dup(fd)
        os.set_inheritable(self.fd, False)
        self.poisoned = False
        self.claims: dict[str, dict] = {}
        self.receipts: dict[str, dict] = {}
        self.sequence = -1
        self.digest = ZERO
        self.size = 0
        self.journal_id, self.uid = journal_id, uid
        try:
            info = os.fstat(self.fd)
            flags = fcntl.fcntl(self.fd, fcntl.F_GETFL)
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_uid != owner_uid
                or info.st_nlink != 1
                or stat.S_IMODE(info.st_mode) != 0o600
                or info.st_size > MAX_JOURNAL_BYTES
                or not flags & os.O_APPEND
                or flags & os.O_ACCMODE != os.O_RDWR
            ):
                raise JournalError("Journal descriptor lacks protected append-only provisioning")
            fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            os.lseek(self.fd, 0, os.SEEK_SET)
            with os.fdopen(os.dup(self.fd), "rb") as stream:
                while line := stream.readline(MAX_RECORD_BYTES + 1):
                    if len(line) > MAX_RECORD_BYTES or not line.endswith(b"\n"):
                        raise JournalError(
                            "Journal has a partial/oversized record; no automatic repair"
                        )
                    self._replay(line)
                    self.size += len(line)
            if self.sequence < 0:
                raise JournalError("Empty journal is not a newly authorized gateway")
        except BaseException:
            self.close()
            raise

    def close(self):
        if self.fd >= 0:
            os.close(self.fd)
            self.fd = -1

    def _replay(self, line: bytes):
        try:
            record = strict_json(line)
            if not isinstance(record, dict) or set(record) != {
                "version",
                "sequence",
                "previous",
                "kind",
                "value",
                "digest",
            }:
                raise ValueError()
            material = {
                key: record[key] for key in ("version", "sequence", "previous", "kind", "value")
            }
            if (
                record["version"] != "eigengrid.submitter-journal/v1"
                or type(record["sequence"]) is not int
                or record["sequence"] != self.sequence + 1
                or record["previous"] != self.digest
                or record["digest"] != hashlib.sha256(compact_json(material)).hexdigest()
                or compact_json(record) + b"\n" != line
            ):
                raise ValueError()
            kind, value = record["kind"], record["value"]
            if record["sequence"] == 0:
                if kind != "bootstrap" or value != {"journalId": self.journal_id, "uid": self.uid}:
                    raise ValueError()
            elif kind == "claim":
                self._validate_claim(value)
                operation = value["operationId"]
                if operation in self.claims:
                    raise ValueError()
                self.claims[operation] = value
            elif kind == "receipt":
                self._validate_receipt(value)
                operation = value["operationId"]
                if operation not in self.claims or operation in self.receipts:
                    raise ValueError()
                self.receipts[operation] = value
            else:
                raise ValueError()
            self.sequence, self.digest = record["sequence"], record["digest"]
        except (ValueError, KeyError, TypeError) as exc:
            raise JournalError("Journal integrity/sequence violation; dispatch closed") from exc

    def _validate_claim(self, identity):
        if not isinstance(identity, dict) or set(identity) != {
            "subject",
            "projectId",
            "uid",
            "gid",
            "siteProfileDigest",
            "operationId",
            "requestDigest",
            "admissionDigest",
            "bindingDigest",
            "bodyDigest",
            "fencingGeneration",
        }:
            raise JournalError("Invalid transport claim")
        for key in ("subject", "projectId", "operationId"):
            if not isinstance(identity[key], str) or not IDENTIFIER.fullmatch(identity[key]):
                raise JournalError("Invalid transport claim identifier")
        for key in (
            "siteProfileDigest",
            "requestDigest",
            "admissionDigest",
            "bindingDigest",
            "bodyDigest",
        ):
            if not isinstance(identity[key], str) or not DIGEST.fullmatch(identity[key]):
                raise JournalError("Invalid transport claim digest")
        for key in ("uid", "gid", "fencingGeneration"):
            if type(identity[key]) is not int or not 0 < identity[key] <= 2**53 - 1:
                raise JournalError("Invalid transport claim integer")
        if identity["uid"] != self.uid:
            raise JournalError("Claim belongs to another UID")

    @staticmethod
    def _validate_receipt(value):
        if not isinstance(value, dict) or set(value) != {"operationId", "result"}:
            raise JournalError("Invalid transport receipt")
        if not isinstance(value["operationId"], str) or not IDENTIFIER.fullmatch(
            value["operationId"]
        ):
            raise JournalError("Invalid receipt operation identifier")
        result = value["result"]
        if not isinstance(result, dict) or result.get("resubmitAllowed") is not False:
            raise JournalError("Receipt must forbid resubmission")
        if result.get("status") == "acknowledged":
            if (
                set(result) != {"status", "resubmitAllowed", "jobId", "cluster"}
                or not isinstance(result["jobId"], str)
                or not result["jobId"].isascii()
                or not result["jobId"].isdigit()
                or not 0 < int(result["jobId"]) < 2**32
                or str(int(result["jobId"])) != result["jobId"]
                or not isinstance(result["cluster"], str)
                or not IDENTIFIER.fullmatch(result["cluster"])
            ):
                raise JournalError("Invalid allocation acknowledgement")
        elif result.get("status") == "indeterminate":
            if set(result) != {"status", "resubmitAllowed"}:
                raise JournalError("Invalid indeterminate receipt")
        else:
            raise JournalError("Receipt is transport acknowledgement, not execution success")

    def _append(self, kind: str, value: dict):
        if self.poisoned or self.fd < 0:
            raise JournalError("Journal is closed/poisoned")
        material = {
            "version": "eigengrid.submitter-journal/v1",
            "sequence": self.sequence + 1,
            "previous": self.digest,
            "kind": kind,
            "value": value,
        }
        line = (
            compact_json({**material, "digest": hashlib.sha256(compact_json(material)).hexdigest()})
            + b"\n"
        )
        if len(line) > MAX_RECORD_BYTES or self.size + len(line) > MAX_JOURNAL_BYTES:
            raise JournalError("Journal capacity exhausted; dispatch closed")
        try:
            # Detect external shrink/append and fail closed. The file is never user writable.
            if os.fstat(self.fd).st_size != self.size:
                raise JournalError("Journal changed outside its exclusive writer")
            remaining = memoryview(line)
            while remaining:
                count = os.write(self.fd, remaining)
                if count <= 0:
                    raise OSError("Short journal write")
                remaining = remaining[count:]
            os.fsync(self.fd)
            self._replay(line)
            self.size += len(line)
        except BaseException:
            self.poisoned = True
            raise

    def claim(self, identity: dict) -> bool:
        if self.poisoned or self.fd < 0:
            raise JournalError("Journal is closed/poisoned")
        self._validate_claim(identity)
        operation = identity["operationId"]
        if operation in self.claims:
            if self.claims[operation] != identity:
                raise JournalError("Consumed operation cannot be rebound, even to a newer fence")
            return False
        self._append("claim", dict(identity))
        return True

    def receipt(self, operation_id: str, result: dict):
        value = {"operationId": operation_id, "result": result}
        self._validate_receipt(value)
        if operation_id not in self.claims or operation_id in self.receipts:
            raise JournalError("Receipt requires one consumed claim and cannot be replaced")
        self._append("receipt", value)
