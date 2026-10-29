"""Closed subprocess entry point for the Head's CAS inspection adapter.

The application copies one authorized CAS object into its private temporary
directory. Limits are set before parsing any artifact bytes; this worker never
executes Amber and never assigns a scientific verdict.
"""

from __future__ import annotations

import json
import resource
import sys

from .inspection import inspect_amber_artifact, parse_amber_minimization_mdout


def main() -> None:
    if len(sys.argv) != 5 or sys.argv[1] not in {"prmtop", "restart", "trajectory", "minimization"}:
        raise SystemExit("Expected kind, private artifact path, memory bytes and CPU seconds")
    memory, cpu = int(sys.argv[3]), int(sys.argv[4])
    if not 64 * 1024 * 1024 <= memory <= 8 * 1024**3 or not 1 <= cpu <= 600:
        raise SystemExit("Inspection limits outside supported range")
    resource.setrlimit(resource.RLIMIT_AS, (memory, memory))
    resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
    observed = (
        parse_amber_minimization_mdout(sys.argv[2])
        if sys.argv[1] == "minimization"
        else inspect_amber_artifact(sys.argv[2], sys.argv[1])
    )
    print(json.dumps(observed, allow_nan=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
