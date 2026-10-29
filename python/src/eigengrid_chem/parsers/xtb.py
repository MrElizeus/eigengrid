"""xTB output file parser.

Extracts data from GFN1-xTB / GFN2-xTB / GFN-FF output files using
pure regex. xTB does NOT use cclib and its output is much terser than
Gaussian or ORCA.

Usage:
    from parsers.xtb import parse_xtb
    result = parse_xtb("path/to/xtb.out")
"""

from __future__ import annotations

import re

from ..protocol import (
    ParseError,
    ParseResult,
    ParseResultData,
)


def parse_xtb(log_path: str) -> dict:
    """Parse an xTB output file and return a ``ParseResult.model_dump()`` dict.

    Parameters
    ----------
    log_path : str
        Path to the xTB output (.out) file.

    Returns
    -------
    dict
        Serialised ``ParseResult`` -- can be round-tripped through JSON.
    """
    try:
        with open(log_path) as f:
            text = f.read()
    except FileNotFoundError:
        return ParseResult(
            ok=False,
            parser="xtb",
            status="failed",
            error=ParseError(
                code="FILE_NOT_FOUND",
                message=f"File not found: {log_path}",
                hint="Check the output path",
            ),
        ).model_dump()

    # -- Termination ------------------------------------------
    normal_term = "normal termination of xtb" in text

    # -- Method -----------------------------------------------
    method_m = re.search(r"Method:\s+(.+)", text)
    method = method_m.group(1).strip() if method_m else None

    # -- Total energy (LAST occurrence -- freq runs print twice) -
    energy_matches = re.findall(r"TOTAL ENERGY\s*=\s*([-\d.]+)\s*Eh", text)
    energy = float(energy_matches[-1]) if energy_matches else None

    scf_conv = normal_term and energy is not None
    status = "completed" if normal_term else "failed"

    # -- Geometry -- parse XYZ block after final marker ---------
    geometry = None
    geo_marker = re.search(r"final structure written to xtbopt\.xyz", text)
    if geo_marker:
        rest = text[geo_marker.end() :]
        natoms: int | None = None
        comment: str | None = None
        atoms: list[dict] = []
        parsing = False
        for line in rest.splitlines():
            s = line.strip()
            if parsing and (not s or s.startswith("=")):
                break
            if not s or s.startswith("="):
                continue
            if natoms is None:
                try:
                    natoms = int(s)
                    parsing = True
                except ValueError:
                    pass
                continue
            if comment is None:
                comment = s
                continue
            parts = s.split()
            if len(parts) >= 4:
                try:
                    atoms.append(
                        {
                            "element": parts[0],
                            "x": float(parts[1]),
                            "y": float(parts[2]),
                            "z": float(parts[3]),
                        }
                    )
                except ValueError:
                    break
            if natoms is not None and len(atoms) >= natoms:
                break
        if atoms:
            geometry = atoms

    # -- Vibrational frequencies ------------------------------
    frequencies = None
    freq_section = re.search(
        r"VIBRATIONAL FREQUENCIES\s*\n"
        r"\s*mode\s+freq\(cm\^\-1\)\s+int\.\(km/mol\)\s*\n"
        r"((?:\s*\d+\s+[-\d.]+\s+[-\d.].*\n?)+)",
        text,
    )
    if freq_section:
        raw_lines = freq_section.group(1).strip().splitlines()
        frequencies = []
        for line in raw_lines:
            parts = line.split()
            if len(parts) >= 3:
                try:
                    frequencies.append(
                        {
                            "value": float(parts[1]),
                            "ir_intensity": float(parts[2]),
                        }
                    )
                except ValueError:
                    continue

    imaginary_freqs: int | None = None
    if frequencies:
        imaginary_freqs = sum(1 for f in frequencies if f["value"] < -10.0)

    # -- Timing -----------------------------------------------
    cpu_m = re.search(r"CPU time:\s+([-\d.]+)\s+seconds", text)
    wall_m = re.search(r"Wall time:\s+([-\d.]+)\s+seconds", text)

    result = ParseResult(
        ok=normal_term,
        parser="xtb",
        status=status,
        data=ParseResultData(
            normal_termination=normal_term,
            scf_converged=scf_conv,
            energy_hartree=energy,
            method=method,
            basis=None,
            charge=None,
            multiplicity=None,
            geometry=geometry,
            frequencies=frequencies,
            imaginary_frequencies=imaginary_freqs,
            thermochemistry=None,
            scf_iterations=None,
            cpu_time_seconds=float(cpu_m.group(1)) if cpu_m else None,
            wall_time_seconds=float(wall_m.group(1)) if wall_m else None,
        ),
    )

    return result.model_dump()
