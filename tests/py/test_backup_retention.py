"""No test or command deletes a backup; exercise conservative dry-run decisions."""

from datetime import datetime, timedelta, timezone
import hashlib
import importlib.util
import json
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location(
    "retention",
    Path(__file__).resolve().parents[2] / "scripts/operations/backup-retention.py",
)
retention = importlib.util.module_from_spec(spec)
spec.loader.exec_module(retention)
NOW = datetime(2026, 11, 14, 12, tzinfo=timezone.utc)


def copy(domain, digest="a" * 64, days=40, suffix="", scope="main", storage=None):
    return dict(
        path=f"/backup/{domain}/{days}{suffix}",
        scope=scope,
        kind="database",
        domain=domain,
        storage=storage or domain,
        inventoryAt=NOW.isoformat(),
        snapshotAt=(NOW - timedelta(days=days)).isoformat(),
        digest=digest,
        verified=True,
        proofAt=NOW.isoformat(),
        allocatedBytesUpperBound=4096,
        reason="bound-restore-proof",
    )


def document(copies):
    return dict(
        schemaVersion=retention.INVENTORY,
        directory="/backup/fixture",
        storage="fixture",
        inventoryAt=NOW.isoformat(),
        copies=copies,
        filesystem=dict(freeBytes=200 * 1024**3, totalBytes=500 * 1024**3),
    )


def run_plan(documents, *args, **kwargs):
    """Expand scenario copies into the separate source inventories used in practice."""
    inputs = []
    for item in documents:
        groups = {}
        for entry in item["copies"]:
            groups.setdefault((entry["domain"], entry["storage"]), []).append(entry)
        if not groups:
            inputs.append(item)
        for (domain, storage), entries in groups.items():
            inputs.append(
                {
                    **item,
                    "directory": f"/backup/{domain}",
                    "storage": storage,
                    "copies": entries,
                }
            )
    return retention.plan(inputs, *args, **kwargs)


def with_newest(copies):
    return document(copies + [copy("head", "b" * 64, days=0, suffix="new")])


def test_old_redundancy_plan_retains_two_independent_copies_and_never_mutates_input():
    data = with_newest([copy(domain) for domain in ["a", "b", "c", "d"]])
    before = json.dumps(data, sort_keys=True)
    result = run_plan([data], NOW, minimum_points=1)
    assert len(result["candidates"]) == 2 and len(result["protected"]) == 3
    assert (
        result["dryRun"]
        and not result["applySupported"]
        and result["requiresFreshVerificationBeforeAnyDeletion"]
    )
    assert json.dumps(data, sort_keys=True) == before
    remaining = [
        item
        for item in data["copies"]
        if item["path"] not in {x["path"] for x in result["candidates"]}
        and item["digest"] == "a" * 64
    ]
    assert retention.independent_count(remaining) == 2


@pytest.mark.parametrize(
    "old",
    [
        [copy("unique")],
        [copy("a"), copy("b")],
        [
            copy("a", storage="shared"),
            copy("b", storage="shared"),
            copy("c", storage="shared"),
        ],
        [copy("a"), copy("b", scope="qualification"), copy("c", scope="qualification")],
    ],
)
def test_unique_two_copy_shared_filesystem_and_cross_scope_cannot_enable_retirement(
    old,
):
    assert run_plan([with_newest(old)], NOW, minimum_points=1)["candidates"] == []


def test_unverified_stale_future_and_mismatched_digest_peers_are_not_counted():
    a, b, c = copy("a"), copy("b"), copy("c")
    b["verified"] = False
    c["proofAt"] = (NOW - timedelta(days=2)).isoformat()
    result = run_plan([with_newest([a, b, c])], NOW, minimum_points=1)
    assert not result["candidates"]
    c["proofAt"] = (NOW + timedelta(seconds=1)).isoformat()
    b["verified"] = True
    b["digest"] = "c" * 64
    assert not run_plan([with_newest([a, b, c])], NOW, minimum_points=1)["candidates"]


def test_minimum_unique_restore_points_and_recent_window_are_protected():
    entries = [
        copy(domain, digest=str(point) * 64, days=point * 10, suffix=str(point))
        for point in range(1, 5)
        for domain in ["a", "b", "c"]
    ]
    result = run_plan([document(entries)], NOW)
    assert len(result["candidates"]) == 1
    assert result["candidates"][0]["digest"] == "4" * 64
    recent = with_newest([copy(domain, days=2) for domain in ["a", "b", "c"]])
    assert not run_plan([recent], NOW, minimum_points=1)["candidates"]


def test_projected_reserve_accounts_for_incoming_bytes_without_claiming_free_space():
    result = run_plan(
        [with_newest([copy("unique")])], NOW, incoming_bytes=101 * 1024**3
    )
    assert result["capacity"][0]["reserveSatisfied"] is False
    assert result["capacity"][0]["remainingBytesProjected"] == 99 * 1024**3
    assert result["reclaimBytesUpperBound"] == 0
    stale = document([])
    stale["inventoryAt"] = (NOW - timedelta(days=2)).isoformat()
    assert run_plan([stale], NOW)["capacity"][0]["reserveSatisfied"] is None


def test_duplicate_inventories_and_unsafe_policy_fail_closed():
    entry = copy("a")
    with pytest.raises(ValueError):
        run_plan([document([entry, entry])], NOW)
    with pytest.raises(ValueError):
        run_plan([document([])], NOW, minimum_copies=1)
    with pytest.raises(ValueError):
        run_plan([document([])], NOW, incoming_bytes=-1)
    entry["path"] = "../backup"
    with pytest.raises(ValueError):
        run_plan([document([entry])], NOW)


def test_inventory_hash_bound_receipt_and_protected_unknowns(tmp_path):
    tmp_path.chmod(0o700)
    root = tmp_path / "backups"
    root.mkdir(mode=0o700)
    proofs = tmp_path / "proofs"
    proofs.mkdir(mode=0o700)
    name = "20261001T000000Z.tar.gpg"
    archive = root / name
    archive.write_bytes(b"ciphertext fixture, not a decryption test")
    archive.chmod(0o600)
    unknown = root / "private-config.json"
    unknown.write_text('{"credential":"PRIVATE_TEST_MARKER"}')
    link = root / "20261002T000000Z.tar.gpg"
    link.symlink_to(unknown)
    first = retention.inventory(root, "main", "database", "head", proofs, NOW)
    assert all(not item["verified"] for item in first["copies"])
    proof = dict(
        schemaVersion=retention.PROOF,
        scope="main",
        kind="database",
        snapshot=name,
        copySha256=hashlib.sha256(archive.read_bytes()).hexdigest(),
        contentSha256="a" * 64,
        verifiedAt=NOW.isoformat(),
        restoreVerified=True,
        recoveryKeyVerified=True,
    )
    p = proofs / (name + ".verification.json")
    p.write_text(json.dumps(proof))
    p.chmod(0o600)
    second = retention.inventory(root, "main", "database", "head", proofs, NOW)
    verified = [item for item in second["copies"] if item["verified"]]
    assert len(verified) == 1 and verified[0]["digest"] == "a" * 64
    assert (
        next(item for item in second["copies"] if item["path"] == str(link))["reason"]
        == "symlink-protected"
    )
    archive.write_bytes(b"changed ciphertext")
    assert not any(
        item["verified"]
        for item in retention.inventory(root, "main", "database", "head", proofs, NOW)[
            "copies"
        ]
    )
    assert "PRIVATE_TEST_MARKER" not in json.dumps(second)


def test_private_output_never_overwrites_and_refuses_public_metadata(tmp_path):
    tmp_path.chmod(0o700)
    path = tmp_path / "inventory.json"
    retention.write_private(path, document([]))
    assert path.stat().st_mode & 0o777 == 0o600
    with pytest.raises(FileExistsError):
        retention.write_private(path, {})
    path.chmod(0o644)
    with pytest.raises(ValueError):
        retention.read_private(path)


def test_inventory_stops_iteration_before_materializing_unbounded_names(
    tmp_path, monkeypatch
):
    tmp_path.chmod(0o700)
    consumed = []

    def entries(_root):
        for index in range(100):
            consumed.append(index)
            yield tmp_path / str(index)

    monkeypatch.setattr(retention, "MAX_ENTRIES", 2)
    monkeypatch.setattr(Path, "iterdir", entries)
    with pytest.raises(ValueError, match="entry bound"):
        retention.inventory(tmp_path, "main", "database", "head", now=NOW)
    assert consumed == [0, 1, 2]


def test_fingerprint_is_bounded_when_file_grows_during_read(tmp_path, monkeypatch):
    archive = tmp_path / "archive"
    archive.write_bytes(b"original")
    original = retention.os.read
    consumed = []

    def read(fd, amount):
        data = original(fd, amount)
        consumed.append(len(data))
        with archive.open("ab") as writer:
            writer.write(b"growing forever")
        return data

    monkeypatch.setattr(retention.os, "read", read)
    with pytest.raises(ValueError, match="grew"):
        retention.fingerprint(archive)
    assert sum(consumed) <= len(b"original") + 1
    assert len(consumed) == 2


def test_timezone_order_uses_instants_not_iso_text():
    first = [copy(domain, digest="c" * 64) for domain in ["a", "b", "c"]]
    second = [
        copy(domain, digest="d" * 64, suffix="other") for domain in ["a", "b", "c"]
    ]
    for item in first:
        item["snapshotAt"] = "2026-10-01T23:30:00-10:00"
    for item in second:
        item["snapshotAt"] = "2026-10-02T00:00:00+10:00"
    result = run_plan([document(first + second)], NOW, minimum_points=1)
    assert len(result["candidates"]) == 1
    assert result["candidates"][0]["digest"] == "d" * 64


@pytest.mark.parametrize(
    "free,total",
    [
        (True, 100),
        (0, 0),
        (-1, 100),
        (101, 100),
        (float("nan"), 100),
        (100, float("inf")),
    ],
)
def test_invalid_capacity_never_reports_reserve_satisfied(free, total):
    data = document([])
    data["filesystem"] = dict(freeBytes=free, totalBytes=total)
    with pytest.raises(ValueError, match="capacity"):
        run_plan([data], NOW)


def test_proof_cannot_predate_snapshot_even_if_both_timestamps_are_fresh():
    items = [copy(domain, days=0) for domain in ["a", "b", "c"]]
    for item in items:
        item["snapshotAt"] = (NOW - timedelta(hours=1)).isoformat()
        item["proofAt"] = (NOW - timedelta(hours=2)).isoformat()
    result = run_plan([document(items)], NOW, minimum_points=1)
    assert not result["candidates"]
    assert all(
        item["reason"] == "unverified-stale-or-future" for item in result["protected"]
    )


def test_traversal_error_protects_snapshot_and_root_allocation_is_counted(
    tmp_path, monkeypatch
):
    tmp_path.chmod(0o700)
    root = tmp_path / "backups"
    root.mkdir(mode=0o700)
    snapshot = root / "20261001T000000Z"
    snapshot.mkdir(mode=0o700)
    assert retention.allocated_bytes(snapshot) == snapshot.stat().st_blocks * 512
    monkeypatch.setattr(retention, "verify_directory", lambda *_: "a" * 64)

    def walk(_path, **kwargs):
        assert kwargs.get("onerror") is not None
        kwargs["onerror"](PermissionError("fixture traversal denied"))
        yield None

    monkeypatch.setattr(retention.os, "walk", walk)
    result = retention.inventory(root, "main", "database", "head", now=NOW)
    assert result["copies"][0]["reason"] == "verification-failed-protected"
    assert result["copies"][0]["verified"] is False


def test_capacity_rows_identify_source_and_inconsistent_storage_is_rejected():
    result = run_plan([document([copy("head"), copy("worker")])], NOW)
    assert {(row["directory"], row["storage"]) for row in result["capacity"]} == {
        ("/backup/head", "head"),
        ("/backup/worker", "worker"),
    }
    bad = document([copy("head")])
    with pytest.raises(ValueError, match="source identity"):
        retention.plan([bad], NOW)
