#!/usr/bin/env python3
"""Private PostgreSQL/custom-dump + immutable EigenGrid CAS backup.

Connection strings are read only from the named environment variable, never argv
or the manifest. CAS roots contain sha256/<first-two>/<digest>. Published objects
must remain immutable; in-progress sha256/.staging files are excluded. A dump is
created first, then all published objects are copied and verified. CAS references
in the frozen dump must exist in the copy before the backup is published.
"""
import argparse
import ctypes
import ctypes.util
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

DIGEST = re.compile(r"^[a-f0-9]{64}$")
CAS_REFERENCE = re.compile(rb"cas://sha256/([a-f0-9]{64})")
SCHEMA = "eigengrid.postgres-cas-backup/v1"


class BackupError(Exception):
    pass


def safe_path(value, *, exists=True):
    path = Path(value)
    if not path.is_absolute() or path != path.resolve() or path == Path("/"):
        raise BackupError("Paths must be absolute canonical paths without symlinks")
    if exists and not path.is_dir():
        raise BackupError("Expected an existing directory")
    return path


def database_env(name):
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name) or not os.environ.get(name):
        raise BackupError("The database environment variable is missing or invalid")
    value = os.environ[name]
    env = os.environ.copy()
    # libpq does not expand connection strings read from PGDATABASE itself.
    # Parse using libpq's own grammar and pass each option through its documented
    # environment variable, keeping credentials out of process argument lists.
    if value.startswith(("postgres://", "postgresql://")) or "=" in value:
        class Option(ctypes.Structure):
            _fields_ = [(field, ctypes.c_char_p) for field in
                        ("keyword", "envvar", "compiled", "val", "label", "dispchar")] + [("dispsize", ctypes.c_int)]
        try:
            lib = ctypes.CDLL(ctypes.util.find_library("pq") or "libpq.so")
            lib.PQconninfoParse.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_char_p)]
            lib.PQconninfoParse.restype = ctypes.POINTER(Option)
            lib.PQconninfoFree.argtypes = [ctypes.POINTER(Option)]
            lib.PQfreemem.argtypes = [ctypes.c_void_p]
            error = ctypes.c_char_p()
            options = lib.PQconninfoParse(value.encode(), ctypes.byref(error))
            if not options:
                if error:
                    lib.PQfreemem(error)
                raise BackupError("Invalid PostgreSQL connection configuration")
            try:
                index = 0
                while options[index].keyword:
                    option = options[index]
                    if option.val is not None:
                        if not option.envvar:
                            raise BackupError("Connection option has no secure environment representation")
                        env[option.envvar.decode()] = option.val.decode()
                    index += 1
            finally:
                lib.PQconninfoFree(options)
        except (OSError, AttributeError, UnicodeError):
            raise BackupError("libpq is required to parse PostgreSQL connection configuration") from None
    else:
        env["PGDATABASE"] = value
    return env


def run(command, *, env=None, stdin=None, stdout=None, postgres_os_user=None):
    if postgres_os_user:
        if os.geteuid() != 0 or not re.fullmatch(r"[a-z_][a-z0-9_-]*", postgres_os_user):
            raise BackupError("PostgreSQL OS user switching requires root and a valid OS user")
        preserved = ",".join(key for key in (env or {}) if re.fullmatch(r"PG[A-Z_]+", key))
        command = ["sudo", "-n", "-u", postgres_os_user, "--preserve-env=" + preserved, "--", *command]
    try:
        return subprocess.run(command, env=env, stdin=stdin if stdin is not None else subprocess.DEVNULL,
                              stdout=stdout if stdout is not None else subprocess.PIPE, stderr=subprocess.PIPE,
                              check=True, timeout=3600).stdout
    except (OSError, subprocess.SubprocessError):
        # libpq errors can contain credentials/DSNs. Deliberately omit stderr.
        raise BackupError(f"{command[0]} failed; inspect private PostgreSQL logs") from None


def fingerprint(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise BackupError("Backup objects must be regular files")
        digest = hashlib.sha256()
        size = 0
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
            size += len(block)
    return {"sha256": digest.hexdigest(), "sizeBytes": size}


def copy_cas(source, target):
    namespace = source / "sha256"
    if not namespace.exists():
        raise BackupError("CAS root must contain a sha256 directory")
    safe_path(namespace)
    for shard in sorted(namespace.iterdir()):
        if shard.name == ".staging":
            continue
        if not re.fullmatch(r"[a-f0-9]{2}", shard.name) or shard.is_symlink() or not shard.is_dir():
            raise BackupError("Unexpected CAS shard or symlink")
        for obj in sorted(shard.iterdir()):
            if not DIGEST.fullmatch(obj.name) or not obj.name.startswith(shard.name):
                raise BackupError("Unexpected CAS object name")
            before = fingerprint(obj)
            if before["sha256"] != obj.name:
                raise BackupError("CAS source digest mismatch")
            destination = target / "sha256" / shard.name / obj.name
            destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            # Read from a bound descriptor; do not follow substituted symlinks.
            fd = os.open(obj, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, "rb") as reader, destination.open("xb") as writer:
                if not stat.S_ISREG(os.fstat(reader.fileno()).st_mode):
                    raise BackupError("CAS object is no longer a regular file")
                shutil.copyfileobj(reader, writer, 1024 * 1024)
                writer.flush()
                os.fsync(writer.fileno())
            destination.chmod(0o600)
            if fingerprint(destination) != before:
                raise BackupError("CAS object changed while copying")


def dump_references(dump):
    """Scan the frozen COPY/SQL data without connecting or buffering the database."""
    try:
        process = subprocess.Popen(["pg_restore", "--data-only", "--no-owner", "--no-privileges",
                                    "--file=-", str(dump)], stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    except OSError:
        raise BackupError("pg_restore is unavailable") from None
    found, tail = set(), b""
    try:
        while True:
            block = process.stdout.read(1024 * 1024)
            if not block:
                break
            data = tail + block
            found.update(match.decode("ascii") for match in CAS_REFERENCE.findall(data))
            tail = data[-100:]
        if process.wait(timeout=3600) != 0:
            raise BackupError("pg_restore could not read the frozen database data")
    finally:
        process.stdout.close()
        if process.poll() is None:
            process.kill()
            process.wait()
    return found


def inventory(root):
    result = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise BackupError("Backup contains a symlink")
        if path.is_file() and path != root / "manifest.json":
            result[path.relative_to(root).as_posix()] = fingerprint(path)
        elif not path.is_file() and not path.is_dir():
            raise BackupError("Backup contains a special file")
    return result


def verify(backup):
    backup = safe_path(backup)
    manifest_path = backup / "manifest.json"
    if manifest_path.is_symlink():
        raise BackupError("Manifest must not be a symlink")
    try:
        manifest = json.loads(manifest_path.read_text())
    except (OSError, ValueError):
        raise BackupError("Backup manifest is unreadable") from None
    if manifest.get("schemaVersion") != SCHEMA or manifest.get("files") != inventory(backup):
        raise BackupError("Backup manifest integrity check failed")
    if "database.dump" not in manifest["files"]:
        raise BackupError("Backup has no database dump")
    objects = set()
    for path, metadata in manifest["files"].items():
        parts = Path(path).parts
        if parts[0] == "cas":
            if (len(parts) != 5 or parts[2] != "sha256" or not DIGEST.fullmatch(parts[-1])
                    or parts[-2] != parts[-1][:2] or metadata["sha256"] != parts[-1]):
                raise BackupError("Backup CAS layout or object digest is invalid")
            objects.add(parts[-1])
        elif path != "database.dump":
            raise BackupError("Unexpected file in backup")
    run(["pg_restore", "--list", str(backup / "database.dump")])
    references = dump_references(backup / "database.dump")
    if not references.issubset(objects):
        raise BackupError("Frozen database references missing CAS objects")
    return {"files": len(manifest["files"]), "casObjects": len(objects),
            "referencedCasObjects": len(references), "restoreExecuted": False}


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def create_backup(output, artifact_roots, env, postgres_os_user=None):
    output = safe_path(output, exists=False)
    roots = [safe_path(root) for root in artifact_roots]
    if output.exists() or not output.parent.is_dir():
        raise BackupError("Output must be a new directory beneath an existing parent")
    if any(root == output or root in output.parents or output in root.parents for root in roots):
        raise BackupError("Backup output and CAS roots must not overlap")
    staging = Path(tempfile.mkdtemp(prefix=".eigengrid-backup-", dir=output.parent))
    try:
        with (staging / "database.dump").open("xb") as dump:
            run(["pg_dump", "--format=custom", "--no-password"], env=env, stdout=dump, postgres_os_user=postgres_os_user)
            dump.flush()
            os.fsync(dump.fileno())
        (staging / "database.dump").chmod(0o600)
        for index, root in enumerate(roots):
            copy_cas(root, staging / "cas" / str(index))
        manifest = {"schemaVersion": SCHEMA, "createdAt": datetime.now(timezone.utc).isoformat(),
                    "databaseFormat": "postgresql-custom", "artifactRootCount": len(roots),
                    "files": inventory(staging)}
        with (staging / "manifest.json").open("x") as stream:
            stream.write(json.dumps(manifest, indent=2) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        (staging / "manifest.json").chmod(0o600)
        result = verify(staging)
        if output.exists():
            raise BackupError("Backup output appeared while staging")
        # Persist directory entries before publication, then persist the rename.
        for directory in sorted((p for p in staging.rglob("*") if p.is_dir()), key=lambda p: len(p.parts), reverse=True):
            sync_directory(directory)
        sync_directory(staging)
        staging.rename(output)
        sync_directory(output.parent)
        return result
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def restore_verify(backup, env, postgres_os_user=None):
    """Explicitly restore only into an empty, disposable verification database."""
    result = verify(backup)
    identity = run(["psql", "-X", "--no-password", "-At", "-c", "SELECT current_database()"], env=env, postgres_os_user=postgres_os_user).decode().strip()
    if not re.fullmatch(r"eigengrid_restore_[a-z0-9_]+", identity):
        raise BackupError("Restore verification requires a disposable eigengrid_restore_* database")
    count = run(["psql", "-X", "--no-password", "-At", "-c",
                 "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
                 "WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'"], env=env, postgres_os_user=postgres_os_user)
    if count.strip() != b"0":
        raise BackupError("Restore verification database must be empty")
    with (Path(backup) / "database.dump").open("rb") as dump:
        run(["pg_restore", "--no-password", "--exit-on-error", "--single-transaction", "--no-owner",
             "--no-privileges", "--dbname="], env=env, stdin=dump, postgres_os_user=postgres_os_user)
    result["restoreExecuted"] = True
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    create = commands.add_parser("create")
    create.add_argument("--database-env", default="DATABASE_URL")
    create.add_argument("--postgres-os-user", help="Root only: run database commands as this OS user via sudo -n; CAS remains readable only by the backup operator")
    create.add_argument("--output", required=True)
    create.add_argument("--artifact-root", action="append", required=True)
    check = commands.add_parser("verify")
    check.add_argument("--backup", required=True)
    restore = commands.add_parser("verify-restore")
    restore.add_argument("--backup", required=True)
    restore.add_argument("--postgres-os-user")
    restore.add_argument("--database-env", required=True)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        if args.action == "create":
            result = create_backup(args.output, args.artifact_root, database_env(args.database_env), args.postgres_os_user)
        elif args.action == "verify":
            result = verify(args.backup)
        else:
            result = restore_verify(args.backup, database_env(args.database_env), args.postgres_os_user)
        print(json.dumps({"ok": True, **result}))
        return 0
    except (BackupError, OSError, ValueError, TypeError) as error:
        # OSError filenames and unexpected subprocess errors can expose DSNs.
        message = str(error) if isinstance(error, BackupError) else "Backup filesystem or manifest operation failed"
        print(json.dumps({"ok": False, "error": message}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
