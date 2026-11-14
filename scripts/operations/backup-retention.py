#!/usr/bin/env python3
"""Private inventory and retention dry-run; intentionally has no delete/apply API."""

import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat

INVENTORY = "eigengrid.backup-retention-inventory/v1"
PROOF = "eigengrid.backup-retention-proof/v1"
KINDS = {
    "database": ("production-backup.py", "manifest.json", "verify"),
    "operational": ("operational-backup.py", "operational-manifest.json", "verify"),
    "sidecar": ("recovery-sidecar.py", "sidecar-manifest.json", "semantic_verify"),
}
MAX_ENTRIES = 10000


def instant(value):
    result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if result.tzinfo is None:
        raise ValueError("offset timestamp required")
    return result.astimezone(timezone.utc)


def private_directory(path):
    path = Path(path)
    info = path.lstat()
    if (
        not path.is_absolute()
        or path.resolve(strict=True) != path
        or not stat.S_ISDIR(info.st_mode)
        or info.st_uid != os.geteuid()
        or stat.S_IMODE(info.st_mode) != 0o700
    ):
        raise ValueError("canonical current-operator mode0700 directory required")
    return path


def read_private(path):
    path = Path(path)
    private_directory(path.parent)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "r") as stream:
        info = os.fstat(stream.fileno())
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.geteuid()
            or stat.S_IMODE(info.st_mode) != 0o600
            or info.st_nlink != 1
            or info.st_size > 16 * 1024**2
        ):
            raise ValueError("bounded private metadata required")
        return json.load(stream)


def write_private(path, value):
    path = Path(path)
    private_directory(path.parent)
    body = json.dumps(value, indent=2, allow_nan=False).encode()
    if len(body) > 16 * 1024**2:
        raise ValueError("metadata bound exceeded")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(body)
        stream.flush()
        os.fsync(stream.fileno())


def fingerprint(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            raise ValueError("regular single-link copy required")
        digest = hashlib.sha256()
        count = 0
        while count <= before.st_size:
            chunk = os.read(
                stream.fileno(), min(1024 * 1024, before.st_size - count + 1)
            )
            if not chunk:
                break
            count += len(chunk)
            if count > before.st_size:
                raise ValueError("copy grew during fingerprint")
            digest.update(chunk)
        if count != before.st_size:
            raise ValueError("copy size changed during fingerprint")
        after = os.fstat(stream.fileno())
        named = Path(path).lstat()
        for field in (
            "st_dev",
            "st_ino",
            "st_size",
            "st_mtime_ns",
            "st_ctime_ns",
            "st_nlink",
        ):
            if getattr(before, field) != getattr(after, field) or getattr(
                after, field
            ) != getattr(named, field):
                raise ValueError("copy changed")
        return digest.hexdigest()


def verify_directory(path, kind):
    script, manifest, function = KINDS[kind]
    spec = importlib.util.spec_from_file_location(
        "retention_component", Path(__file__).with_name(script)
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    getattr(module, function)(path)
    return fingerprint(path / manifest)


def allocated_bytes(path):
    total = Path(path).lstat().st_blocks * 512
    count = 0

    def propagate(error):
        raise error

    for parent, dirs, files in os.walk(path, followlinks=False, onerror=propagate):
        for name in dirs + files:
            info = (Path(parent) / name).lstat()
            count += 1
            if (
                count > 100000
                or stat.S_ISLNK(info.st_mode)
                or (
                    not stat.S_ISDIR(info.st_mode)
                    and (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1)
                )
            ):
                raise ValueError("unsafe or oversized tree")
            total += info.st_blocks * 512
    return total


def inventory(root, scope, kind, domain, proofs=None, now=None):
    now = now or datetime.now(timezone.utc)
    root = private_directory(root)
    if (
        kind not in KINDS
        or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,80}", scope)
        or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,80}", domain)
    ):
        raise ValueError("explicit scope/kind/failure domain required")
    if proofs is not None:
        private_directory(proofs)
    paths = []
    for path in root.iterdir():
        if len(paths) >= MAX_ENTRIES:
            raise ValueError("inventory entry bound exceeded")
        paths.append(path)
    paths.sort()
    fs = os.statvfs(root)
    host = hashlib.sha256(Path("/etc/machine-id").read_bytes()).hexdigest()
    storage = f"{host}:{fs.f_fsid}:{root.stat().st_dev}"
    copies = []
    for path in paths:
        info = path.lstat()
        item = dict(
            path=str(path),
            scope=scope,
            kind=kind,
            domain=domain,
            storage=storage,
            inventoryAt=now.isoformat(),
            snapshotAt=None,
            digest=None,
            verified=False,
            proofAt=None,
            allocatedBytesUpperBound=info.st_blocks * 512,
            reason="unknown-or-in-progress",
        )
        copies.append(item)
        name = path.name[:-8] if path.name.endswith(".tar.gpg") else path.name
        try:
            point = datetime.strptime(name, "%Y%m%dT%H%M%SZ").replace(
                tzinfo=timezone.utc
            )
        except ValueError:
            continue
        item["snapshotAt"] = point.isoformat()
        if stat.S_ISLNK(info.st_mode):
            item["reason"] = "symlink-protected"
            continue
        try:
            plain = stat.S_ISDIR(info.st_mode)
            if plain:
                digest = verify_directory(path, kind)
                item["allocatedBytesUpperBound"] = allocated_bytes(path)
            elif stat.S_ISREG(info.st_mode) and path.name.endswith(".tar.gpg"):
                digest = fingerprint(path)
            else:
                continue
            item["reason"] = "no-bound-restore-proof"
            if proofs is None:
                continue
            try:
                proof = read_private(Path(proofs) / (path.name + ".verification.json"))
            except FileNotFoundError:
                continue
            fields = {
                "schemaVersion",
                "scope",
                "kind",
                "snapshot",
                "copySha256",
                "contentSha256",
                "verifiedAt",
                "restoreVerified",
                "recoveryKeyVerified",
            }
            if (
                set(proof) != fields
                or proof["schemaVersion"] != PROOF
                or (
                    proof["scope"],
                    proof["kind"],
                    proof["snapshot"],
                    proof["copySha256"],
                )
                != (scope, kind, path.name, digest)
                or not re.fullmatch("[a-f0-9]{64}", proof["contentSha256"])
                or proof["restoreVerified"] is not True
                or proof["recoveryKeyVerified"] is not True
                or not point <= instant(proof["verifiedAt"]) <= now
                or (plain and proof["contentSha256"] != digest)
            ):
                raise ValueError("proof mismatch")
            item.update(
                digest=proof["contentSha256"],
                verified=True,
                proofAt=proof["verifiedAt"],
                reason="bound-restore-proof",
            )
        except Exception:
            item.update(verified=False, reason="verification-failed-protected")
    return dict(
        schemaVersion=INVENTORY,
        directory=str(root),
        storage=storage,
        copies=copies,
        inventoryAt=now.isoformat(),
        filesystem=dict(
            freeBytes=fs.f_bavail * fs.f_frsize, totalBytes=fs.f_blocks * fs.f_frsize
        ),
    )


def independent_count(copies):
    domains = {}
    matched = {}
    for item in copies:
        domains.setdefault(item["domain"], set()).add(item["storage"])

    def attach(domain, seen):
        for storage in sorted(domains[domain]):
            if storage in seen:
                continue
            seen.add(storage)
            if storage not in matched or attach(matched[storage], seen):
                matched[storage] = domain
                return True
        return False

    return sum(attach(domain, set()) for domain in sorted(domains))


def plan(
    documents, now, keep_days=14, minimum_points=3, minimum_copies=2, incoming_bytes=0
):
    if (
        not 1 <= keep_days <= 3650
        or not 1 <= minimum_points <= 100
        or not 2 <= minimum_copies <= 32
        or incoming_bytes < 0
    ):
        raise ValueError("invalid conservative policy")
    copies = []
    capacity = []
    for document in documents:
        if document.get("schemaVersion") != INVENTORY or not isinstance(
            document.get("copies"), list
        ):
            raise ValueError("invalid inventory")
        if any(
            item.get("inventoryAt") != document["inventoryAt"]
            for item in document["copies"]
        ):
            raise ValueError("inventory timestamp mismatch")
        directory = document.get("directory")
        storage = document.get("storage")
        if (
            not isinstance(directory, str)
            or not Path(directory).is_absolute()
            or os.path.normpath(directory) != directory
            or not isinstance(storage, str)
            or not storage
            or any(item.get("storage") != storage for item in document["copies"])
        ):
            raise ValueError("invalid inventory source identity")
        copies.extend(document["copies"])
        fs = document["filesystem"]
        if (
            type(fs.get("freeBytes")) is not int
            or type(fs.get("totalBytes")) is not int
            or not 0 <= fs["freeBytes"] <= fs["totalBytes"]
            or fs["totalBytes"] <= 0
        ):
            raise ValueError("invalid filesystem capacity metadata")
        remaining = fs["freeBytes"] - incoming_bytes
        observation_fresh = (
            timedelta(0)
            <= now - instant(document["inventoryAt"])
            <= timedelta(hours=24)
        )
        capacity.append(
            dict(
                directory=directory,
                storage=storage,
                inventoryAt=document["inventoryAt"],
                incomingBytes=incoming_bytes,
                remainingBytesProjected=remaining,
                observationFresh=observation_fresh,
                reserveSatisfied=(
                    remaining >= 100 * 1024**3
                    and remaining * 100 >= fs["totalBytes"] * 20
                )
                if observation_fresh
                else None,
            )
        )
    if len(copies) > MAX_ENTRIES:
        raise ValueError("combined entry bound exceeded")
    expected = {
        "path",
        "scope",
        "kind",
        "domain",
        "storage",
        "inventoryAt",
        "snapshotAt",
        "digest",
        "verified",
        "proofAt",
        "allocatedBytesUpperBound",
        "reason",
    }
    valid = set()
    protected = {}
    removed = set()
    seen = set()
    for i, item in enumerate(copies):
        if (
            set(item) != expected
            or item["kind"] not in KINDS
            or not isinstance(item["path"], str)
            or not Path(item["path"]).is_absolute()
            or os.path.normpath(item["path"]) != item["path"]
            or not item["storage"]
            or not item["domain"]
            or not isinstance(item["allocatedBytesUpperBound"], int)
            or item["allocatedBytesUpperBound"] < 0
        ):
            raise ValueError("invalid copy metadata")
        identity = (item["storage"], item["path"])
        if identity in seen:
            raise ValueError("duplicate copy")
        seen.add(identity)
        fresh = lambda value: (
            value is not None
            and timedelta(0) <= now - instant(value) <= timedelta(hours=24)
        )
        if (
            item["verified"] is not True
            or not re.fullmatch("[a-f0-9]{64}", item["digest"] or "")
            or not fresh(item["inventoryAt"])
            or not fresh(item["proofAt"])
            or item["snapshotAt"] is None
            or not instant(item["snapshotAt"]) <= instant(item["proofAt"]) <= now
        ):
            protected[i] = "unverified-stale-or-future"
            continue
        valid.add(i)
    groups = {}
    for i in valid:
        groups.setdefault((copies[i]["scope"], copies[i]["kind"]), []).append(i)
    for indices in groups.values():
        newest = sorted(
            indices,
            key=lambda i: (instant(copies[i]["snapshotAt"]), copies[i]["path"]),
            reverse=True,
        )
        points = []
        for i in newest:
            if copies[i]["digest"] not in points:
                points.append(copies[i]["digest"])
        for i in indices:
            if copies[i]["digest"] in points[:minimum_points]:
                protected[i] = "newest-minimum-restore-points"
            elif now - instant(copies[i]["snapshotAt"]) < timedelta(days=keep_days):
                protected[i] = "inside-retention-window"
    for i in sorted(
        valid,
        key=lambda i: (
            instant(copies[i]["snapshotAt"]),
            copies[i]["path"],
            copies[i]["storage"],
        ),
    ):
        if i in protected:
            continue
        item = copies[i]
        peers = [
            copies[j]
            for j in valid
            if j != i
            and j not in removed
            and (copies[j]["scope"], copies[j]["kind"], copies[j]["digest"])
            == (item["scope"], item["kind"], item["digest"])
        ]
        if independent_count(peers) < minimum_copies:
            protected[i] = "required-independent-copy"
            continue
        removed.add(i)
    describe = lambda i: {
        key: copies[i][key] for key in ("path", "scope", "kind", "storage", "digest")
    }
    return dict(
        schemaVersion="eigengrid.backup-retention-plan/v1",
        dryRun=True,
        applySupported=False,
        requiresFreshVerificationBeforeAnyDeletion=True,
        asOf=now.isoformat(),
        policy=dict(
            keepDays=keep_days,
            minimumRestorePoints=minimum_points,
            minimumIndependentCopies=minimum_copies,
            freshnessHours=24,
        ),
        candidates=[describe(i) for i in sorted(removed)],
        protected=[
            dict(**describe(i), reason=protected.get(i, "protected"))
            for i in range(len(copies))
            if i not in removed
        ],
        reclaimBytesUpperBound=sum(
            copies[i]["allocatedBytesUpperBound"] for i in removed
        ),
        capacity=capacity,
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    inv = commands.add_parser("inventory")
    inv.add_argument("--directory", type=Path, required=True)
    inv.add_argument("--scope", required=True)
    inv.add_argument("--kind", choices=KINDS, required=True)
    inv.add_argument("--failure-domain", required=True)
    inv.add_argument("--proofs", type=Path)
    inv.add_argument("--output", type=Path, required=True)
    p = commands.add_parser("plan")
    p.add_argument("--inventory", type=Path, action="append", required=True)
    p.add_argument("--as-of")
    p.add_argument("--keep-days", type=int, default=14)
    p.add_argument("--minimum-points", type=int, default=3)
    p.add_argument("--minimum-copies", type=int, default=2)
    p.add_argument("--incoming-bytes", type=int, default=0)
    p.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        result = (
            inventory(
                args.directory, args.scope, args.kind, args.failure_domain, args.proofs
            )
            if args.command == "inventory"
            else plan(
                [read_private(path) for path in args.inventory],
                instant(args.as_of) if args.as_of else datetime.now(timezone.utc),
                args.keep_days,
                args.minimum_points,
                args.minimum_copies,
                args.incoming_bytes,
            )
        )
        write_private(args.output, result)
        print(json.dumps(dict(written=True, dryRun=True, applySupported=False)))
    except Exception:
        raise SystemExit(
            "backup inventory/plan failed; private metadata suppressed"
        ) from None


if __name__ == "__main__":
    main()
