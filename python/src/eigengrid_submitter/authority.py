"""Head-signed, short-lived transport capabilities, independently checked at the UID boundary.

The wire signature covers literal bytes (domain + compact ordered ASCII JSON),
not a cross-language approximation of canonical scientific JSON. OpenSSL is the
system crypto provider; this module has no pip dependency or private key.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import subprocess
import tempfile
from contextlib import ExitStack
from dataclasses import dataclass
from types import MappingProxyType
from typing import Callable, Mapping

DOMAIN = b"eigengrid.submitter-capability/v1\n"
ACCOUNTING_DOMAIN = b"eigengrid.submitter-capability/v2\n"
FIELDS = (
    "version",
    "action",
    "requestId",
    "subject",
    "projectId",
    "uid",
    "gid",
    "recoveryEpoch",
    "membershipGeneration",
    "siteProfileDigest",
    "operationId",
    "requestDigest",
    "admissionDigest",
    "bindingDigest",
    "bodyDigest",
    "fencingGeneration",
    "notBeforeMs",
    "expiresAtMs",
)
MAX_BODY_BYTES = 512 * 1024
MAX_WIRE_BYTES = 720 * 1024
IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}\Z", re.ASCII)
DIGEST = re.compile(r"[a-f0-9]{64}\Z", re.ASCII)


class AuthorityError(ValueError):
    """No effect is authorized; do not expose raw requests or keys in errors."""


def _pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise AuthorityError("Duplicate JSON field")
        result[key] = value
    return result


def strict_json(raw: bytes):
    try:
        return json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=_pairs,
            parse_constant=lambda _: (_ for _ in ()).throw(ValueError()),
        )
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise AuthorityError("Invalid JSON") from exc


def compact_json(value) -> bytes:
    return json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(",", ":")).encode()


def _base64(value, maximum: int) -> bytes:
    if not isinstance(value, str) or len(value) > ((maximum + 2) // 3) * 4:
        raise AuthorityError("Invalid bounded base64")
    try:
        decoded = base64.b64decode(value, validate=True)
    except ValueError as exc:
        raise AuthorityError("Invalid bounded base64") from exc
    if len(decoded) > maximum or base64.b64encode(decoded).decode() != value:
        raise AuthorityError("Noncanonical base64")
    return decoded


def verify_ed25519(public_key_hex: str, message: bytes, signature: bytes) -> None:
    # Require the Ed25519 SPKI algorithm, not an arbitrary PEM/key algorithm.
    if not isinstance(public_key_hex, str) or not DIGEST.fullmatch(public_key_hex):
        raise AuthorityError("Invalid provisioned public key")
    if len(signature) != 64:
        raise AuthorityError("Invalid signature length")
    key = bytes.fromhex("302a300506032b6570032100" + public_key_hex)
    with ExitStack() as stack:
        descriptors = []
        for data in (key, message, signature):
            # Anonymous, seekable descriptors; no named credential/request files.
            # TemporaryFile uses O_TMPFILE or exclusive-create/unlink. A fixed
            # directory avoids environment-controlled TMPDIR. No private key is present.
            stream = stack.enter_context(tempfile.TemporaryFile(dir="/tmp"))
            stream.write(data)
            stream.flush()
            stream.seek(0)
            descriptors.append(stream.fileno())
        key_fd, message_fd, signature_fd = descriptors
        try:
            result = subprocess.run(
                [
                    "/usr/bin/openssl",
                    "pkeyutl",
                    "-verify",
                    "-rawin",
                    "-pubin",
                    "-keyform",
                    "DER",
                    "-inkey",
                    f"/proc/self/fd/{key_fd}",
                    "-in",
                    f"/proc/self/fd/{message_fd}",
                    "-sigfile",
                    f"/proc/self/fd/{signature_fd}",
                ],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                pass_fds=tuple(descriptors),
                timeout=2,
                check=False,
                env={"PATH": "/usr/bin:/bin", "LC_ALL": "C", "OPENSSL_CONF": "/dev/null"},
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise AuthorityError("Signature verification unavailable") from exc
        if result.returncode != 0:
            raise AuthorityError("Invalid Head signature")


@dataclass(frozen=True)
class SubmitterPolicy:
    uid: int
    gid: int
    head_uid: int
    recovery_epoch: str
    site_profile_digest: str
    public_key_hex: str
    # Exact (human identity, project) -> current membership generation.
    memberships: Mapping[tuple[str, str], int]

    def __post_init__(self):
        object.__setattr__(self, "memberships", MappingProxyType(dict(self.memberships)))
        for value in (self.uid, self.gid, self.head_uid):
            if type(value) is not int or not 0 < value < 4_294_967_295:
                raise AuthorityError("Invalid provisioned UID/GID")
        if (
            self.uid == self.head_uid
            or not isinstance(self.recovery_epoch, str)
            or not IDENTIFIER.fullmatch(self.recovery_epoch)
        ):
            raise AuthorityError("Head and submitter identities must be separate")
        if (
            not isinstance(self.site_profile_digest, str)
            or not DIGEST.fullmatch(self.site_profile_digest)
            or not isinstance(self.public_key_hex, str)
            or not DIGEST.fullmatch(self.public_key_hex)
        ):
            raise AuthorityError("Invalid provisioned digest/key")
        for (subject, project), generation in self.memberships.items():
            if (
                not isinstance(subject, str)
                or not IDENTIFIER.fullmatch(subject)
                or not isinstance(project, str)
                or not IDENTIFIER.fullmatch(project)
                or type(generation) is not int
                or not 0 < generation <= 2**53 - 1
            ):
                raise AuthorityError("Invalid provisioned membership")


@dataclass(frozen=True)
class VerifiedRequest:
    capability: dict
    body: bytes

    @property
    def identity(self) -> dict:
        # Expiration, RPC nonce, action and recovery epoch do NOT reset a consumed effect.
        return {
            key: self.capability[key]
            for key in FIELDS
            if key
            not in {
                "version",
                "action",
                "requestId",
                "notBeforeMs",
                "expiresAtMs",
                "recoveryEpoch",
                "membershipGeneration",
            }
        }


def authenticate_request(
    raw: bytes, policy: SubmitterPolicy, now_ms: int | Callable[[], int]
) -> VerifiedRequest:
    if len(raw) > MAX_WIRE_BYTES:
        raise AuthorityError("Request too large")
    envelope = strict_json(raw)
    if not isinstance(envelope, dict) or set(envelope) != {"payload", "signature", "body"}:
        raise AuthorityError("Invalid signed envelope")
    payload = _base64(envelope["payload"], 8192)
    signature = _base64(envelope["signature"], 64)
    body = _base64(envelope["body"], MAX_BODY_BYTES)
    if not body:
        raise AuthorityError("Empty request body")
    capability = strict_json(payload)
    if not isinstance(capability, dict) or set(capability) != set(FIELDS):
        raise AuthorityError("Invalid capability fields")
    if compact_json({key: capability[key] for key in FIELDS}) != payload:
        raise AuthorityError("Noncanonical capability encoding")
    version, action = capability["version"], capability["action"]
    if version == "eigengrid.submitter-capability/v1" and action in ("submit", "observe"):
        domain = DOMAIN
    elif version == "eigengrid.submitter-capability/v2" and action == "accounting":
        domain = ACCOUNTING_DOMAIN
    else:
        raise AuthorityError("Invalid capability version")
    verify_ed25519(policy.public_key_hex, domain + payload, signature)
    for key in ("requestId", "subject", "projectId", "recoveryEpoch", "operationId"):
        if not isinstance(capability[key], str) or not IDENTIFIER.fullmatch(capability[key]):
            raise AuthorityError("Invalid capability identifier")
    for key in (
        "siteProfileDigest",
        "requestDigest",
        "admissionDigest",
        "bindingDigest",
        "bodyDigest",
    ):
        if not isinstance(capability[key], str) or not DIGEST.fullmatch(capability[key]):
            raise AuthorityError("Invalid capability digest")
    for key in (
        "uid",
        "gid",
        "membershipGeneration",
        "fencingGeneration",
        "notBeforeMs",
        "expiresAtMs",
    ):
        if type(capability[key]) is not int or not 0 < capability[key] <= 2**53 - 1:
            raise AuthorityError("Invalid capability integer")
    start, end = capability["notBeforeMs"], capability["expiresAtMs"]
    # Evaluate a live clock AFTER the bounded crypto subprocess; its runtime
    # must not extend a capability that expires while verification is pending.
    now_ms = now_ms() if callable(now_ms) else now_ms
    if type(now_ms) is not int or not 0 < end - start <= 60_000 or not start <= now_ms < end:
        raise AuthorityError("Capability outside its dispatch window")
    if (
        capability["uid"] != policy.uid
        or capability["gid"] != policy.gid
        or capability["recoveryEpoch"] != policy.recovery_epoch
        or capability["siteProfileDigest"] != policy.site_profile_digest
        or policy.memberships.get((capability["subject"], capability["projectId"]))
        != capability["membershipGeneration"]
    ):
        raise AuthorityError("Capability differs from current identity/project/epoch authority")
    if hashlib.sha256(body).hexdigest() != capability["bodyDigest"]:
        raise AuthorityError("Capability body digest mismatch")
    return VerifiedRequest(capability, body)
