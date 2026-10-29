"""CP2K output file parser.

Extracts data from CP2K output files using pure regex (no cclib dependency).
Handles single-point energy, SCF convergence, method/basis info, and timing.
"""

from __future__ import annotations

import re
from datetime import datetime

from eigengrid_chem.protocol import (
    ParseError,
    ParseResult,
    ParseResultData,
)


def parse_cp2k(log_path: str) -> dict:
    """Parse a CP2K output file and return a ParseResult-compatible dict."""
    try:
        with open(log_path) as f:
            text = f.read()
    except FileNotFoundError:
        return ParseResult(
            ok=False,
            parser="cp2k",
            status="failed",
            error=ParseError(
                code="FILE_NOT_FOUND",
                message=f"File not found: {log_path}",
                hint="Check the output path",
            ),
        ).model_dump()

    # -- Termination -------------------------------------------
    normal_termination = "PROGRAM ENDED AT" in text
    error_termination = "PROGRAM STOPPED" in text and not normal_termination

    # -- SCF convergence ---------------------------------------
    scf_converged = "SCF run converged" in text
    errors: list[str] = []
    warnings: list[str] = []

    if "SCF run NOT converged" in text:
        errors.append("SCF did not converge")
        scf_converged = False

    # -- Energy ------------------------------------------------
    energy_hartree: float | None = None
    energy_matches = re.findall(
        r"ENERGY\| Total FORCE_EVAL.*?\[Hartree\]\s*:\s*([-\d.]+)",
        text,
    )
    if energy_matches:
        energy_hartree = float(energy_matches[-1])

    # -- Method ------------------------------------------------
    method: str | None = None
    func_m = re.search(r"FUNCTIONAL\s+(\S+)", text) or re.search(
        r"DFT\|\s+Functional:\s+(\S+)", text
    )
    if func_m:
        method = func_m.group(1)

    spin_channels = re.search(r"Number of spin channels:\s+(\d+)", text)
    if method:
        if spin_channels and spin_channels.group(1) == "2":
            method = f"UKS-{method}"
        else:
            method = f"RKS-{method}"

    # -- Basis ------------------------------------------------
    basis: str | None = None
    basis_m = re.search(r"BASIS_SET\|\s+Basis set:\s+(\S+)", text)
    if not basis_m:
        basis_m = re.search(r"Basis set\s*:\s*(\S+)", text)
    if basis_m:
        basis = basis_m.group(1)

    # -- Timing ------------------------------------------------
    wall_time_seconds: float | None = None
    started_m = re.search(r"PROGRAM STARTED AT\s+(.+)", text)
    ended_m = re.search(r"PROGRAM ENDED AT\s+(.+)", text)
    if started_m and ended_m:
        try:
            fmt = "%Y-%m-%d %H:%M:%S"
            started = datetime.strptime(started_m.group(1).strip(), fmt)
            ended = datetime.strptime(ended_m.group(1).strip(), fmt)
            wall_time_seconds = (ended - started).total_seconds()
        except ValueError:
            pass

    cpu_time_seconds = wall_time_seconds

    # -- Status ------------------------------------------------
    if normal_termination:
        status = "completed"
    elif error_termination:
        status = "failed"
    else:
        status = "completed" if energy_hartree is not None else "partial"

    data = ParseResultData(
        normal_termination=normal_termination,
        scf_converged=scf_converged,
        energy_hartree=energy_hartree,
        method=method,
        basis=basis,
        charge=None,
        multiplicity=None,
        geometry=None,
        frequencies=None,
        imaginary_frequencies=None,
        thermochemistry=None,
        scf_iterations=None,
        cpu_time_seconds=cpu_time_seconds,
        wall_time_seconds=wall_time_seconds,
        warnings=warnings,
        errors=errors,
        raw=None,
    )

    return ParseResult(
        ok=True,
        parser="cp2k",
        status=status,
        data=data,
    ).model_dump()
