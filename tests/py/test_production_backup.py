"""PostgreSQL backup is testable without production or a database server."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess

import pytest

spec = importlib.util.spec_from_file_location(
    "production_backup", Path(__file__).resolve().parents[2] / "scripts/operations/production-backup.py"
)
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


def object_at(root, content=b"scientific evidence"):
    digest = hashlib.sha256(content).hexdigest()
    obj = root / "sha256" / digest[:2] / digest
    obj.parent.mkdir(parents=True)
    obj.write_bytes(content)
    return obj


def mock_postgres(monkeypatch, references=()):
    calls = []

    def run(command, **kwargs):
        calls.append(command)
        if command[0] == "pg_dump":
            kwargs["stdout"].write(b"PGDMP fixture")
        return b""

    monkeypatch.setattr(backup, "run", run)
    monkeypatch.setattr(backup, "dump_references", lambda path: set(references))
    return calls


def test_database_snapshot_precedes_cas_copy_and_has_no_credentials(tmp_path, monkeypatch):
    source = tmp_path / "source"
    obj = object_at(source)
    output = tmp_path / "backup"
    calls = mock_postgres(monkeypatch, [obj.name])
    original = backup.copy_cas

    def copy(root, destination):
        assert calls[0][0] == "pg_dump"
        assert (destination.parents[1] / "database.dump").exists()
        original(root, destination)

    monkeypatch.setattr(backup, "copy_cas", copy)
    result = backup.create_backup(output, [source], {"PGDATABASE": "postgresql://user:secret@host/db"})
    assert result == {"files": 2, "casObjects": 1, "referencedCasObjects": 1, "restoreExecuted": False}
    assert "secret" not in (output / "manifest.json").read_text()
    assert "secret" not in repr(calls)
    assert output.stat().st_mode & 0o777 == 0o700
    assert backup.verify(output) == result


def test_corrupt_cas_fails_without_publishing(tmp_path, monkeypatch):
    source = tmp_path / "source"
    obj = object_at(source)
    obj.write_bytes(b"corrupted")
    mock_postgres(monkeypatch)
    with pytest.raises(backup.BackupError, match="digest mismatch"):
        backup.create_backup(tmp_path / "backup", [source], {})
    assert not (tmp_path / "backup").exists()
    assert not list(tmp_path.glob(".eigengrid-backup-*"))


def test_symlinks_and_overlapping_roots_rejected(tmp_path, monkeypatch):
    source = tmp_path / "source"
    obj = object_at(source)
    calls = mock_postgres(monkeypatch)
    with pytest.raises(backup.BackupError, match="overlap"):
        backup.create_backup(source / "backup", [source], {})
    assert not calls
    obj.unlink()
    obj.symlink_to(tmp_path / "outside")
    with pytest.raises(OSError):
        backup.copy_cas(source, tmp_path / "copy")


def test_missing_reference_fails_before_publication(tmp_path, monkeypatch):
    source = tmp_path / "source"
    object_at(source)
    mock_postgres(monkeypatch, ["a" * 64])
    with pytest.raises(backup.BackupError, match="missing CAS"):
        backup.create_backup(tmp_path / "backup", [source], {})
    assert not (tmp_path / "backup").exists()


def test_manifest_detects_tampering_and_staging_is_excluded(tmp_path, monkeypatch):
    source = tmp_path / "source"
    obj = object_at(source)
    staging = source / "sha256" / ".staging"
    staging.mkdir()
    (staging / "incomplete").write_text("not a published object")
    mock_postgres(monkeypatch, [obj.name])
    output = tmp_path / "backup"
    backup.create_backup(output, [source], {})
    (output / "database.dump").write_text("changed")
    with pytest.raises(backup.BackupError, match="integrity"):
        backup.verify(output)


def test_pg_errors_do_not_disclose_dsn(monkeypatch):
    def failed(*args, **kwargs):
        raise subprocess.CalledProcessError(1, ["pg_dump"], stderr=b"postgresql://user:secret@host/db")
    monkeypatch.setattr(subprocess, "run", failed)
    with pytest.raises(backup.BackupError) as error:
        backup.run(["pg_dump"])
    assert "secret" not in str(error.value)


def test_restore_refuses_production_and_nonempty_database(tmp_path, monkeypatch):
    (tmp_path / "database.dump").write_bytes(b"fixture")
    monkeypatch.setattr(backup, "verify", lambda path: {"restoreExecuted": False})
    calls = []
    responses = iter([b"eigengrid\n"])
    def run(command, **kwargs):
        calls.append(command)
        return next(responses)
    monkeypatch.setattr(backup, "run", run)
    with pytest.raises(backup.BackupError, match="disposable"):
        backup.restore_verify(tmp_path, {"PGDATABASE": "secret"})
    assert not any(command[0] == "pg_restore" for command in calls)
    responses = iter([b"eigengrid_restore_test\n", b"1\n"])
    with pytest.raises(backup.BackupError, match="empty"):
        backup.restore_verify(tmp_path, {"PGDATABASE": "secret"})
    assert not any(command[0] == "pg_restore" for command in calls)
    responses = iter([b"eigengrid_restore_test\n", b"0\n", b""])
    assert backup.restore_verify(tmp_path, {"PGDATABASE": "secret"})["restoreExecuted"]
    assert "secret" not in repr(calls)
    assert "--single-transaction" in calls[-1]
