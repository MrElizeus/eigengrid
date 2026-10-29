#!/usr/bin/env python3
"""Promote validated public releases using a separately installed, trusted installer."""

import argparse
import fcntl
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.parse
import urllib.request
from pathlib import Path

RELEASE_TAG = re.compile(r"v1\.0\.0-rc\.([1-9]\d*)\Z")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def revision(tag):
    match = RELEASE_TAG.fullmatch(tag)
    require(match is not None, "Unsupported release series")
    return int(match[1])


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def request(url, limit, destination=None):
    require(url.startswith("https://"), "HTTPS is required")
    headers = {
        "User-Agent": "eigengrid-release-controller",
        "Accept": "application/vnd.github+json",
    }
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=60) as response:
        require(response.url.startswith("https://"), "Insecure download redirect")
        if destination is None:
            data = response.read(limit + 1)
            require(len(data) <= limit, "Response exceeds size limit")
            return json.loads(data)
        with Path(destination).open("xb") as output:
            total = 0
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                require(total <= limit, "Asset exceeds size limit")
                output.write(chunk)


def asset(release, name, repository):
    matches = [
        a for a in release["assets"] if a["name"] == name and a["state"] == "uploaded"
    ]
    require(len(matches) == 1, "Release asset is missing or ambiguous: " + name)
    result = matches[0]
    expected = f"https://github.com/{repository}/releases/download/{release['tag_name']}/{name}"
    require(
        result["browser_download_url"] == expected, "Unexpected release asset origin"
    )
    require(
        re.fullmatch(r"sha256:[a-f0-9]{64}", result.get("digest") or ""),
        "Asset digest is required",
    )
    return result


def download(release, name, repository, target, limit):
    info = asset(release, name, repository)
    require(0 < info["size"] <= limit, "Invalid asset size")
    request(info["browser_download_url"], limit, target)
    require(target.stat().st_size == info["size"], "Downloaded size mismatch")
    require("sha256:" + digest(target) == info["digest"], "Downloaded digest mismatch")


def validate_identity(validation, release, run, repository_id, tag_commit):
    tag = release["tag_name"]
    revision(tag)
    require(not release["draft"], "Draft releases cannot deploy")
    require(
        validation["schemaVersion"] == "eigengrid.release-validation/v1",
        "Unknown validation schema",
    )
    require(
        validation["repositoryId"] == repository_id == run["repository"]["id"],
        "Repository identity mismatch",
    )
    require(validation["tag"] == tag, "Tag mismatch")
    require(
        re.fullmatch(r"[a-f0-9]{40}", validation["sourceCommit"]),
        "Invalid source commit",
    )
    require(
        validation["sourceCommit"] == tag_commit == run["head_sha"],
        "Source commit mismatch",
    )
    require(run["id"] == validation["runId"], "CI run identity mismatch")
    require(
        run["event"] == "push" and run["path"] == ".github/workflows/ci.yml",
        "Unexpected validation workflow",
    )
    require(
        run["status"] == "completed" and run["conclusion"] == "success",
        "Release CI has not succeeded",
    )
    require(
        validation["archive"] == f"eigengrid-{tag[1:]}-linux-x64.tar.gz",
        "Archive name mismatch",
    )
    for key in ["archiveSha256", "manifestSha256"]:
        require(
            re.fullmatch(r"[a-f0-9]{64}", validation[key]), "Invalid validation digest"
        )


def run(args, **kwargs):
    return subprocess.check_output(args, text=True, **kwargs).strip()


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


def poll(config, check_only=False):
    repository = config["repository"]
    require(
        re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository),
        "Invalid repository",
    )
    api = "https://api.github.com/repos/" + repository
    metadata = request(api, 1024 * 1024)
    require(
        metadata["id"] == config["repositoryId"] and not metadata["private"],
        "Repository was replaced or is private",
    )
    client = Path("/opt/apps/eigengrid/current").resolve(strict=True)
    installed = json.loads((client / "installation.json").read_text())
    installed_revision = revision("v" + installed["version"])
    releases = request(api + "/releases?per_page=100", 4 * 1024 * 1024)
    candidates = [
        r
        for r in releases
        if not r["draft"]
        and RELEASE_TAG.fullmatch(r["tag_name"])
        and revision(r["tag_name"]) > installed_revision
    ]
    if not candidates:
        print(
            json.dumps(
                {"event": "release_poll_current", "version": installed["version"]}
            )
        )
        return
    release = max(candidates, key=lambda r: revision(r["tag_name"]))
    state = Path(config["stateDirectory"])
    stage = state / release["tag_name"]
    if stage.exists():
        require(
            not (stage / "installation-plan.json").exists(),
            "Previous installation needs operator review",
        )
        shutil.rmtree(stage)
    stage.mkdir(mode=0o700)
    download(
        release, "validation.json", repository, stage / "validation.json", 1024 * 1024
    )
    validation = json.loads((stage / "validation.json").read_text())
    require(
        isinstance(validation.get("runId"), int) and validation["runId"] > 0,
        "Invalid CI run ID",
    )
    workflow = request(
        api + "/actions/runs/" + str(validation["runId"]), 2 * 1024 * 1024
    )
    commit = request(api + "/commits/" + release["tag_name"], 4 * 1024 * 1024)["sha"]
    validate_identity(validation, release, workflow, config["repositoryId"], commit)
    comparison = request(
        api + "/compare/" + commit + "...main?per_page=1", 4 * 1024 * 1024
    )
    require(
        comparison["status"] in {"ahead", "identical"}, "Release source is not on main"
    )
    require(
        validation["migrations"] == migrations(),
        "Database migration review is required",
    )
    if check_only:
        print(
            json.dumps(
                {
                    "event": "release_eligible",
                    "tag": release["tag_name"],
                    "commit": commit,
                }
            )
        )
        return
    require(
        shutil.disk_usage(state).free > 4 * 1024**3, "Insufficient staging disk space"
    )
    download(
        release, "release.json", repository, stage / "release.json", 2 * 1024 * 1024
    )
    require(
        digest(stage / "release.json") == validation["manifestSha256"],
        "Manifest digest mismatch",
    )
    manifest = json.loads((stage / "release.json").read_text())
    require(
        manifest["sourceCommit"] == commit
        and manifest["version"] == release["tag_name"][1:],
        "Manifest identity mismatch",
    )
    archive = validation["archive"]
    download(release, archive, repository, stage / archive, 512 * 1024 * 1024)
    require(
        digest(stage / archive) == validation["archiveSha256"],
        "Archive digest mismatch",
    )
    head = Path("/opt/eigengrid/current").resolve(strict=True)
    plan = {
        "version": manifest["version"],
        "commit": commit,
        "archive": archive,
        "archiveSha256": validation["archiveSha256"],
        "oldClient": str(client),
        "oldHead": str(head),
        "oldClientHash": digest(client / "libexec/eigengrid"),
        "oldHeadHash": digest(head / "bin/eigengrid-head"),
        "oldVersion": installed["version"],
        "migrations": validation["migrations"],
        "probeUser": config["probeUser"],
        "expectedNodes": config["expectedNodes"],
    }
    (stage / "installation-plan.json").write_text(json.dumps(plan, indent=2) + "\n")
    installer = str(Path(__file__).with_name("install.py"))
    for action in ["prepare", "activate"]:
        subprocess.run(
            [sys.executable, installer, str(stage), action], check=True, timeout=300
        )
    (stage / "activated.json").write_text(
        json.dumps({"releaseId": release["id"], "commit": commit}) + "\n"
    )
    (stage / archive).unlink()
    print(
        json.dumps(
            {"event": "release_activated", "tag": release["tag_name"], "commit": commit}
        )
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="/etc/eigengrid/release-controller.json")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    require(os.geteuid() == 0, "Administrative service identity is required")
    os.umask(0o077)
    config = json.loads(Path(args.config).read_text())
    state = Path(config["stateDirectory"])
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (state / "controller.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        poll(config, args.check)


if __name__ == "__main__":
    main()
