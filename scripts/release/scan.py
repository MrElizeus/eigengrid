#!/usr/bin/env python3
"""Check release source, including unstaged work, for private/generated material."""
from pathlib import Path
import argparse
import hashlib
import json
import re
import subprocess
import sys

FORBIDDEN = {"artifacts", "spikes", "openspec", "node_modules", "dist", ".eigengrid", ".venv", "__pycache__"}
PATTERNS = {
    "private-key": rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=]{30,}",
    "github-token": rb"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b",
    "provider-token": rb"\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{40,}\b",
    "private-host": rb"(?i)(?:/home/eliseo(?:/|\b)|monsterqueen|inmobidev)",
    "retired-repository": rb"eigengrid-cli",
    "reserved-research": rb"(?i)(?:tryptamin|triptamin|5[ -]?ht2a|htr2a|psilocin|psilocyb|serotonin|\bDMT\b|6a94|9as7|9ary|7wc9|asp155|trp336|indolic)",
}


def source_paths(root: Path) -> list[Path]:
    if (root / ".git").exists():
        # Include new files before staging, and tolerate tracked deletions/renames.
        names = subprocess.check_output([
            "git", "-C", str(root), "ls-files", "--cached", "--others",
            "--exclude-standard", "-z",
        ]).split(b"\0")
        return sorted({root / name.decode() for name in names if name
                       and ((root / name.decode()).exists() or (root / name.decode()).is_symlink())})
    return sorted(p for p in root.rglob("*") if (p.is_file() or p.is_symlink()) and not any(
        part in {"node_modules", ".venv", "dist", "__pycache__", ".pytest_cache"}
        for part in p.relative_to(root).parts
    ))


def scan(root: Path) -> tuple[list[str], int]:
    root = root.resolve()
    paths = source_paths(root)
    errors = []
    for path in paths:
        relative = path.relative_to(root)
        if path.is_symlink() or relative.parts[0] in FORBIDDEN or path.stat().st_size > 2_000_000:
            errors.append(f"{relative}: forbidden entry or oversized source file")
            continue
        if relative.name in {"AGENTS.md", "CLAUDE.md"} or "HANDOFF" in relative.name or relative.suffix in {".sqlite", ".db", ".zip", ".whl"}:
            errors.append(f"{relative}: private/process/generated material")
        if re.search(r"(?:^|[-_])a[1-9](?:[-_.]|$)", relative.name):
            errors.append(f"{relative}: retired development-phase filename")
        if str(relative) == "scripts/release/scan.py":
            continue
        data = path.read_bytes()
        for name, pattern in PATTERNS.items():
            if re.search(pattern, data):
                errors.append(f"{relative}: {name}")
        if relative.name == "package.json":
            try:
                package = json.loads(data)
                repository = package.get("repository")
                if package.get("name", "").startswith("@eigengrid/") and repository:
                    url = repository.get("url", "") if isinstance(repository, dict) else repository
                    if url not in {"https://github.com/MrElizeus/eigengrid.git", "git+https://github.com/MrElizeus/eigengrid.git"}:
                        errors.append(f"{relative}: package repository differs from the canonical origin")
            except (ValueError, AttributeError):
                errors.append(f"{relative}: invalid package metadata")
    return errors, len(paths)


def publication_errors(root: Path) -> list[str]:
    """Public distribution is opt-in; missing or malformed policy never grants it."""
    try:
        policy = json.loads((root / "publication.json").read_text())
    except (OSError, ValueError):
        return ["Public distribution blocked: publication.json is missing or invalid"]
    if not isinstance(policy, dict) or policy.get("schemaVersion") != "eigengrid.publication-policy/v1":
        return ["Public distribution blocked: unsupported publication policy"]
    if policy.get("visibility") != "public":
        return ["Public distribution blocked: this source is designated private; review source, history and existing release artifacts before changing the policy"]
    try:
        lock = json.loads((root / "publication-catalog.json").read_text())
        expected = lock["files"]
        if lock.get("schemaVersion") != "eigengrid.public-catalog/v1" or not isinstance(expected, dict) or not expected:
            raise ValueError("Invalid catalog lock")
        if any(not isinstance(name, str) or not name.startswith("scientific-skills/") or ".." in Path(name).parts
               or not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest)
               for name, digest in expected.items()):
            raise ValueError("Invalid catalog entry")
        files = list((root / "scientific-skills").rglob("*"))
        if any(path.is_symlink() for path in files):
            return ["Public catalog contains a symlink"]
        actual = {path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
                  for path in files if path.is_file()}
        if actual != expected:
            return ["Public catalog differs from its reviewed file/hash allowlist"]
        directories = sorted(name.removeprefix("scientific-skills/").removesuffix("/skill.yaml").replace("/", ".")
                             for name in actual if name.endswith("/skill.yaml"))
        if directories != sorted(policy["catalogSkillIds"]):
            return ["Public catalog identities differ from publication policy"]
    except (OSError, ValueError, KeyError, TypeError):
        return ["Public distribution blocked: catalog allowlist is missing or invalid"]
    return []


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", nargs="?", default=".")
    parser.add_argument("--public", action="store_true", help="Require explicit public distribution policy")
    args = parser.parse_args()
    root = Path(args.root)
    errors, count = scan(root)
    if args.public:
        errors.extend(publication_errors(root))
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print(f"PASS: Source hygiene and high-confidence credential patterns across {count} files")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
