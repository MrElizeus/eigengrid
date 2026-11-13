"""Operational wrapper is independent from the strict PostgreSQL/CAS format."""
import importlib.util
import json
from pathlib import Path
import os
import pytest

spec = importlib.util.spec_from_file_location("operational_backup", Path(__file__).resolve().parents[2] / "scripts/operations/operational-backup.py")
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


def fixture(tmp_path, monkeypatch):
    tmp_path.chmod(0o700)
    source = tmp_path / "live"
    source.mkdir(mode=0o700)
    (source / "journal").mkdir()
    (source / "journal" / "session.jsonl").write_bytes(b'{"type":"started"}\n')
    calls = []

    def component(command, directory, extra=()):
        calls.append(command)
        if command == "create":
            directory.mkdir(mode=0o700)
            (directory / "manifest.json").write_text('{"schemaVersion":"strict-db-format-unchanged"}')
            (directory / "database.dump").write_bytes(b"PGDMP fixture")
        else:
            assert (directory / "database.dump").read_bytes() == b"PGDMP fixture"
    monkeypatch.setattr(backup, "component", component)
    return source, calls


def test_independent_component_and_journals_verified_without_claiming_atomicity(tmp_path, monkeypatch):
    source, calls = fixture(tmp_path, monkeypatch)
    output = tmp_path / "snapshot"
    result = backup.create(output, {"qualification": source}, [])
    assert result["verified"] and not result["crossComponentAtomic"]
    assert result["resumePolicy"] == "quarantine-and-manual-reconciliation-only"
    assert calls[0] == "create" and calls.count("verify") == 2
    manifest = json.loads((output / "operational-manifest.json").read_text())
    assert manifest["journals"]["qualification"]["fileCount"] == 1
    assert (output / "database" / "manifest.json").read_text() == '{"schemaVersion":"strict-db-format-unchanged"}'
    assert (output / "journals" / "qualification" / "journal" / "session.jsonl").stat().st_mode & 0o777 == 0o600
    assert backup.verify(output) == result


@pytest.mark.parametrize("change", ["corrupt", "extra", "missing", "symlink", "manifest-policy"])
def test_corruption_and_unexpected_members_fail(tmp_path, monkeypatch, change):
    source, _ = fixture(tmp_path, monkeypatch)
    output = tmp_path / "snapshot"
    backup.create(output, {"qualification": source}, [])
    journal = output / "journals" / "qualification" / "journal" / "session.jsonl"
    if change == "corrupt": journal.write_bytes(b"corrupt")
    if change == "extra": (output / "extra").write_text("unexpected")
    if change == "missing": journal.unlink()
    if change == "symlink": journal.unlink(); journal.symlink_to(source / "journal" / "session.jsonl")
    if change == "manifest-policy":
        p = output / "operational-manifest.json"
        v = json.loads(p.read_text()); v["consistency"]["crossComponentAtomic"] = True; p.write_text(json.dumps(v))
    with pytest.raises((ValueError, OSError)):
        backup.verify(output)


def test_bounded_copy_rejects_symlinks_and_oversize_without_publishing(tmp_path, monkeypatch):
    source, _ = fixture(tmp_path, monkeypatch)
    (source / "escape").symlink_to(tmp_path)
    with pytest.raises(ValueError): backup.create(tmp_path / "snapshot", {"qualification": source}, [])
    assert not (tmp_path / "snapshot").exists()
    assert not list(tmp_path.glob(".operational-*"))
    (source / "escape").unlink()
    monkeypatch.setattr(backup, "MAX_FILE_BYTES", 2)
    with pytest.raises(ValueError): backup.create(tmp_path / "snapshot", {"qualification": source}, [])
    assert not (tmp_path / "snapshot").exists()


def test_rename_refuses_existing_empty_destination_and_cleans_staging(tmp_path, monkeypatch):
    source, _ = fixture(tmp_path, monkeypatch)
    existing = tmp_path / "existing"
    existing.mkdir()
    staging = tmp_path / "staging"
    staging.mkdir()
    with pytest.raises(OSError): backup.publish_no_replace(staging, existing)
    assert existing.is_dir() and staging.is_dir()
    with pytest.raises(FileExistsError): backup.create(existing, {"qualification": source}, [])


def test_hardlinked_journal_and_invalid_labels_are_rejected(tmp_path, monkeypatch):
    source, _ = fixture(tmp_path, monkeypatch)
    os.link(source / "journal" / "session.jsonl", source / "linked")
    with pytest.raises(ValueError): backup.create(tmp_path / "snapshot", {"qualification": source}, [])
    (source / "linked").unlink()
    with pytest.raises(ValueError): backup.create(tmp_path / "snapshot", {"../escape": source}, [])


def test_mutation_during_capture_fails_closed_and_cleans_staging(tmp_path, monkeypatch):
    source, _ = fixture(tmp_path, monkeypatch)
    original = backup.os.read
    changed = False
    def read(fd, amount):
        nonlocal changed
        data = original(fd, amount)
        if not changed:
            changed = True
            with (source / "journal" / "session.jsonl").open("ab") as stream:
                stream.write(b'{"type":"new_event"}\n')
        return data
    monkeypatch.setattr(backup.os, "read", read)
    with pytest.raises(ValueError, match="changed during capture"):
        backup.create(tmp_path / "snapshot", {"qualification": source}, [])
    assert not (tmp_path / "snapshot").exists()
    assert not list(tmp_path.glob(".operational-*"))


def test_cli_preserves_all_cas_roots_for_independent_database_component(tmp_path, monkeypatch, capsys):
    import sys
    captured = {}
    def create(output, journals, arguments):
        captured.update(output=output, journals=journals, arguments=arguments)
        return {"verified": True}
    monkeypatch.setattr(backup, "create", create)
    monkeypatch.setattr(sys, "argv", ["operational-backup.py", "create", "--output", str(tmp_path / "output"), "--database-env", "PRIVATE_DB", "--artifact-root", "/qualified/cas", "--artifact-root", "/main/cas", "--journal-root", "production=/main/journal"])
    backup.main()
    assert captured["arguments"] == ["--database-env", "PRIVATE_DB", "--artifact-root", "/qualified/cas", "--artifact-root", "/main/cas"]
    assert captured["journals"] == {"production": "/main/journal"}
    assert json.loads(capsys.readouterr().out) == {"verified": True}


def test_real_empty_directories_are_bounded_and_staging_is_removed(tmp_path, monkeypatch):
    source, _ = fixture(tmp_path, monkeypatch)
    empty = source / "empty"
    empty.mkdir()
    # Real filesystem directories at the configured production limit, not mocked
    # DirEntry objects or a lowered seam. Root and existing journal also count.
    for index in range(backup.MAX_JOURNAL_DIRECTORIES):
        (empty / f"dir-{index}").mkdir()
    with pytest.raises(ValueError, match="directory-count bound"):
        backup.create(tmp_path / "snapshot", {"qualification": source}, [])
    assert not (tmp_path / "snapshot").exists()
    assert not list(tmp_path.glob(".operational-*"))
    assert len(list(empty.iterdir())) == backup.MAX_JOURNAL_DIRECTORIES


def test_regular_file_cannot_silently_be_captured_as_empty_journal_root(tmp_path, monkeypatch):
    source, _ = fixture(tmp_path, monkeypatch)
    file = source / "journal" / "session.jsonl"
    with pytest.raises(ValueError, match="must be a directory"):
        backup.create(tmp_path / "snapshot", {"qualification": file}, [])
    assert not (tmp_path / "snapshot").exists()


def test_verification_rejects_unlisted_empty_directory_flood(tmp_path, monkeypatch):
    source, _ = fixture(tmp_path, monkeypatch)
    output = tmp_path / "snapshot"
    backup.create(output, {"qualification": source}, [])
    empty = output / "journals" / "qualification" / "empty"
    empty.mkdir()
    for index in range(backup.MAX_JOURNAL_DIRECTORIES):
        (empty / f"dir-{index}").mkdir()
    with pytest.raises(ValueError, match="directory-count bound"):
        backup.verify(output)
