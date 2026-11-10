"""Release admission and rollback must fail closed before changing active software."""

import copy
import importlib.util
import io
import json
import os
import subprocess
import tarfile
from pathlib import Path

import pytest


def load(name):
    path = Path(__file__).resolve().parents[2] / "scripts/deploy" / (name + ".py")
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


controller = load("pull_release")
installer = load("install")


def identity():
    commit = "a" * 40
    validation = {
        "schemaVersion": "eigengrid.release-validation/v1",
        "repositoryId": 123,
        "runId": 456,
        "sourceCommit": commit,
        "tag": "v1.0.0-rc.2",
        "archive": "eigengrid-1.0.0-rc.2-linux-x64.tar.gz",
        "archiveSha256": "b" * 64,
        "manifestSha256": "c" * 64,
    }
    release = {"tag_name": validation["tag"], "draft": False}
    run = {
        "id": 456,
        "repository": {"id": 123},
        "head_sha": commit,
        "event": "push",
        "path": ".github/workflows/ci.yml",
        "status": "completed",
        "conclusion": "success",
    }
    return validation, release, run, 123, commit


def test_validated_release_is_admitted():
    controller.validate_identity(*identity())


@pytest.mark.parametrize(
    "part,key,value",
    [
        (0, "repositoryId", 999),
        (0, "sourceCommit", "d" * 40),
        (0, "runId", 777),
        (0, "archive", "../../outside.tar.gz"),
        (0, "archiveSha256", "invalid"),
        (1, "draft", True),
        (1, "tag_name", "v2.0.0"),
        (2, "event", "pull_request"),
        (2, "path", ".github/workflows/unrelated.yml"),
        (2, "conclusion", "failure"),
        (2, "status", "in_progress"),
    ],
)
def test_unvalidated_release_is_rejected(part, key, value):
    arguments = copy.deepcopy(identity())
    arguments[part][key] = value
    with pytest.raises(ValueError):
        controller.validate_identity(*arguments)


@pytest.mark.parametrize(
    "tag",
    [
        "v1.0.0-rc.0",
        "v1.0.0-rc.01",
        "v1.0.0-rc.2\n",
        "../v1.0.0-rc.2",
        "v1.0.0",
        "v1.0.1",
    ],
)
def test_release_names_cannot_escape_the_channel(tag):
    with pytest.raises(ValueError):
        controller.revision(tag)


def test_asset_requires_expected_origin_and_digest():
    name = "validation.json"
    item = {
        "name": name,
        "state": "uploaded",
        "digest": "sha256:" + "a" * 64,
        "browser_download_url": "https://github.com/example/eigengrid/releases/download/v1.0.0-rc.2/validation.json",
    }
    release = {"tag_name": "v1.0.0-rc.2", "assets": [item]}
    assert controller.asset(release, name, "example/eigengrid") is item
    item["browser_download_url"] = "https://example.org/payload"
    with pytest.raises(ValueError):
        controller.asset(release, name, "example/eigengrid")


@pytest.mark.parametrize(
    "suffix,kind",
    [
        ("../outside", tarfile.REGTYPE),
        ("bin/./program", tarfile.REGTYPE),
        ("bin/program", tarfile.SYMTYPE),
        ("bin/program", tarfile.LNKTYPE),
        ("bin/program", tarfile.FIFOTYPE),
    ],
)
def test_archive_rejects_path_aliases_and_special_files(
    tmp_path, monkeypatch, suffix, kind
):
    monkeypatch.setattr(installer, "version", "1.0.0-rc.2", raising=False)
    archive = tmp_path / "package.tar"
    with tarfile.open(archive, "w") as stream:
        entry = tarfile.TarInfo("eigengrid-1.0.0-rc.2-linux-x64/" + suffix)
        entry.type = kind
        entry.linkname = "/etc/passwd" if kind != tarfile.REGTYPE else ""
        stream.addfile(entry)
    destination = tmp_path / "extracted"
    destination.mkdir()
    with pytest.raises(AssertionError):
        installer.extract_archive(archive, destination)
    assert list(destination.iterdir()) == []


def test_archive_rejects_duplicates(tmp_path, monkeypatch):
    monkeypatch.setattr(installer, "version", "1.0.0-rc.2", raising=False)
    archive = tmp_path / "package.tar"
    with tarfile.open(archive, "w") as stream:
        for _ in range(2):
            entry = tarfile.TarInfo("eigengrid-1.0.0-rc.2-linux-x64/LICENSE")
            entry.size = 1
            stream.addfile(entry, io.BytesIO(b"x"))
    with pytest.raises(AssertionError):
        installer.extract_archive(archive, tmp_path / "extracted")


def test_failed_activation_restores_links_environment_and_modules(
    tmp_path, monkeypatch
):
    paths = {}
    for name in ["candidate", "client", "old_client", "old_head", "backup", "modules"]:
        paths[name] = tmp_path / name
        paths[name].mkdir()
    paths.update(
        {
            "head_link": tmp_path / "head-current",
            "client_link": tmp_path / "client-current",
            "env_path": tmp_path / "head.env",
            "new_module": paths["modules"] / "1.0.0-rc.2.lua",
            "old_module": paths["modules"] / "1.0.0-rc.1.lua",
            "default_module": paths["modules"] / ".version",
        }
    )
    for name, path in paths.items():
        monkeypatch.setattr(installer, name, path, raising=False)
    for directory, name in [
        (paths["candidate"] / "bin", "eigengrid-head"),
        (paths["client"] / "libexec", "eigengrid"),
        (paths["client"] / "bin", "eigengrid"),
        (paths["old_client"] / "bin", "eigengrid"),
    ]:
        directory.mkdir()
        (directory / name).write_bytes(b"candidate")
    paths["head_link"].symlink_to(paths["old_head"])
    paths["client_link"].symlink_to(paths["old_client"])
    original_env = "EIGENGRID_RELEASE_COMMIT=" + "f" * 40 + "\nSITE_SETTING=preserve\n"
    paths["env_path"].write_text(original_env)
    paths["old_module"].write_text("previous module\n")
    paths["default_module"].write_text("previous default\n")
    (paths["backup"] / "previous-module.lua").write_text(
        paths["old_module"].read_text()
    )
    (paths["backup"] / "previous-default").write_text(
        paths["default_module"].read_text()
    )
    before = {
        "headEnvironmentSha256": installer.digest(paths["env_path"]),
        "oldModuleSha256": installer.digest(paths["old_module"]),
        "defaultModuleSha256": installer.digest(paths["default_module"]),
        "oldClientWrapperSha256": installer.digest(
            paths["old_client"] / "bin/eigengrid"
        ),
        "scientificSkillsRoot": None,
    }
    receipt = {
        "headBinarySha256": installer.digest(paths["candidate"] / "bin/eigengrid-head"),
        "clientBinarySha256": installer.digest(paths["client"] / "libexec/eigengrid"),
        "clientWrapperSha256": installer.digest(paths["client"] / "bin/eigengrid"),
        "scientificCatalog": {"root": None, "corpusDigest": "b" * 64, "skills": 31},
    }
    (paths["backup"] / "before.json").write_text(json.dumps(before))
    (paths["backup"] / "prepared.json").write_text(json.dumps(receipt))
    monkeypatch.setattr(installer, "sha", "a" * 40, raising=False)
    monkeypatch.setattr(installer, "version", "1.0.0-rc.2", raising=False)
    monkeypatch.setattr(installer, "check_previous", lambda: None)
    monkeypatch.setattr(installer, "plan", {}, raising=False)
    monkeypatch.setattr(
        installer,
        "catalog_status",
        lambda root=None: {"corpusDigest": "b" * 64, "skills": 31},
    )
    restarts = []

    def restart(args, **kwargs):
        assert args == ["systemctl", "restart", "eigengrid-head"]
        restarts.append(paths["head_link"].resolve())
        if len(restarts) == 1:
            raise RuntimeError("Simulated startup failure")

    monkeypatch.setattr(installer, "run", restart)
    with pytest.raises(RuntimeError, match="startup failure"):
        installer.activate()
    assert restarts == [paths["candidate"], paths["old_head"]]
    assert paths["head_link"].resolve() == paths["old_head"]
    assert paths["client_link"].resolve() == paths["old_client"]
    assert paths["env_path"].read_text() == original_env
    assert paths["env_path"].stat().st_mode & 0o777 == 0o600
    assert paths["old_module"].read_text() == "previous module\n"
    assert paths["default_module"].read_text() == "previous default\n"
    assert not paths["new_module"].exists()


@pytest.fixture
def catalog(tmp_path):
    root = tmp_path / "site-knowledge" / "corpus"
    root.mkdir(parents=True)
    (root / "skill.yaml").write_text(
        "synthetic manifest; runtime validation is separate\n"
    )
    return str(root)


def selection_text(root):
    return (
        ': "${EIGENGRID_SCIENTIFIC_SKILLS_ROOT:='
        + root
        + '}"\nexport EIGENGRID_SCIENTIFIC_SKILLS_ROOT\n',
        'setenv("EIGENGRID_SCIENTIFIC_SKILLS_ROOT", "' + root + '")\n',
    )


def test_catalog_preserved_from_launcher_module_or_explicit_recovery(catalog):
    wrapper, module = selection_text(catalog)
    for launch, mod, explicit in [
        (wrapper, module, None),
        (wrapper, "", None),
        ("", module, None),
        ("", "", catalog),
        (wrapper, module, catalog),
    ]:
        assert installer.catalog_selection(launch, mod, explicit) == catalog
    assert installer.catalog_selection("#!/bin/sh\n", "-- public catalog\n") is None


def test_catalog_selection_rejects_conflicts_missing_data_and_executable_syntax(
    catalog, tmp_path
):
    wrapper, module = selection_text(catalog)
    with pytest.raises(ValueError, match="Conflicting"):
        installer.catalog_selection(wrapper, module, "/different/catalog")
    with pytest.raises(ValueError, match="Duplicate"):
        installer.catalog_selection(wrapper + wrapper, module)
    with pytest.raises(ValueError, match="unavailable"):
        installer.catalog_selection("", "", catalog + "/missing")
    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(ValueError, match="no manifests"):
        installer.catalog_selection("", "", str(empty))
    for unsafe in [
        "relative/path",
        "/tmp/$(id)",
        "/tmp/`id`",
        "/tmp/catalog\nexport X=1",
        catalog + "/../corpus",
    ]:
        with pytest.raises(ValueError):
            installer.catalog_selection("", "", unsafe)
    with pytest.raises(ValueError, match="Unsupported"):
        installer.catalog_selection(
            "export EIGENGRID_SCIENTIFIC_SKILLS_ROOT=$(lookup)", ""
        )


def test_generated_launcher_and_module_keep_site_catalog_and_user_override(
    tmp_path, monkeypatch, catalog
):
    client = tmp_path / "client"
    (client / "bin").mkdir(parents=True)
    (client / "libexec").mkdir()
    monkeypatch.setattr(installer, "client", client, raising=False)
    monkeypatch.setattr(installer, "version", "1.0.1", raising=False)
    executable = client / "libexec/eigengrid"
    executable.write_text(
        '#!/bin/sh\nprintf "%s\\n" "$EIGENGRID_SCIENTIFIC_SKILLS_ROOT" "$@"\n'
    )
    executable.chmod(0o755)
    wrapper = client / "bin/eigengrid"
    wrapper.write_text(installer.client_wrapper(catalog))
    wrapper.chmod(0o755)
    env = {k: v for k, v in os.environ.items() if k != installer.CATALOG_ENV}
    assert subprocess.check_output(
        [str(wrapper), "argument with spaces"], env=env, text=True
    ).splitlines() == [catalog, "argument with spaces"]
    env[installer.CATALOG_ENV] = "/user/catalog"
    assert (
        subprocess.check_output([str(wrapper)], env=env, text=True).strip()
        == "/user/catalog"
    )
    assert (
        installer.catalog_selection(
            wrapper.read_text(), installer.client_module(catalog)
        )
        == catalog
    )


@pytest.mark.parametrize(
    "failure", ["lost-root", "changed-catalog", "changed-wrapper", "expected-digest"]
)
def test_catalog_gate_rejects_changes_before_activation(
    tmp_path, monkeypatch, catalog, failure
):
    old = tmp_path / "old"
    client = tmp_path / "new"
    module = tmp_path / "old.lua"
    for path in (old, client):
        (path / "bin").mkdir(parents=True)
        (path / "bin/eigengrid").write_text(selection_text(catalog)[0])
    module.write_text(selection_text(catalog)[1])
    for name, value in {
        "old_client": old,
        "client": client,
        "old_module": module,
        "plan": {},
    }.items():
        monkeypatch.setattr(installer, name, value, raising=False)
    before = {
        "oldClientWrapperSha256": installer.digest(old / "bin/eigengrid"),
        "oldModuleSha256": installer.digest(module),
        "scientificSkillsRoot": catalog,
    }
    original = {
        "corpusDigest": "b" * 64,
        "skills": 83,
        "fragments": 200,
        "documents": 300,
    }
    receipt = {
        "clientWrapperSha256": installer.digest(client / "bin/eigengrid"),
        "scientificCatalog": {"root": catalog, **original},
    }
    observed = dict(original)
    monkeypatch.setattr(
        installer,
        "catalog_status",
        lambda root=None: original if root and failure == "lost-root" else observed,
    )
    assert installer.check_catalog(before, receipt) == receipt["scientificCatalog"]
    if failure == "changed-wrapper":
        (client / "bin/eigengrid").write_text("lost selection")
    elif failure == "expected-digest":
        installer.plan["scientificCatalogDigest"] = "c" * 64
    else:
        observed["corpusDigest"] = "c" * 64
    with pytest.raises((ValueError, AssertionError)):
        installer.check_catalog(before, receipt)


def test_catalog_probe_does_not_inherit_overrides_and_requires_valid_content(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(installer, "client", tmp_path, raising=False)
    monkeypatch.setattr(
        installer, "plan", {"probeUser": "release-probe"}, raising=False
    )
    status = {
        "corpusDigest": "a" * 64,
        "skills": 31,
        "fragments": 100,
        "documents": 200,
    }

    def run(args, **kwargs):
        assert args[:7] == ["sudo", "-n", "-H", "-u", "release-probe", "env", "-u"]
        assert args[7:10] == [installer.CATALOG_ENV, "-u", "EIGENGRID_RETRIEVAL_CONFIG"]
        assert args[10:] == [str(tmp_path / "bin/eigengrid"), "retrieval", "status"]
        assert kwargs["timeout"] == 60
        return json.dumps(status)

    monkeypatch.setattr(installer, "run", run)
    assert installer.catalog_status() == status
    status["skills"] = 0
    with pytest.raises(ValueError, match="Empty or invalid"):
        installer.catalog_status()
