"""ORCA 6 output file parser."""

from __future__ import annotations

import re
from typing import Any

from eigengrid_chem.protocol import ParseResult, ParseResultData

_SCF_SUCCESS_PATTERNS = (
    re.compile(r"^[ \t]*\*{4}[ \t]+CONVERGENCE[ \t]+REACHED[ \t]+\*{4}[ \t]*$", re.IGNORECASE),
    re.compile(
        r"^[ \t]*\*+[ \t]+SCF[ \t]+CONVERGED[ \t]+AFTER[ \t]+\d+[ \t]+CYCLES?[ \t]+\*+[ \t]*$",
        re.IGNORECASE,
    ),
)
_SCF_FAILURE_PATTERN = re.compile(
    r"^[ \t]*(?:\*+[ \t]+)?SCF[ \t]+(?:NOT[ \t]+CONVERGED|DID[ \t]+NOT[ \t]+CONVERGE)"
    r"(?:[ \t]+AFTER[ \t]+\d+[ \t]+CYCLES?)?[ \t]*(?:\*+)?[ \t]*$",
    re.IGNORECASE,
)


def parse_orca(log_path: str) -> dict:
    """Parse an ORCA 6 output file and return structured JSON result."""
    try:
        with open(log_path) as f:
            text = f.read()
    except FileNotFoundError:
        return ParseResult(
            ok=False,
            parser="orca",
            status="failed",
            error={
                "code": "FILE_NOT_FOUND",
                "message": f"File not found: {log_path}",
                "hint": "Check the output path",
            },
        ).model_dump()

    lines = text.splitlines()
    warnings: list[str] = []
    errors: list[str] = []

    # -- Normal termination ----------------------------------
    normal_termination = "****ORCA TERMINATED NORMALLY****" in text
    error_termination = "ORCA TERMINATED WITH ERRORS" in text

    # -- SCF convergence -------------------------------------
    scf_converged = any(
        pattern.fullmatch(line) is not None for line in lines for pattern in _SCF_SUCCESS_PATTERNS
    )
    if any(_SCF_FAILURE_PATTERN.fullmatch(line) is not None for line in lines):
        scf_converged = False

    # -- Final energy ----------------------------------------
    energy_hartree: float | None = None
    number = r"([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?)"
    for pattern in (
        rf"FINAL SINGLE POINT ENERGY[ \t]+{number}",
        rf"ENERGY\s*=\s*{number}\s*Eh",
    ):
        matches = re.findall(pattern, text)
        if matches:
            energy_hartree = float(matches[-1])
            break

    # -- Method ----------------------------------------------
    method: str | None = None
    m = re.search(r"ORCA METHOD:\s*(.+)", text)
    if m:
        method = m.group(1).strip()

    # -- Basis -----------------------------------------------
    basis: str | None = None
    base_patterns = [
        r"def2-\w+(?:\([^)]*\))?",
        r"6-31[Ggd]+[+\w]*(?:\([^)]*\))?",
        r"cc-p[Vv][TtQq5-9][Zz][+\w]*(?:\([^)]*\))?",
        r"aug-cc-p[Vv][TtQq5-9][Zz][+\w]*(?:\([^)]*\))?",
        r"STO-[3-9]G",
        r"SVP",
        r"TZVP",
        r"TZVPP",
        r"QZVP",
    ]
    for pat in base_patterns:
        m = re.search(pat, text)
        if m:
            basis = m.group(0)
            break

    # -- Charge and multiplicity -----------------------------
    charge: int | None = None
    multiplicity: int | None = None
    m = re.search(r"Charge\s*=\s*(-?\d+)", text)
    if m:
        charge = int(m.group(1))
    m = re.search(r"Multiplicity\s*=\s*(\d+)", text)
    if m:
        multiplicity = int(m.group(1))

    # -- Geometry --------------------------------------------
    geometry = _parse_geometry(lines)
    geometry_converged = "THE OPTIMIZATION HAS CONVERGED" in text

    # -- Vibrational frequencies -----------------------------
    frequencies, imaginary_frequencies = _parse_frequencies(lines)

    # -- Thermochemistry -------------------------------------
    thermochemistry = _parse_thermochemistry(text)

    # -- SCF iterations --------------------------------------
    scf_iterations = _parse_scf_iterations(lines)

    # -- CPU / wall time -------------------------------------
    cpu_time_seconds = _parse_time_line(text, "TOTAL CPU TIME")
    wall_time_seconds = _parse_time_line(text, "TOTAL WALL TIME")

    # -- TD-DFT excitations ----------------------------------
    raw_values: dict[str, Any] = {}
    if geometry_converged:
        raw_values["geometryConverged"] = True
    if "TD-DFT/TDA EXCITED STATES" in text:
        exc = _parse_tddft(lines)
        if exc:
            raw_values["excitations"] = exc
    raw: dict[str, Any] | None = raw_values or None

    data = ParseResultData(
        normal_termination=normal_termination,
        scf_converged=scf_converged,
        energy_hartree=energy_hartree,
        method=method,
        basis=basis,
        charge=charge,
        multiplicity=multiplicity,
        geometry=geometry,
        frequencies=frequencies,
        imaginary_frequencies=imaginary_frequencies,
        thermochemistry=thermochemistry,
        scf_iterations=scf_iterations,
        cpu_time_seconds=cpu_time_seconds,
        wall_time_seconds=wall_time_seconds,
        warnings=warnings,
        errors=errors,
        raw=raw,
    )

    if normal_termination:
        status = "completed"
    elif error_termination:
        status = "failed"
    else:
        status = "completed" if energy_hartree is not None else "partial"

    return ParseResult(
        ok=True,
        parser="orca",
        status=status,
        data=data,
    ).model_dump()


# -- Section parsers -----------------------------------------


def _parse_geometry(lines: list[str]) -> list[dict[str, Any]] | None:
    latest_geometry: list[dict[str, Any]] | None = None
    for idx, line in enumerate(lines):
        if not re.match(
            r"\s*(?:CARTESIAN\s+)?COORDINATES\s*\(?ANGSTROEM\)?\s*",
            line,
        ):
            continue

        atoms: list[dict[str, Any]] = []
        j = idx + 1
        while j < len(lines):
            stripped = lines[j].strip()
            if not stripped or set(stripped) == {"-"}:
                if atoms:
                    break
                j += 1
                continue

            parts = stripped.split()
            try:
                atom = {
                    "element": parts[0],
                    "x": float(parts[1]),
                    "y": float(parts[2]),
                    "z": float(parts[3]),
                }
            except (IndexError, ValueError):
                if atoms:
                    break
                break
            atoms.append(atom)
            j += 1

        if atoms:
            latest_geometry = atoms

    return latest_geometry


def _parse_frequencies(lines: list[str]) -> tuple[list[dict[str, Any]] | None, int | None]:
    idx = None
    for i, line in enumerate(lines):
        if "VIBRATIONAL FREQUENCIES" in line:
            idx = i
            break
    if idx is None:
        return None, None

    j = idx + 1
    while j < len(lines) and ("---" in lines[j] or not lines[j].strip()):
        j += 1

    if j < len(lines) and "Mode" in lines[j]:
        j += 1
    if j < len(lines) and "cm" in lines[j]:
        j += 1

    freqs: list[dict[str, Any]] = []
    imag_count = 0
    while j < len(lines):
        line = lines[j].strip()
        if not line or "---" in line:
            break
        parts = line.split()
        if len(parts) >= 2:
            try:
                _ = int(parts[0])
                val = float(parts[1])
                ir = float(parts[2]) if len(parts) >= 3 else None
                entry: dict[str, Any] = {"value": val, "ir_intensity": ir}
                if len(parts) >= 4:
                    try:
                        entry["raman_activity"] = float(parts[3])
                    except ValueError:
                        pass
                freqs.append(entry)
                if val < -10.0:
                    imag_count += 1
            except (ValueError, IndexError):
                pass
        j += 1

    return freqs or None, imag_count if freqs else None


def _parse_thermochemistry(text: str) -> dict[str, Any] | None:
    thermo: dict[str, Any] = {}

    m = re.search(r"Zero-point energy:\s*([-\d.]+)\s*Eh", text)
    if m:
        thermo["ZPE_hartree"] = float(m.group(1))

    m = re.search(r"Entropy:\s*([-\d.]+)\s*cal/\(mol\*K\)", text)
    if m:
        thermo["entropy_calmol"] = float(m.group(1))

    m = re.search(r"Enthalpy correction:\s*([-\d.]+)\s*Eh", text)
    if m:
        thermo["enthalpy_hartree"] = float(m.group(1))

    m = re.search(r"Gibbs free energy correction:\s*([-\d.]+)\s*Eh", text)
    if m:
        thermo["gibbs_hartree"] = float(m.group(1))

    return thermo if thermo else None


def _parse_scf_iterations(lines: list[str]) -> list[dict[str, Any]] | None:
    idx = None
    for i, line in enumerate(lines):
        if re.match(r"\s*CYCLE\s+ENERGY\s+DELTA", line):
            idx = i
            break
    if idx is None:
        return None

    j = idx + 1
    while j < len(lines) and "---" in lines[j]:
        j += 1

    cycles: list[dict[str, Any]] = []
    while j < len(lines):
        line = lines[j].strip()
        if not line or "---" in line or "CONVERGENCE" in line:
            break
        parts = line.split()
        if len(parts) >= 2:
            try:
                cyc = int(parts[0])
                energy = float(parts[1])
                delta = float(parts[2]) if len(parts) >= 3 else None
                cycles.append({"cycle": cyc, "energy": energy, "delta": delta})
            except (ValueError, IndexError):
                pass
        j += 1

    return cycles or None


def _parse_time_line(text: str, label: str) -> float | None:
    pat = re.compile(
        rf"{re.escape(label)}:\s+"
        r"(?:(\d+)\s+days?\s+)?"
        r"(?:(\d+)\s+hours?\s+)?"
        r"(?:(\d+)\s+minutes?\s+)?"
        r"(\d+(?:\.\d+)?)\s+seconds?"
    )
    m = pat.search(text)
    if not m:
        return None

    days = int(m.group(1) or 0)
    hours = int(m.group(2) or 0)
    minutes = int(m.group(3) or 0)
    seconds = float(m.group(4))
    return days * 86400 + hours * 3600 + minutes * 60 + seconds


def _parse_tddft(lines: list[str]) -> list[dict[str, Any]]:
    """Parse TD-DFT/TDA excited states section."""
    idx = None
    for i, line in enumerate(lines):
        if "TD-DFT/TDA EXCITED STATES" in line:
            idx = i
            break
    if idx is None:
        return []

    # Find the summary table: look for STATE header line
    table_start = None
    for i in range(idx + 1, len(lines)):
        if re.match(r"\s*STATE\s+ENERGY", lines[i]):
            table_start = i
            break
    if table_start is None:
        return []

    # Parse summary rows (columns: STATE, ENERGY(eV), WAVELENGTH(nm), f, SYMMETRY)
    summary: dict[int, dict[str, Any]] = {}
    j = table_start + 1
    while j < len(lines):
        line = lines[j].strip()
        if not line or "---" in line or "STATE" in line:
            break
        parts = line.split()
        if len(parts) >= 5:
            try:
                state_n = int(parts[0])
                summary[state_n] = {
                    "excited_state": state_n,
                    "energy_eV": float(parts[1]),
                    "wavelength_nm": float(parts[2]),
                    "oscillator_strength": float(parts[3]),
                    "symmetry": parts[4],
                    "transitions": [],
                }
            except (ValueError, IndexError):
                pass
        j += 1

    if not summary:
        return []

    # Parse per-state blocks: "STATE N:  E=... f=..."
    for state_n in summary:
        pat = re.compile(rf"STATE\s+{state_n}:\s+E=([-\d.]+)\s+eV\s+f=([-\d.]+)")
        block_start = None
        for i in range(idx + 1, len(lines)):
            if pat.search(lines[i]):
                block_start = i
                break
        if block_start is None:
            continue

        transitions: list[dict[str, Any]] = []
        k = block_start + 1
        while k < len(lines) and ("---" in lines[k] or not lines[k].strip()):
            k += 1
        while k < len(lines):
            line = lines[k].strip()
            if not line or "---" in line:
                break
            if "coefficient:" in line:
                trans_match = re.match(
                    r"(.+?)\s*->\s*(.+?)\s+coefficient:\s*([-\d.]+)",
                    line,
                )
                if trans_match:
                    from_orb = trans_match.group(1).strip()
                    to_orb = trans_match.group(2).strip()
                    coeff = float(trans_match.group(3))
                    transitions.append(
                        {
                            "from": from_orb,
                            "to": to_orb,
                            "coefficient": coeff,
                        }
                    )
            k += 1

        summary[state_n]["transitions"] = transitions or None

    return list(summary.values())
