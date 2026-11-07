#!/usr/bin/env python3
"""Install a verified candidate and preserve the site's existing execution policy."""

import datetime
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tarfile
import time

P = pathlib.Path


def configure(staging):
    global \
        incoming, \
        plan, \
        sha, \
        version, \
        backup, \
        candidate, \
        client, \
        head_link, \
        client_link, \
        env_path, \
        modules, \
        new_module, \
        old_module, \
        default_module, \
        old_client, \
        old_head
    incoming = P(staging).resolve()
    plan = json.loads((incoming / "installation-plan.json").read_text())
    sha = plan["commit"]
    version = plan["version"]
    backup = P("/var/backups") / ("eigengrid-install-" + sha[:12])
    candidate = P("/opt/eigengrid/candidates") / sha
    client = P("/opt/apps/eigengrid") / (version + "-" + sha[:12])
    head_link = P("/opt/eigengrid/current")
    client_link = P("/opt/apps/eigengrid/current")
    env_path = P("/etc/eigengrid/head.env")
    modules = P("/opt/modulefiles/eigengrid")
    new_module = modules / (version + ".lua")
    old_module = modules / (plan["oldVersion"] + ".lua")
    default_module = modules / ".version"
    old_client = P(plan["oldClient"])
    old_head = P(plan["oldHead"])


def run(args, **kwargs):
    kwargs.setdefault("cwd", "/")
    return subprocess.run(
        args, text=True, capture_output=True, check=True, **kwargs
    ).stdout


def digest(path):
    with P(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write(path, text, mode=0o644):
    path = P(path)
    temp = path.with_name(path.name + ".install-next")
    with temp.open("x") as stream:
        stream.write(text)
    temp.chmod(mode)
    os.replace(temp, path)


def link(path, target):
    temp = path.with_name(path.name + ".install-next")
    temp.symlink_to(target)
    os.replace(temp, path)


def state():
    values = run(
        [
            "systemctl",
            "show",
            "eigengrid-head",
            "-p",
            "MainPID",
            "-p",
            "NRestarts",
            "-p",
            "ActiveState",
            "-p",
            "SubState",
            "-p",
            "InvocationID",
        ]
    )
    return dict(line.split("=", 1) for line in values.splitlines())


def migrations():
    return json.loads(
        run(
            [
                "sudo",
                "-n",
                "-u",
                "postgres",
                "psql",
                "-d",
                "eigengrid",
                "-Atc",
                "SELECT json_agg(t ORDER BY version) FROM (SELECT version,name,checksum FROM _migrations) t",
            ]
        )
    )


def check_previous():
    assert head_link.resolve() == old_head
    assert client_link.resolve() == old_client
    assert digest(old_head / "bin/eigengrid-head") == plan["oldHeadHash"]
    assert digest(old_client / "libexec/eigengrid") == plan["oldClientHash"]
    assert migrations() == plan["migrations"]
    assert "--dispatch-disabled" in run(
        ["systemctl", "show", "eigengrid-head", "-p", "ExecStart"]
    )
    assert state()["ActiveState"] == "active"


def extract_archive(archive, stage):
    with tarfile.open(archive) as stream:
        members = stream.getmembers()
        top = "eigengrid-" + version + "-linux-x64"
        assert len(members) <= 10000 and sum(e.size for e in members) <= 2 * 1024**3
        assert len({e.name for e in members}) == len(members)
        for entry in members:
            assert P(entry.name).as_posix() == entry.name.rstrip("/")
            parts = P(entry.name).parts
            assert (
                parts[0] == top
                and ".." not in parts
                and not P(entry.name).is_absolute()
            )
            assert entry.isfile() or entry.isdir()
        stream.extractall(stage, filter="data")
    return stage / top


CATALOG_ENV = "EIGENGRID_SCIENTIFIC_SKILLS_ROOT"


def catalog_selection(wrapper, module, explicit=None):
    """Read generated literals, never source shell/Lua configuration as root."""
    values = []
    for text, pattern in [
        (wrapper, r':\s+"\$\{' + CATALOG_ENV + r':=([^}]+)\}"'),
        (module, r'setenv\(\s*"' + CATALOG_ENV + r'"\s*,\s*"([^"]+)"\s*\)'),
    ]:
        found = []
        for line in text.splitlines():
            line = line.strip()
            if (
                not line
                or line.startswith(("#", "--"))
                or CATALOG_ENV not in line
                or line == "export " + CATALOG_ENV
            ):
                continue
            match = re.fullmatch(pattern, line)
            if not match:
                raise ValueError(
                    "Unsupported scientific catalog selection; use a literal site path"
                )
            found.append(match.group(1))
        if len(found) > 1:
            raise ValueError("Duplicate scientific catalog selection")
        values.extend(found)
    if explicit is not None:
        values.append(explicit)
    if not values:
        return None
    if any(value != values[0] for value in values):
        raise ValueError("Conflicting scientific catalog selections")
    root = values[0]
    # These literals are emitted into both shell parameter defaults and Lua strings.
    if not isinstance(root, str) or not re.fullmatch(
        r"/(?:[A-Za-z0-9_.-]+/)*[A-Za-z0-9_.-]+", root
    ):
        raise ValueError(
            "Scientific catalog must use a literal absolute path without shell syntax"
        )
    if ".." in P(root).parts or not P(root).is_dir():
        raise ValueError("Scientific catalog directory is unavailable")
    if not any(P(root).rglob("skill.yaml")):
        raise ValueError("Scientific catalog has no manifests")
    return root


def selected_catalog():
    return catalog_selection(
        (old_client / "bin/eigengrid").read_text(),
        old_module.read_text(),
        plan.get("scientificSkillsRoot"),
    )


def client_wrapper(root):
    selection = (
        ': "${' + CATALOG_ENV + ":=" + root + '}"\nexport ' + CATALOG_ENV + "\n"
        if root
        else ""
    )
    return (
        '#!/bin/sh\numask 077\n: "${EIGENGRID_PYTHON:='
        + str(client / "bin/eigengrid-python")
        + '}"\n: "${EIGENGRID_CLUSTER_PROFILE:='
        + str(client / "cluster-profile.json")
        + '}"\nexport EIGENGRID_PYTHON EIGENGRID_CLUSTER_PROFILE\n'
        + selection
        + "exec "
        + str(client / "libexec/eigengrid")
        + ' "$@"\n'
    )


def client_module(root):
    return (
        'help([[EigenGrid shared client with live Slurm inventory.]])\nwhatis("EigenGrid '
        + version
        + '")\nconflict("eigengrid")\nprepend_path("PATH", "'
        + str(client / "bin")
        + '")\nsetenv("EIGENGRID_PYTHON", "'
        + str(client / "bin/eigengrid-python")
        + '")\nsetenv("EIGENGRID_CLUSTER_PROFILE", "'
        + str(client / "cluster-profile.json")
        + '")\n'
        + ('setenv("' + CATALOG_ENV + '", "' + root + '")\n' if root else "")
    )


def catalog_status(root=None):
    output = json.loads(
        run(
            [
                "sudo",
                "-n",
                "-H",
                "-u",
                plan["probeUser"],
                "env",
                "-u",
                CATALOG_ENV,
                "-u",
                "EIGENGRID_RETRIEVAL_CONFIG",
                str(client / "bin/eigengrid"),
                "retrieval",
                "status",
                *(["--corpus", root] if root else []),
            ],
            timeout=60,
        )
    )
    if not re.fullmatch(r"[0-9a-f]{64}", output["corpusDigest"]):
        raise ValueError("Invalid scientific catalog digest")
    for key in ("skills", "fragments", "documents"):
        if type(output[key]) is not int or output[key] < 1:
            raise ValueError("Empty or invalid scientific catalog")
    return {
        key: output[key] for key in ("corpusDigest", "skills", "fragments", "documents")
    }


def check_catalog(before, receipt=None):
    assert digest(old_client / "bin/eigengrid") == before["oldClientWrapperSha256"]
    assert digest(old_module) == before["oldModuleSha256"]
    root = before["scientificSkillsRoot"]
    assert selected_catalog() == root
    if receipt:
        assert digest(client / "bin/eigengrid") == receipt["clientWrapperSha256"]
    observed = catalog_status()
    if root and observed != catalog_status(root):
        raise ValueError("Candidate wrapper lost the selected scientific catalog")
    expected = plan.get("scientificCatalogDigest")
    if expected and observed["corpusDigest"] != expected:
        raise ValueError("Scientific catalog does not match the installation plan")
    result = {"root": root, **observed}
    if receipt and result != receipt["scientificCatalog"]:
        raise ValueError("Scientific catalog changed after preparation")
    return result


def prepare():
    check_previous()
    scientific_root = selected_catalog()
    assert not backup.exists() and not candidate.exists() and not client.exists()
    assert not new_module.exists()
    assert not (modules / ".modulerc.lua").exists()
    archive = incoming / plan["archive"]
    assert digest(archive) == plan["archiveSha256"]
    backup.mkdir(mode=0o700)
    before = {
        "head": str(old_head),
        "client": str(old_client),
        "service": state(),
        "headEnvironmentSha256": digest(env_path),
        "unitSha256": digest("/etc/systemd/system/eigengrid-head.service"),
        "apparmorSha256": digest("/etc/apparmor.d/eigengrid-head"),
        "oldModuleSha256": digest(old_module),
        "oldClientWrapperSha256": digest(old_client / "bin/eigengrid"),
        "scientificSkillsRoot": scientific_root,
        "defaultModuleSha256": digest(default_module),
        "migrations": migrations(),
    }
    (backup / "before.json").write_text(json.dumps(before, indent=2) + "\n")
    for source, name in [
        (env_path, "head.env"),
        (old_module, "previous-module.lua"),
        (old_client / "bin/eigengrid", "previous-client.sh"),
        (P("/etc/systemd/system/eigengrid-head.service"), "head.service"),
        (P("/etc/apparmor.d/eigengrid-head"), "head.apparmor"),
        (default_module, "previous-default"),
    ]:
        shutil.copy2(source, backup / name)
        (backup / name).chmod(0o600)
    with (backup / "eigengrid.dump").open("wb") as stream:
        subprocess.run(
            [
                "sudo",
                "-n",
                "-u",
                "postgres",
                "pg_dump",
                "--format=custom",
                "--dbname=eigengrid",
            ],
            stdout=stream,
            check=True,
            timeout=120,
        )
    run(["pg_restore", "--list", str(backup / "eigengrid.dump")], timeout=30)
    shutil.copy2(incoming / "installation-plan.json", backup / "installation-plan.json")
    shutil.copy2(__file__, backup / "install.py")
    stage = backup / "package"
    stage.mkdir(mode=0o700)
    extracted = extract_archive(archive, stage)
    distribution = json.loads((extracted / "distribution.json").read_text())
    assert distribution["sourceCommit"] == sha and distribution["version"] == version
    for item in distribution["files"]:
        assert not P(item["path"]).is_absolute() and ".." not in P(item["path"]).parts
        assert item["mode"] in {0o644, 0o755}
        path = extracted / item["path"]
        assert path.is_file() and not path.is_symlink()
        assert (
            path.stat().st_size == item["sizeBytes"] and digest(path) == item["sha256"]
        )
        assert path.stat().st_mode & 0o777 == item["mode"]
    shutil.move(extracted, candidate)
    candidate.chmod(0o755)
    for path in candidate.rglob("*"):
        if path.is_dir():
            path.chmod(0o755)
    client.mkdir(mode=0o755)
    for name in ["share", "python", "notices"]:
        shutil.copytree(candidate / name, client / name)
    for name in ["LICENSE", "distribution.json", "release.json"]:
        shutil.copy2(candidate / name, client / name)
    (client / "libexec").mkdir(mode=0o755)
    (client / "bin").mkdir(mode=0o755)
    shutil.copy2(candidate / "bin/eigengrid", client / "libexec/eigengrid")
    shutil.copytree(old_client / "venv", client / "venv", symlinks=True)
    for path in [client / "venv/pyvenv.cfg", *(client / "venv/bin").iterdir()]:
        if path.is_symlink() or not path.is_file():
            continue
        try:
            text = path.read_text()
        except UnicodeDecodeError:
            continue
        replacement = text.replace(str(old_client), str(client))
        if replacement != text:
            write(path, replacement, path.stat().st_mode & 0o777)
    python = str(client / "venv/bin/python3")
    wheel = next((client / "python").glob("*.whl"))
    client.chmod(0o755)
    run(["chown", "-R", plan["probeUser"], str(client / "venv")])
    try:
        output = run(
            [
                "sudo",
                "-n",
                "-H",
                "-u",
                plan["probeUser"],
                python,
                "-I",
                "-m",
                "pip",
                "install",
                "--no-index",
                "--no-deps",
                "--no-compile",
                "--force-reinstall",
                str(wheel),
            ],
            timeout=60,
        )
    finally:
        run(["chown", "-R", "root:root", str(client / "venv")])
    (backup / "wheel-install.log").write_text(output)
    for path in (client / "venv").rglob("*"):
        if not path.is_symlink():
            path.chmod(0o755 if path.is_dir() or path.stat().st_mode & 0o111 else 0o644)
    run(
        [
            "sudo",
            "-n",
            "-H",
            "-u",
            plan["probeUser"],
            python,
            "-I",
            "-m",
            "pip",
            "check",
        ],
        timeout=30,
    )
    run(
        [
            "sudo",
            "-n",
            "-H",
            "-u",
            plan["probeUser"],
            python,
            "-I",
            "-c",
            "import eigengrid_chem; assert eigengrid_chem.__version__ == "
            + repr(version.replace("-rc.", "rc")),
        ],
        timeout=30,
    )
    shutil.copy2(old_client / "cluster-profile.json", client / "cluster-profile.json")
    write(
        client / "bin/eigengrid-python",
        "#!/bin/sh\nexec " + python + ' -I "$@"\n',
        0o755,
    )
    write(
        client / "bin/eigengrid",
        client_wrapper(scientific_root),
        0o755,
    )
    finish_prepare()


def finish_prepare():
    check_previous()
    before = json.loads((backup / "before.json").read_text())
    assert digest(env_path) == before["headEnvironmentSha256"]
    distribution = json.loads((candidate / "distribution.json").read_text())
    assert distribution["sourceCommit"] == sha
    for item in distribution["files"]:
        assert digest(candidate / item["path"]) == item["sha256"]
    assert digest(client / "libexec/eigengrid") == digest(candidate / "bin/eigengrid")
    client.chmod(0o755)
    for path in client.rglob("*"):
        if path.is_symlink():
            continue
        path.chmod(0o755 if path.is_dir() or path.stat().st_mode & 0o111 else 0o644)
    python = str(client / "venv/bin/python3")
    assert (
        run(
            [
                "sudo",
                "-n",
                "-H",
                "-u",
                plan["probeUser"],
                str(client / "bin/eigengrid"),
                "--version",
            ]
        ).strip()
        == version
    )
    scientific_catalog = check_catalog(before)
    observation = json.loads(
        run(
            [
                "sudo",
                "-n",
                "-H",
                "-u",
                plan["probeUser"],
                str(client / "bin/eigengrid"),
                "cluster",
                "status",
                "--json",
            ],
            timeout=30,
        )
    )
    assert {n["name"] for n in observation["nodes"]} == set(plan["expectedNodes"])
    assert (
        observation["readOnly"] is True
        and observation["scientificDispatchQualified"] is False
    )
    # Exercise one standby tick with the installed unit's existing confinement.
    unit = (backup / "head.service").read_text()
    service = unit.split("[Service]\n", 1)[1].split("\n[", 1)[0]
    properties = []
    for line in service.splitlines():
        if not line or line.startswith("#") or "=" not in line:
            continue
        key = line.split("=", 1)[0]
        if key not in {
            "Type",
            "ExecStart",
            "Restart",
            "RestartSec",
            "StandardOutput",
            "StandardError",
        }:
            properties.extend(["--property", line])
    probe = subprocess.run(
        [
            "systemd-run",
            "--quiet",
            "--wait",
            "--pipe",
            "--collect",
            "--unit=eigengrid-install-check-" + sha[:12],
            *properties,
            str(candidate / "bin/eigengrid-head"),
            "--once",
            "--dispatch-disabled",
            "--owner-id",
            "installation-check",
        ],
        capture_output=True,
        text=True,
        check=False,
        timeout=60,
    )
    (backup / "candidate-check.log").write_text(probe.stdout + probe.stderr)
    assert probe.returncode == 0, (
        "Candidate confinement check failed; see private backup log"
    )
    events = [
        json.loads(line) for line in probe.stdout.splitlines() if line.startswith("{")
    ]
    assert any(
        e.get("event") == "scientific_head_standby"
        and e.get("databaseSchema") == 22
        and e.get("dispatchEnabled") is False
        for e in events
    )
    assert state() == before["service"]
    check_previous()
    receipt = {
        "preparedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "version": version,
        "sourceCommit": sha,
        "candidate": str(candidate),
        "client": str(client),
        "backup": str(backup),
        "archiveSha256": plan["archiveSha256"],
        "headBinarySha256": digest(candidate / "bin/eigengrid-head"),
        "clientBinarySha256": digest(client / "libexec/eigengrid"),
        "clientWrapperSha256": digest(client / "bin/eigengrid"),
        "scientificCatalog": scientific_catalog,
        "pythonVersion": run([python, "--version"]).strip(),
        "clusterNodes": [n["name"] for n in observation["nodes"]],
        "schemaVersion": 22,
        "dispatchEnabled": False,
    }
    write(client / "installation.json", json.dumps(receipt, indent=2) + "\n")
    (backup / "prepared.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt, indent=2), flush=True)


def activate():
    check_previous()
    receipt = json.loads((backup / "prepared.json").read_text())
    before = json.loads((backup / "before.json").read_text())
    assert digest(env_path) == before["headEnvironmentSha256"]
    assert digest(old_module) == before["oldModuleSha256"]
    assert digest(default_module) == before["defaultModuleSha256"]
    assert digest(candidate / "bin/eigengrid-head") == receipt["headBinarySha256"]
    assert digest(client / "libexec/eigengrid") == receipt["clientBinarySha256"]
    assert not new_module.exists()
    check_catalog(before, receipt)
    old_env = env_path.read_text()
    lines = old_env.splitlines()
    assert sum(line.startswith("EIGENGRID_RELEASE_COMMIT=") for line in lines) == 1
    new_env = (
        "\n".join(
            "EIGENGRID_RELEASE_COMMIT=" + sha
            if line.startswith("EIGENGRID_RELEASE_COMMIT=")
            else line
            for line in lines
        )
        + "\n"
    )
    try:
        write(
            new_module,
            client_module(before["scientificSkillsRoot"]),
        )
        write(
            old_module,
            (backup / "previous-module.lua")
            .read_text()
            .replace("/opt/apps/eigengrid/current", str(old_client)),
        )
        write(default_module, '#%Module1.0\nset ModulesVersion "' + version + '"\n')
        link(client_link, client.name)
        write(env_path, new_env, 0o600)
        link(head_link, candidate)
        run(["systemctl", "restart", "eigengrid-head"], timeout=60)
        ready = None
        for _ in range(12):
            observed = state()
            if observed["ActiveState"] == "active" and int(observed["MainPID"]) > 0:
                logs = run(
                    [
                        "journalctl",
                        "--no-pager",
                        "-o",
                        "cat",
                        "_SYSTEMD_INVOCATION_ID=" + observed["InvocationID"],
                    ]
                )
                events = [
                    json.loads(line)
                    for line in logs.splitlines()
                    if line.startswith("{")
                ]
                if any(
                    e.get("event") == "scientific_head_dispatch_disabled"
                    and e.get("releaseCommit") == sha
                    and e.get("version") == version
                    for e in events
                ) and any(
                    e.get("event") == "scientific_head_standby"
                    and e.get("databaseSchema") == 22
                    and e.get("dispatchEnabled") is False
                    for e in events
                ):
                    ready = observed
                    break
            time.sleep(1)
        assert ready is not None, "Head did not reach the expected standby state"
        assert (
            digest(P("/proc") / ready["MainPID"] / "exe") == receipt["headBinarySha256"]
        )
        assert (
            "eigengrid-head (enforce)"
            in (P("/proc") / ready["MainPID"] / "attr/current").read_text()
        )
        assert migrations() == plan["migrations"]
        assert run(["/usr/local/bin/eigengrid", "--version"]).strip() == version
    except BaseException:
        link(client_link, old_client.name)
        link(head_link, old_head)
        write(env_path, old_env, 0o600)
        write(old_module, (backup / "previous-module.lua").read_text())
        new_module.unlink(missing_ok=True)
        write(default_module, (backup / "previous-default").read_text())
        run(["systemctl", "restart", "eigengrid-head"], timeout=60)
        raise
    receipt.update(
        {
            "activatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "service": ready,
            "apparmor": "eigengrid-head (enforce)",
            "previousClient": str(old_client),
            "previousHead": str(old_head),
        }
    )
    (backup / "activated.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt, indent=2), flush=True)


def main():
    assert os.geteuid() == 0
    os.umask(0o077)
    if len(sys.argv) != 3 or sys.argv[2] not in {"prepare", "activate"}:
        raise SystemExit("Usage: install.py STAGING_DIRECTORY prepare|activate")
    configure(sys.argv[1])
    if sys.argv[2] == "prepare":
        prepare()
    else:
        activate()


if __name__ == "__main__":
    main()
