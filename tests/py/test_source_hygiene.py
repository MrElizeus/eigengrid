"""The source guard covers uncommitted additions and safe source renames."""
import importlib.util
from pathlib import Path
import subprocess

SOURCE = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("release_scan", SOURCE / "scripts/release/scan.py")
assert spec and spec.loader
scanner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scanner)


def test_scan_includes_untracked_files_and_tolerates_deleted_tracked_files(tmp_path):
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    old = tmp_path / "old.ts"
    old.write_text("export const old = true;\n")
    subprocess.run(["git", "-C", str(tmp_path), "add", "old.ts"], check=True)
    old.unlink()
    (tmp_path / "new.ts").write_text("export const current = true;\n")
    (tmp_path / "accidental.txt").write_text("sk-" + "x" * 48)
    errors, count = scanner.scan(tmp_path)
    assert count == 2
    assert errors == ["accidental.txt: provider-token"]


def test_scan_rejects_retired_source_names_and_repository_metadata(tmp_path):
    (tmp_path / ("a" + "5-service.ts")).write_text("export {};\n")
    (tmp_path / "package.json").write_text(
        '{"name":"@eigengrid/example","repository":{"url":"https://example.invalid/old.git"}}'
    )
    errors, _ = scanner.scan(tmp_path)
    assert any("retired development-phase filename" in error for error in errors)
    assert any("package repository differs" in error for error in errors)


def test_scan_rejects_symlinks_without_reading_the_target(tmp_path):
    (tmp_path / "linked.ts").symlink_to(tmp_path / "does-not-exist")
    errors, _ = scanner.scan(tmp_path)
    assert errors == ["linked.ts: forbidden entry or oversized source file"]


def test_public_distribution_requires_explicit_valid_policy(tmp_path):
    import json

    assert scanner.publication_errors(tmp_path)
    policy = tmp_path / "publication.json"
    for value in (None, [], {}, {"visibility": "public"},
                  {"schemaVersion": "eigengrid.publication-policy/v1", "visibility": "private"}):
        policy.write_text(json.dumps(value))
        assert scanner.publication_errors(tmp_path)
    policy.write_text('{"schemaVersion":"eigengrid.publication-policy/v1","visibility":"public"}')
    assert scanner.publication_errors(tmp_path)
    _public_catalog(tmp_path)
    assert scanner.publication_errors(tmp_path) == []


def test_public_scan_exits_unsuccessfully_for_private_source(tmp_path):
    (tmp_path / "publication.json").write_text(
        '{"schemaVersion":"eigengrid.publication-policy/v1","visibility":"private"}'
    )
    result = subprocess.run(
        [__import__("sys").executable, str(SOURCE / "scripts/release/scan.py"), "--public", str(tmp_path)],
        capture_output=True, text=True,
    )
    assert result.returncode == 1
    assert "Public distribution blocked" in result.stderr


def _public_catalog(root):
    import hashlib
    import json
    source = root / "scientific-skills/basic/skill.yaml"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_text("fixture: public\n")
    (root / "publication.json").write_text(json.dumps({
        "schemaVersion": "eigengrid.publication-policy/v1", "visibility": "public",
        "catalogSkillIds": ["basic"],
    }))
    (root / "publication-catalog.json").write_text(json.dumps({
        "schemaVersion": "eigengrid.public-catalog/v1",
        "files": {"scientific-skills/basic/skill.yaml": hashlib.sha256(source.read_bytes()).hexdigest()},
    }))
    return source


def test_public_catalog_rejects_unreviewed_bytes_additions_and_links(tmp_path):
    source = _public_catalog(tmp_path)
    assert scanner.publication_errors(tmp_path) == []
    source.write_text("fixture: modified\n")
    assert scanner.publication_errors(tmp_path)
    _public_catalog(tmp_path)
    extra = source.parent / "extra.md"
    extra.write_text("Unreviewed addition")
    assert scanner.publication_errors(tmp_path)
    extra.unlink()
    extra.symlink_to(source)
    assert scanner.publication_errors(tmp_path) == ["Public catalog contains a symlink"]


def test_reserved_research_is_rejected_even_in_a_new_source_file(tmp_path):
    (tmp_path / "unreviewed.txt").write_text("tryp" + "tamine study")
    errors, _ = scanner.scan(tmp_path)
    assert errors == ["unreviewed.txt: reserved-research"]
