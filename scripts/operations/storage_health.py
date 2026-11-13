#!/usr/bin/env python3
"""Read-only storage admission check; no cleanup and no implicit mount creation."""

import argparse
import json
import os
import shutil
import sys


def inspect(path, *, max_used_percent, min_free_gib, require_data_mount=False):
    errors = []
    try:
        stat = os.stat(path)
        usage = shutil.disk_usage(path)
        percent = 100 * usage.used / (usage.used + usage.free)
        if percent >= max_used_percent:
            errors.append("capacity_threshold_exceeded")
        if usage.free < min_free_gib * 1024**3:
            errors.append("free_space_below_reserve")
        if require_data_mount:
            if not os.path.ismount(path):
                errors.append("required_mount_missing")
            if stat.st_dev == os.stat("/").st_dev:
                errors.append("data_on_root_filesystem")
        return {
            "path": path,
            "usedPercent": round(percent, 2),
            "availableBytes": usage.free,
            "errors": errors,
        }
    except OSError:
        return {"path": path, "errors": ["storage_unavailable"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-mount", action="append", required=True)
    args = parser.parse_args()
    checks = [inspect("/", max_used_percent=80, min_free_gib=10)]
    checks.extend(
        inspect(p, max_used_percent=85, min_free_gib=30, require_data_mount=True)
        for p in args.data_mount
    )
    ok = all(not c["errors"] for c in checks)
    print(json.dumps({"ok": ok, "checks": checks}))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
