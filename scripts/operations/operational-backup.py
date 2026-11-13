#!/usr/bin/env python3
"""Wrap a strict PG/CAS backup and bounded private agent journal copies.

Online captures are NOT atomic across PG and journals. Restore into quarantine;
never automatically resume restored sessions or retry uncertain effects.
"""
import argparse
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

SCHEMA = "eigengrid.operational-backup/v1"
MAX_FILES = 10000
MAX_FILE_BYTES = 16 * 1024 * 1024
MAX_JOURNAL_BYTES = 64 * 1024 * 1024
CONSISTENCY = {"database": "independent-pg-snapshot-with-verified-cas-references",
               "journals": "stable-files-online-best-effort",
               "crossComponentAtomic": False,
               "resumePolicy": "quarantine-and-manual-reconciliation-only"}


def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def private_directory(path):
    path = Path(path)
    if not path.is_absolute() or path.resolve(strict=True) != path:
        raise ValueError("canonical private directory required")
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError("backup directory requires owner-only permissions")
    return path


def component(command, directory, extra=()):
    script = Path(__file__).with_name("production-backup.py")
    subprocess.run(["/usr/bin/python3", str(script), command,
                    "--output" if command == "create" else "--backup", str(directory), *extra],
                   check=True, stdout=subprocess.DEVNULL)


def inventory(root):
    result = []
    for parent, dirs, files, directory_fd in os.fwalk(root, follow_symlinks=False):
        for name in dirs:
            info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            if not stat.S_ISDIR(info.st_mode):
                raise ValueError("symlink or non-directory in backup")
        for name in files:
            path = Path(parent) / name
            relative = path.relative_to(root).as_posix()
            if relative == "operational-manifest.json":
                continue
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
            try:
                before = os.fstat(fd)
                if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
                    raise ValueError("backup members must be regular single-link files")
                digest = hashlib.sha256()
                size = 0
                while chunk := os.read(fd, 1024 * 1024):
                    size += len(chunk)
                    digest.update(chunk)
                after = os.fstat(fd)
                if (before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns, before.st_nlink) != (after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns, after.st_nlink) or size != before.st_size:
                    raise ValueError("backup member changed during verification")
                result.append({"path": relative, "sizeBytes": size, "sha256": digest.hexdigest()})
            finally:
                os.close(fd)
    return sorted(result, key=lambda item: item["path"])


def copy_journals(source, destination):
    source = Path(source)
    if not source.is_absolute() or source.resolve(strict=True) != source:
        raise ValueError("journal root must be canonical and cannot be a symlink")
    destination.mkdir(mode=0o700)
    count = total = 0
    started = utc()
    for parent, dirs, files, directory_fd in os.fwalk(source, follow_symlinks=False):
        relative = Path(parent).relative_to(source)
        if len(relative.parts) > 3:
            raise ValueError("journal inventory exceeds depth bound")
        target = destination / relative
        for name in dirs:
            info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            if not re.fullmatch(r"[A-Za-z0-9_.-]+", name) or not stat.S_ISDIR(info.st_mode):
                raise ValueError("unsafe journal directory")
            (target / name).mkdir(mode=0o700)
        for name in files:
            if not re.fullmatch(r"[A-Za-z0-9_.-]+", name):
                raise ValueError("unsafe journal filename")
            count += 1
            if count > MAX_FILES:
                raise ValueError("journal file-count bound exceeded")
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
            try:
                before = os.fstat(fd)
                if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > MAX_FILE_BYTES:
                    raise ValueError("journal requires a bounded regular single-link file")
                data = bytearray()
                while chunk := os.read(fd, min(1024 * 1024, MAX_FILE_BYTES - len(data) + 1)):
                    data.extend(chunk)
                    if len(data) > MAX_FILE_BYTES:
                        raise ValueError("journal file grew beyond its bound")
                after = os.fstat(fd)
                if (before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns, before.st_nlink) != (after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns, after.st_nlink) or len(data) != before.st_size:
                    raise ValueError("journal changed during capture; retry capture after coordinating activity")
                total += len(data)
                if total > MAX_JOURNAL_BYTES:
                    raise ValueError("journal byte bound exceeded")
                output = os.open(target / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                with os.fdopen(output, "wb") as stream:
                    stream.write(data)
                    stream.flush()
                    os.fsync(stream.fileno())
            finally:
                os.close(fd)
        sync_dir(target)
    return {"fileCount": count, "sizeBytes": total, "startedAt": started, "finishedAt": utc()}


def verify(root):
    root = private_directory(root)
    path = root / "operational-manifest.json"
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 16 * 1024 * 1024:
        raise ValueError("invalid operational manifest")
    manifest = json.loads(path.read_text())
    if set(manifest) != {"schemaVersion", "startedAt", "finishedAt", "consistency", "databaseDirectory", "journals", "files"} or manifest["schemaVersion"] != SCHEMA or manifest["consistency"] != CONSISTENCY or manifest["databaseDirectory"] != "database":
        raise ValueError("unexpected operational manifest schema or recovery policy")
    if manifest["files"] != inventory(root):
        raise ValueError("operational inventory digest, size or membership mismatch")
    if not isinstance(manifest["journals"], dict) or not manifest["journals"]:
        raise ValueError("journal inventory required")
    for label, entry in manifest["journals"].items():
        if not re.fullmatch(r"[a-z][a-z0-9-]{0,63}", label) or set(entry) != {"fileCount", "sizeBytes", "startedAt", "finishedAt"}:
            raise ValueError("invalid journal inventory")
        files = [item for item in manifest["files"] if item["path"].startswith(f"journals/{label}/")]
        if len(files) != entry["fileCount"] or sum(item["sizeBytes"] for item in files) != entry["sizeBytes"] or len(files) > MAX_FILES or entry["sizeBytes"] > MAX_JOURNAL_BYTES:
            raise ValueError("journal inventory count mismatch")
    for item in manifest["files"]:
        parts = Path(item["path"]).parts
        if parts[0] == "database":
            continue
        if len(parts) < 3 or parts[0] != "journals" or parts[1] not in manifest["journals"] or item["sizeBytes"] > MAX_FILE_BYTES:
            raise ValueError("unbound operational member or oversized journal")
    component("verify", root / "database")
    return {"verified": True, "files": len(manifest["files"]), "crossComponentAtomic": False,
            "resumePolicy": CONSISTENCY["resumePolicy"]}


def publish_no_replace(source, destination):
    libc = ctypes.CDLL(None, use_errno=True)
    rename = libc.renameat2
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(-100, os.fsencode(source), -100, os.fsencode(destination), 1) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def create(output, journals, database_arguments):
    output = Path(output)
    parent = private_directory(output.parent)
    if output.exists() or output.is_symlink():
        raise FileExistsError("operational snapshot already exists")
    temporary = Path(tempfile.mkdtemp(prefix=".operational-", dir=parent))
    try:
        started = utc()
        component("create", temporary / "database", database_arguments)
        (temporary / "journals").mkdir(mode=0o700)
        entries = {}
        for label, source in journals.items():
            if not re.fullmatch(r"[a-z][a-z0-9-]{0,63}", label):
                raise ValueError("invalid journal label")
            entries[label] = copy_journals(source, temporary / "journals" / label)
        if not entries:
            raise ValueError("at least one journal root is required")
        manifest = {"schemaVersion": SCHEMA, "startedAt": started, "finishedAt": utc(),
                    "consistency": CONSISTENCY, "databaseDirectory": "database", "journals": entries,
                    "files": inventory(temporary)}
        fd = os.open(temporary / "operational-manifest.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as stream:
            json.dump(manifest, stream, sort_keys=True)
            stream.flush()
            os.fsync(stream.fileno())
        verify(temporary)
        sync_dir(temporary / "journals")
        sync_dir(temporary)
        # Atomic no-overwrite publication. Parent is private and held by the operator.
        if output.exists() or output.is_symlink():
            raise FileExistsError("operational snapshot already exists")
        publish_no_replace(temporary, output)
        sync_dir(parent)
        return verify(output)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    c = commands.add_parser("create")
    c.add_argument("--output", type=Path, required=True)
    c.add_argument("--artifact-root", type=Path, action="append", required=True)
    c.add_argument("--database-env", required=True)
    c.add_argument("--postgres-os-user")
    c.add_argument("--journal-root", action="append", required=True, help="label=canonical-directory")
    v = commands.add_parser("verify")
    v.add_argument("--backup", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == "verify":
            result = verify(args.backup)
        else:
            journals = {}
            for item in args.journal_root:
                label, source = item.split("=", 1)
                if label in journals:
                    raise ValueError("duplicate journal root label")
                journals[label] = source
            extra = ["--database-env", args.database_env]
            for artifact_root in args.artifact_root:
                extra.extend(["--artifact-root", str(artifact_root)])
            if args.postgres_os_user:
                extra.extend(["--postgres-os-user", args.postgres_os_user])
            result = create(args.output, journals, extra)
        print(json.dumps(result))
    except Exception:
        # Environment/libpq/provider exceptions must not expose connection secrets.
        raise SystemExit("operational backup failed; inspect protected operator diagnostics") from None


if __name__ == "__main__":
    main()
