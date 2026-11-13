#!/usr/bin/env python3
"""Bounded EigenGrid secret/configuration recovery sidecar; quarantine only.

No service activation, configuration overwrite, network/model call, or scientific
submission is performed. Encrypt this private bundle before persistent storage.
"""
import argparse
import base64
import ctypes
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile

SCHEMA = "eigengrid.recovery-sidecar/v1"
POLICY_SCHEMA = "eigengrid.recovery-sidecar-policy/v1"
MAX_FILES = 512
MAX_FILE = 16 * 1024 * 1024
MAX_TOTAL = 32 * 1024 * 1024
MAX_MANIFEST = 4 * 1024 * 1024
PREFIXES = ("/etc/eigengrid/", "/etc/eigengrid-submitters/", "/etc/eigengrid-backup/",
            "/usr/local/lib/eigengrid-deploy/")


def allowed_source(value):
    if not isinstance(value, str) or not Path(value).is_absolute() or os.path.normpath(value) != value:
        return False
    return (any(value.startswith(prefix) for prefix in PREFIXES)
            or value == "/root/cluster-backup/restic-password"
            or re.fullmatch(r"/(?:etc|run)/systemd/(?:system|system.control)/eigengrid-[\w.@-]+\.(?:service|socket|timer)(?:\.d/[\w.-]+\.conf)?", value)
            or re.fullmatch(r"/etc/apparmor\.d/(?:local/)?eigengrid-[\w.-]+", value)
            or re.fullmatch(r"/home/[A-Za-z0-9_.-]+/\.eigengrid/mission-http(?:-state-[a-f0-9]{16})?\.json(?:\.lock)?", value)
            or re.fullmatch(r"/var/lib/eigengrid-submitters/[0-9]+/(?:launch|journal)", value)
            or re.fullmatch(r"/var/lib/eigengrid-release/v[0-9]+\.[0-9]+\.[0-9]+/(?:activated|installation-plan|release|validation)\.json", value))


def private_directory(path):
    path = Path(path)
    if not path.is_absolute() or path.resolve(strict=True) != path:
        raise ValueError("canonical private directory required")
    m = path.lstat()
    if not stat.S_ISDIR(m.st_mode) or m.st_uid != os.geteuid() or stat.S_IMODE(m.st_mode) != 0o700:
        raise ValueError("directory requires current operator ownership and mode0700")
    return path


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try: os.fsync(fd)
    finally: os.close(fd)


def acl(fd):
    try: value = os.getxattr(fd, "system.posix_acl_access")
    except OSError as error:
        if error.errno not in (61, 95): raise
        return None
    if len(value) > 65536: raise ValueError("ACL exceeds metadata bound")
    return base64.b64encode(value).decode("ascii")


def identity(m):
    return (m.st_dev, m.st_ino, m.st_size, m.st_mtime_ns, m.st_ctime_ns,
            m.st_uid, m.st_gid, m.st_mode, m.st_nlink)


def capture_file(source, destination, expected_uid):
    path = Path(source)
    if not allowed_source(str(path)) or not path.is_absolute() or path.resolve(strict=True) != path:
        raise ValueError("source outside the reviewed EigenGrid namespaces or noncanonical")
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        parent_before = os.fstat(directory)
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        try:
            before = os.fstat(fd)
            named_before = os.stat(path.name, dir_fd=directory, follow_symlinks=False)
            if identity(before) != identity(named_before):
                raise ValueError("source name changed during capture")
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_uid != expected_uid or before.st_mode & 0o022 or before.st_size > MAX_FILE:
                raise ValueError("source must be bounded, single-link, protected and owned as reviewed")
            attributes = acl(fd); count = 0; digest = hashlib.sha256()
            output = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(output, "wb") as stream:
                while chunk := os.read(fd, min(1024 * 1024, MAX_FILE - count + 1)):
                    count += len(chunk)
                    if count > MAX_FILE: raise ValueError("source grew past bound")
                    stream.write(chunk); digest.update(chunk)
                stream.flush(); os.fsync(stream.fileno())
            after = os.fstat(fd)
            named_after = os.stat(path.name, dir_fd=directory, follow_symlinks=False)
            current_parent = path.parent.lstat()
            if identity(before) != identity(after) or identity(after) != identity(named_after) or count != before.st_size or (parent_before.st_dev, parent_before.st_ino) != (current_parent.st_dev, current_parent.st_ino):
                raise ValueError("source changed during capture; preserve existing services and retry coordinated capture")
            return {"sha256": digest.hexdigest(), "sizeBytes": count, "uid": before.st_uid,
                    "gid": before.st_gid, "mode": stat.S_IMODE(before.st_mode), "aclAccessBase64": attributes,
                    "parentMetadata": {"uid": parent_before.st_uid, "gid": parent_before.st_gid,
                                       "mode": stat.S_IMODE(parent_before.st_mode), "aclAccessBase64": acl(directory)}}
        finally: os.close(fd)
    finally: os.close(directory)


def publish(source, destination):
    libc = ctypes.CDLL(None, use_errno=True)
    function = libc.renameat2
    function.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    function.restype = ctypes.c_int
    if function(-100, os.fsencode(source), -100, os.fsencode(destination), 1):
        error = ctypes.get_errno(); raise OSError(error, os.strerror(error))


def create(policy, output):
    if set(policy) != {"schemaVersion", "actors", "files", "metadata"} or policy["schemaVersion"] != POLICY_SCHEMA:
        raise ValueError("invalid sidecar policy")
    actors = policy["actors"]
    if not isinstance(actors, list) or not actors or len(actors) > 32 or len(set(actors)) != len(actors) or not all(isinstance(x, str) and re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", x) for x in actors):
        raise ValueError("invalid reviewed actor list")
    sources = policy["files"]
    if not isinstance(sources, list) or not 1 <= len(sources) <= MAX_FILES:
        raise ValueError("sidecar file-count bound exceeded")
    output = Path(output); parent = private_directory(output.parent)
    if output.exists() or output.is_symlink(): raise FileExistsError("sidecar exists")
    temporary = Path(tempfile.mkdtemp(prefix=".sidecar-", dir=parent))
    try:
        (temporary / "payload").mkdir(mode=0o700); entries = []; seen = set(); total = 0
        for index, item in enumerate(sources):
            if set(item) != {"path", "role", "uid"} or not isinstance(item["uid"], int) or item["uid"] < 0 or not isinstance(item["role"], str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", item["role"]) or item["path"] in seen:
                raise ValueError("invalid or duplicate reviewed source")
            seen.add(item["path"]); relative = f"payload/{index:04d}.bin"
            data = capture_file(item["path"], temporary / relative, item["uid"])
            total += data["sizeBytes"]
            if total > MAX_TOTAL: raise ValueError("sidecar total byte bound exceeded")
            entries.append({"path": relative, "source": item["path"], "role": item["role"], **data})
        manifest = {"schemaVersion": SCHEMA, "capturedAtUTC": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    "crossComponentAtomic": False, "restorePolicy": "quarantine-only-no-service-or-session-activation",
                    "actors": actors, "metadata": policy["metadata"], "files": entries}
        body = json.dumps(manifest, sort_keys=True).encode()
        if len(body) > MAX_MANIFEST: raise ValueError("sidecar manifest bound exceeded")
        fd = os.open(temporary / "sidecar-manifest.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as stream: stream.write(body); stream.flush(); os.fsync(stream.fileno())
        verify(temporary); sync_directory(temporary / "payload"); sync_directory(temporary)
        publish(temporary, output); sync_directory(parent)
        return verify(output)
    finally:
        if temporary.exists(): shutil.rmtree(temporary)


def verify(root):
    root = private_directory(root); manifest_path = root / "sidecar-manifest.json"
    if manifest_path.is_symlink() or manifest_path.stat().st_size > MAX_MANIFEST:
        raise ValueError("invalid sidecar manifest")
    manifest = json.loads(manifest_path.read_text())
    if set(manifest) != {"schemaVersion", "capturedAtUTC", "crossComponentAtomic", "restorePolicy", "actors", "metadata", "files"} or manifest["schemaVersion"] != SCHEMA or manifest["crossComponentAtomic"] is not False or manifest["restorePolicy"] != "quarantine-only-no-service-or-session-activation":
        raise ValueError("invalid sidecar schema or recovery boundary")
    entries = manifest["files"]
    if not isinstance(entries, list) or not 1 <= len(entries) <= MAX_FILES:
        raise ValueError("sidecar file-count bound exceeded")
    expected = {"sidecar-manifest.json"}; total = 0
    for index, entry in enumerate(entries):
        if set(entry) != {"path", "source", "role", "sha256", "sizeBytes", "uid", "gid", "mode", "aclAccessBase64", "parentMetadata"} or entry["path"] != f"payload/{index:04d}.bin" or not allowed_source(entry["source"]):
            raise ValueError("invalid sidecar entry")
        path = root / entry["path"]; fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600 or not 0 <= info.st_size <= MAX_FILE:
                raise ValueError("payload is not a bounded private regular file")
            digest = hashlib.sha256(); size = 0
            while chunk := os.read(fd, min(1024 * 1024, MAX_FILE - size + 1)):
                size += len(chunk)
                if size > MAX_FILE: raise ValueError("payload byte bound exceeded")
                digest.update(chunk)
            if size != entry["sizeBytes"] or digest.hexdigest() != entry["sha256"] or identity(info) != identity(os.fstat(fd)):
                raise ValueError("sidecar digest or stable-size mismatch")
            total += size; expected.add(entry["path"])
        finally: os.close(fd)
    actual = {"sidecar-manifest.json"}
    for parent, dirs, files in os.walk(root, followlinks=False):
        for name in dirs:
            path = Path(parent) / name
            if path.is_symlink() or path.relative_to(root).as_posix() != "payload": raise ValueError("unexpected sidecar directory")
        for name in files: actual.add((Path(parent) / name).relative_to(root).as_posix())
    if total > MAX_TOTAL or actual != expected: raise ValueError("unexpected sidecar membership or byte count")
    return {"verified": True, "files": len(entries), "bytes": total, "crossComponentAtomic": False,
            "restorePolicy": manifest["restorePolicy"]}


def semantic_verify(root):
    result = verify(root); root = Path(root); manifest = json.loads((root / "sidecar-manifest.json").read_text())
    roles = {}
    for item in manifest["files"]:
        if item["role"] in roles: raise ValueError("duplicate semantic role")
        roles[item["role"]] = root / item["path"]
    required = {"production-config", "global-model", "signing-key", "tls-production-cert", "tls-production-key", "restic-pass", "backup-pass"}
    required.update(f"{kind}:{actor}" for actor in manifest["actors"] for kind in ["credential", "client"])
    if not required.issubset(roles): raise ValueError("required functional recovery configuration missing")
    def command(arguments):
        completed = subprocess.run(["/usr/bin/openssl", *arguments], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=True, timeout=10)
        return completed.stdout
    cert = command(["x509", "-in", str(roles["tls-production-cert"]), "-pubkey", "-noout"])
    key = command(["pkey", "-in", str(roles["tls-production-key"]), "-pubout"])
    if cert != key: raise ValueError("TLS certificate/private key mismatch")
    signing_public = command(["pkey", "-in", str(roles["signing-key"]), "-pubout"])
    if not signing_public: raise ValueError("signing key is not parseable")
    model = json.loads(roles["global-model"].read_text())
    if not isinstance(model.get("apiKey"), str) or not model["apiKey"] or not isinstance(model.get("model"), str):
        raise ValueError("global model configuration incomplete")
    configuration = json.loads(roles["production-config"].read_text())
    if not isinstance(configuration, dict): raise ValueError("protected configuration invalid")
    for actor in manifest["actors"]:
        client = json.loads(roles[f"client:{actor}"].read_text()); credential = roles[f"credential:{actor}"].read_text().rstrip("\n")
        if client.get("schemaVersion") != "eigengrid.mission-http-client/v1" or client.get("actorId") != actor or client.get("credential") != credential or not re.fullmatch(r"[A-Za-z0-9_-]{43}", credential) or not client.get("projectId") or not client.get("missionId"):
            raise ValueError("client/actor/credential mismatch")
        if client.get("caCertificate", "").strip() != roles["tls-production-cert"].read_text().strip():
            raise ValueError("client CA does not match recovered TLS certificate")
        operators = configuration.get("operators")
        if not isinstance(operators, list): raise ValueError("protected operators missing")
        matching = [item for item in operators if isinstance(item, dict) and item.get("actorId") == actor]
        if len(matching) != 1:
            raise ValueError("client actor must bind exactly one protected operator")
        operator = matching[0]
        project_ids = operator.get("httpProjectIds")
        if (operator.get("httpCredentialDigest") != hashlib.sha256(credential.encode("utf-8")).hexdigest()
                or not isinstance(project_ids, list) or client["projectId"] not in project_ids):
            raise ValueError("client credential or project does not match protected operator")
    for role in ("restic-pass", "backup-pass"):
        if not roles[role].read_bytes().split(b"\n", 1)[0]: raise ValueError("recovery secret empty")
    return {**result, "clientsVerified": len(manifest["actors"]), "tlsKeyMatchesCertificate": True,
            "signingKeyParseable": True, "globalModelCredentialPresent": True,
            "servicesActivated": False, "outboundModelCalls": False}


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__); commands = parser.add_subparsers(dest="command", required=True)
    c = commands.add_parser("create"); c.add_argument("--policy", type=Path, required=True); c.add_argument("--output", type=Path, required=True)
    v = commands.add_parser("verify"); v.add_argument("--backup", type=Path, required=True); v.add_argument("--semantic", action="store_true")
    args = parser.parse_args()
    try:
        if os.geteuid() != 0: raise ValueError("root operator required")
        if args.command == "create":
            p = args.policy; info = p.lstat()
            if p.resolve(strict=True) != p or not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > MAX_MANIFEST:
                raise ValueError("private root-owned policy required")
            result = create(json.loads(p.read_text()), args.output)
        else: result = semantic_verify(args.backup) if args.semantic else verify(args.backup)
        print(json.dumps(result))
    except Exception:
        raise SystemExit("recovery sidecar operation failed; secrets and source contents suppressed") from None


if __name__ == "__main__": main()
