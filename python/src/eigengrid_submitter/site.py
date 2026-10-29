"""Root-provisioned service identity/policy. No values come from a browser RPC.

Policy is read on EVERY boundary callback; epochs and membership generations
live outside restored PostgreSQL. Changing scientific policy/key/profile must
rotate its epoch as part of controlled site provisioning, never by a runner.
"""

from __future__ import annotations

import ctypes
import fcntl
import hashlib
import json
import os
import resource
import stat
from pathlib import Path

from .authority import DIGEST, IDENTIFIER, AuthorityError, SubmitterPolicy, strict_json

CONFIG_FIELDS = {
    "schemaVersion",
    "configPath",
    "uid",
    "gid",
    "headUid",
    "appArmorProfile",
    "socketPath",
    "journalPath",
    "journalId",
    "launchAuthorityPath",
    "launchAuthorityDevice",
    "launchAuthorityInode",
    "launchAuthoritySha256",
    "backendExecutable",
    "backendSha256",
    "siteProfilePath",
    "policyPath",
}
POLICY_FIELDS = {
    "schemaVersion",
    "uid",
    "gid",
    "headUid",
    "recoveryEpoch",
    "siteProfileDigest",
    "currentPolicyDigest",
    "publicKeyHex",
    "memberships",
}


def protected_path(path: str):
    if (
        not isinstance(path, str)
        or not path.startswith("/")
        or path == "/"
        or os.path.normpath(path) != path
        or len(path) > 1024
        or any(ord(c) < 32 or ord(c) == 127 for c in path)
    ):
        raise AuthorityError("Invalid protected site path")
    current = Path("/")
    for part in Path(path).parts[1:]:
        current /= part
        info = current.lstat()
        if info.st_uid != 0 or stat.S_ISLNK(info.st_mode) or info.st_mode & 0o022:
            raise AuthorityError("Site path is writable or redirected by another identity")


def protected_json(path: str) -> dict:
    protected_path(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= 256 * 1024:
            raise AuthorityError("Invalid bounded site configuration")
        raw = bytearray()
        while len(raw) < before.st_size:
            part = os.read(fd, before.st_size - len(raw))
            if not part:
                raise AuthorityError("Truncated site configuration")
            raw.extend(part)
        after = os.fstat(fd)
        if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
            after.st_size,
            after.st_mtime_ns,
            after.st_ctime_ns,
        ):
            raise AuthorityError("Site configuration changed while being read")
        result = strict_json(bytes(raw))
        if not isinstance(result, dict):
            raise AuthorityError("Site configuration must be a closed object")
        if (
            json.dumps(
                result, sort_keys=True, ensure_ascii=False, allow_nan=False, separators=(",", ":")
            ).encode()
            != raw
        ):
            raise AuthorityError("Site configuration must have canonical JSON encoding")
        return result
    finally:
        os.close(fd)


def load_service_config(path: str) -> dict:
    value = protected_json(path)
    if (
        set(value) != CONFIG_FIELDS
        or value["schemaVersion"] != "eigengrid.submitter-service/v1"
        or value["configPath"] != path
    ):
        raise AuthorityError("Invalid closed submitter service configuration")
    for key in ("uid", "gid", "headUid"):
        if type(value[key]) is not int or not 0 < value[key] < 2**32 - 1:
            raise AuthorityError("Invalid service identity")
    if value["uid"] == value["headUid"] or value["launchAuthorityPath"] == value["journalPath"]:
        raise AuthorityError("Service identities/descriptors must be separate")
    for key in ("launchAuthoritySha256", "backendSha256"):
        if not isinstance(value[key], str) or not DIGEST.fullmatch(value[key]):
            raise AuthorityError("Invalid service binary/launch hash")
    for key in ("launchAuthorityDevice", "launchAuthorityInode"):
        item = value[key]
        if (
            not isinstance(item, str)
            or not item.isascii()
            or not item.isdigit()
            or len(item) > 20
            or str(int(item)) != item
        ):
            raise AuthorityError("Invalid launch device/inode")
    if not isinstance(value["journalId"], str) or not IDENTIFIER.fullmatch(value["journalId"]):
        raise AuthorityError("Invalid journal identity")
    name = value["appArmorProfile"]
    if (
        not isinstance(name, str)
        or not name.startswith("eigengrid-submitter-")
        or not 1 <= len(name.removeprefix("eigengrid-submitter-")) <= 64
        or any(c not in "abcdefghijklmnopqrstuvwxyz0123456789-" for c in name)
    ):
        raise AuthorityError("Invalid mandatory AppArmor profile")
    for key in (
        "socketPath",
        "journalPath",
        "launchAuthorityPath",
        "backendExecutable",
        "siteProfilePath",
        "policyPath",
    ):
        item = value[key]
        if (
            not isinstance(item, str)
            or not item.startswith("/")
            or item == "/"
            or os.path.normpath(item) != item
            or len(item) > 1024
            or any(ord(c) < 32 or ord(c) == 127 for c in item)
        ):
            raise AuthorityError("Invalid configured service path")
    return value


def current_policy(config: dict) -> SubmitterPolicy:
    # A running service may not silently keep an old launcher/profile after a
    # root configuration replacement. Upgrade requires a controlled restart.
    if load_service_config(config["configPath"]) != config:
        raise AuthorityError("Service configuration changed; restart/reconcile required")
    value = protected_json(config["policyPath"])
    if (
        set(value) != POLICY_FIELDS
        or value["schemaVersion"] != "eigengrid.submitter-site-policy/v1"
    ):
        raise AuthorityError("Invalid closed site policy")
    if any(value[key] != config[key] for key in ("uid", "gid", "headUid")):
        raise AuthorityError("Site policy belongs to another service identity")
    if not isinstance(value["currentPolicyDigest"], str) or not DIGEST.fullmatch(
        value["currentPolicyDigest"]
    ):
        raise AuthorityError("Invalid scientific policy digest")
    entries = value["memberships"]
    if not isinstance(entries, list) or len(entries) > 128:
        raise AuthorityError("Invalid site memberships")
    memberships = {}
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) != {"subject", "projectId", "generation"}:
            raise AuthorityError("Invalid membership fields")
        subject, project = entry["subject"], entry["projectId"]
        if not isinstance(subject, str) or not isinstance(project, str):
            raise AuthorityError("Invalid membership identity")
        key = (subject, project)
        if key in memberships:
            raise AuthorityError("Duplicate site membership")
        memberships[key] = entry["generation"]
    return SubmitterPolicy(
        uid=value["uid"],
        gid=value["gid"],
        head_uid=value["headUid"],
        recovery_epoch=value["recoveryEpoch"],
        site_profile_digest=value["siteProfileDigest"],
        public_key_hex=value["publicKeyHex"],
        memberships=memberships,
    )


def verify_launch_descriptor(fd: int, config: dict):
    info = os.fstat(fd)
    flags = fcntl.fcntl(fd, fcntl.F_GETFL)
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_uid != 0
        or info.st_nlink != 1
        or stat.S_IMODE(info.st_mode) != 0o600
        or flags & os.O_ACCMODE != os.O_RDONLY
        or str(info.st_dev) != config["launchAuthorityDevice"]
        or str(info.st_ino) != config["launchAuthorityInode"]
        or not 0 < info.st_size <= 4096
    ):
        raise AuthorityError("Missing protected backend launch descriptor")
    raw = os.pread(fd, info.st_size + 1, 0)
    if (
        len(raw) != info.st_size
        or hashlib.sha256(raw).hexdigest() != config["launchAuthoritySha256"]
    ):
        raise AuthorityError("Backend launch descriptor differs from provisioning")
    os.set_inheritable(fd, False)


def verify_backend_binary(config: dict):
    path = config["backendExecutable"]
    protected_path(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        before = os.fstat(fd)
        if (
            not stat.S_ISREG(before.st_mode)
            or not before.st_mode & 0o111
            or not 0 < before.st_size <= 256 * 1024 * 1024
        ):
            raise AuthorityError("Invalid protected backend executable")
        digest = hashlib.sha256()
        count = 0
        while chunk := os.read(fd, 1024 * 1024):
            count += len(chunk)
            if count > before.st_size:
                raise AuthorityError("Backend executable grew during verification")
            digest.update(chunk)
        after = os.fstat(fd)
        if (
            count != before.st_size
            or digest.hexdigest() != config["backendSha256"]
            or (before.st_size, before.st_mtime_ns, before.st_ctime_ns)
            != (after.st_size, after.st_mtime_ns, after.st_ctime_ns)
        ):
            raise AuthorityError("Backend executable differs from provisioned release")
    finally:
        os.close(fd)


def assert_ptrace_scope(value: bytes):
    if value not in (b"1\n", b"2\n", b"3\n"):
        raise AuthorityError("Submitter requires restricted kernel ptrace scope")


def verify_kernel_ptrace_scope():
    # systemd read-only binds the LIVE host sysctl here (ProcSubset=pid hides
    # /proc/sys). This is not a cached file. Never change the host's sysctl.
    path = "/run/eigengrid-submitters/kernel-ptrace-scope"
    protected_path(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise AuthorityError("Kernel isolation binding is not protected")
        assert_ptrace_scope(os.read(fd, 8))
    finally:
        os.close(fd)


def confine_service(config: dict):
    if (
        os.getuid() != config["uid"]
        or os.geteuid() != config["uid"]
        or os.getgid() != config["gid"]
        or os.getegid() != config["gid"]
    ):
        raise AuthorityError("Submitter is not its configured scientific UID/GID")
    if (
        Path("/proc/self/attr/current").read_text().strip()
        != config["appArmorProfile"] + " (enforce)"
    ):
        raise AuthorityError("Submitter AppArmor must be active from exec")
    # AppArmor readby/tracedby is NOT a barrier against unconfined tracers.
    # Real-UID services are systemd children, not children of scientific shells.
    # Yama protects exec intervals, when exec resets the non-dumpable setting.
    verify_kernel_ptrace_scope()
    libc = ctypes.CDLL(None, use_errno=True)
    libc.prctl.argtypes = [
        ctypes.c_int,
        ctypes.c_ulong,
        ctypes.c_ulong,
        ctypes.c_ulong,
        ctypes.c_ulong,
    ]
    libc.prctl.restype = ctypes.c_int
    # Both operations are permitted unprivileged. No capability or sudo is used.
    if libc.prctl(4, 0, 0, 0, 0) != 0 or libc.prctl(3, 0, 0, 0, 0) != 0:
        raise AuthorityError("Cannot disable submitter dumpability")
    if libc.prctl(38, 1, 0, 0, 0) != 0 or libc.prctl(39, 0, 0, 0, 0) != 1:
        raise AuthorityError("Cannot lock no-new-privileges")
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    status = Path("/proc/self/status").read_text()
    effective = next(
        (line.split()[1] for line in status.splitlines() if line.startswith("CapEff:")), "missing"
    )
    if effective != "0000000000000000":
        raise AuthorityError("Submitter must not retain capabilities")
