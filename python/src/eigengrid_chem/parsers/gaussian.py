"""Gaussian 16 output file parser.

Uses cclib as the primary extraction path when available,
with comprehensive regex fallbacks for all fields.
"""

from __future__ import annotations

import re
from typing import Any

from eigengrid_chem.protocol import (
    Atom,
    Frequency,
    ParseError,
    ParseResult,
    ParseResultData,
    ScfCycle,
    Thermochemistry,
)

try:
    from cclib.io import ccread

    HAS_CCLIB = True
except ImportError:
    HAS_CCLIB = False


# -- Periodic table: atomic number -> symbol -------------------

ATOMIC_NUMBERS: dict[int, str] = {
    1: "H",
    2: "He",
    3: "Li",
    4: "Be",
    5: "B",
    6: "C",
    7: "N",
    8: "O",
    9: "F",
    10: "Ne",
    11: "Na",
    12: "Mg",
    13: "Al",
    14: "Si",
    15: "P",
    16: "S",
    17: "Cl",
    18: "Ar",
    19: "K",
    20: "Ca",
    21: "Sc",
    22: "Ti",
    23: "V",
    24: "Cr",
    25: "Mn",
    26: "Fe",
    27: "Co",
    28: "Ni",
    29: "Cu",
    30: "Zn",
    31: "Ga",
    32: "Ge",
    33: "As",
    34: "Se",
    35: "Br",
    36: "Kr",
    37: "Rb",
    38: "Sr",
    39: "Y",
    40: "Zr",
    41: "Nb",
    42: "Mo",
    43: "Tc",
    44: "Ru",
    45: "Rh",
    46: "Pd",
    47: "Ag",
    48: "Cd",
    49: "In",
    50: "Sn",
    51: "Sb",
    52: "Te",
    53: "I",
    54: "Xe",
    55: "Cs",
    56: "Ba",
    57: "La",
    58: "Ce",
    59: "Pr",
    60: "Nd",
    61: "Pm",
    62: "Sm",
    63: "Eu",
    64: "Gd",
    65: "Tb",
    66: "Dy",
    67: "Ho",
    68: "Er",
    69: "Tm",
    70: "Yb",
    71: "Lu",
    72: "Hf",
    73: "Ta",
    74: "W",
    75: "Re",
    76: "Os",
    77: "Ir",
    78: "Pt",
    79: "Au",
    80: "Hg",
    81: "Tl",
    82: "Pb",
    83: "Bi",
    84: "Po",
    85: "At",
    86: "Rn",
    87: "Fr",
    88: "Ra",
    89: "Ac",
    90: "Th",
    91: "Pa",
    92: "U",
}


# -- Main entry point -----------------------------------------


def parse_gaussian(log_path: str) -> dict:
    """Parse a Gaussian 16 output file and return a ParseResult-compatible dict."""
    try:
        with open(log_path, encoding="utf-8", errors="replace") as f:
            text = f.read()
    except FileNotFoundError:
        return ParseResult(
            ok=False,
            parser="gaussian",
            status="failed",
            error=ParseError(
                code="FILE_NOT_FOUND",
                message=f"File not found: {log_path}",
                hint="Check the output path",
            ),
        ).model_dump()

    lines = text.splitlines()

    # -- Termination & convergence -----------------------------
    normal_termination = "Normal termination" in text
    error_termination = "Error termination" in text
    scf_converged = "SCF Done" in text and "SCF convergence failure" not in text

    # -- Error / warning collection ----------------------------
    errors: list[str] = _collect_errors(text)
    warnings: list[str] = _collect_warnings(text)

    # -- SCF energy --------------------------------------------
    energy_hartree: float | None = None
    scf_energies = re.findall(r"SCF Done:\s+E\(.*?\)\s*=\s*([-\d.]+)", text)
    if scf_energies:
        energy_hartree = float(scf_energies[-1])

    # -- Route line: method / basis ----------------------------
    method: str | None = None
    basis: str | None = None
    route_info = _extract_route_info(text)
    if route_info:
        method = route_info.get("method")
        basis = route_info.get("basis")

    # -- Charge / multiplicity ---------------------------------
    charge: int | None = None
    multiplicity: int | None = None
    m = re.search(r"Charge\s*=\s*(-?\d+)\s+Multiplicity\s*=\s*(\d+)", text)
    if m:
        charge = int(m.group(1))
        multiplicity = int(m.group(2))

    # -- cclib extraction (primary path) -----------------------
    cc: dict[str, Any] = {}
    if HAS_CCLIB:
        cc = _cclib_extract(log_path)

    # -- Geometry ----------------------------------------------
    geometry: list[Atom] | None = None
    if cc.get("geometry"):
        geometry = cc["geometry"]
    else:
        geometry = _extract_geometry(lines)

    # -- Vibrational frequencies -------------------------------
    frequencies: list[Frequency] | None = None
    imaginary_frequencies: int | None = None

    if cc.get("frequencies"):
        frequencies = cc["frequencies"]
        imaginary_frequencies = cc.get("imaginary_frequencies", 0)
    else:
        frequencies, imaginary_frequencies = _extract_frequencies(
            text, len(geometry) if geometry else 0
        )

    # -- Thermochemistry ---------------------------------------
    thermochemistry: Thermochemistry | None = _extract_thermochemistry(text)

    # -- SCF iteration history ---------------------------------
    scf_iterations: list[ScfCycle] | None = _extract_scf_iterations(text)

    # -- Timing ------------------------------------------------
    cpu_time_seconds: float | None = _parse_time_line(text, "Job cpu time:")
    wall_time_seconds: float | None = _parse_time_line(text, "Elapsed time:")

    # -- TD-DFT excitations -> raw ------------------------------
    raw: dict[str, Any] | None = None
    if "Excited State" in text:
        exc = _extract_excitations(text)
        if exc:
            raw = {"excitations": exc}

    # -- Build result data -------------------------------------
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
    elif not scf_converged and errors:
        status = "failed"
    else:
        status = "completed" if energy_hartree is not None else "partial"

    return ParseResult(
        ok=True,
        parser="gaussian",
        status=status,
        data=data,
    ).model_dump()


# -- Route-line parser ----------------------------------------


def _extract_route_info(text: str) -> dict[str, str] | None:
    m = re.search(r"#p?\s*(\S+)", text, re.IGNORECASE)
    if not m:
        return None
    route = m.group(1)
    if "/" not in route:
        return {"method": route.upper(), "basis": None}
    method, _, basis_part = route.partition("/")
    return {"method": method.upper(), "basis": basis_part}


# -- Geometry extractor ---------------------------------------


def _extract_geometry(lines: list[str]) -> list[Atom] | None:
    """Parse the LAST 'Standard orientation:' block for final geometry."""
    std_indices = [i for i, line in enumerate(lines) if "Standard orientation:" in line]
    if not std_indices:
        return None

    start = std_indices[-1]
    atoms: list[Atom] = []
    dash_count = 0

    for i in range(start + 1, len(lines)):
        line = lines[i]
        stripped = line.strip()

        if stripped.startswith("---"):
            dash_count += 1
            if dash_count == 1:
                continue
            elif dash_count == 2:
                continue
            elif dash_count == 3:
                break
            continue

        if dash_count == 2:
            parts = stripped.split()
            if len(parts) < 6:
                continue
            try:
                atnum = int(parts[1])
                x = float(parts[3])
                y = float(parts[4])
                z = float(parts[5])
                element = ATOMIC_NUMBERS.get(atnum, f"X{atnum}")
                atoms.append(Atom(element=element, x=x, y=y, z=z))
            except (ValueError, IndexError):
                continue

    return atoms or None


# -- Vibrational frequency parser -----------------------------


def _extract_frequencies(text: str, n_atoms: int) -> tuple[list[Frequency] | None, int | None]:
    """Parse harmonic frequencies, IR/Raman intensities, and normal modes."""

    # Locate the harmonic frequencies block (last occurrence)
    block_start = None
    for m in re.finditer(r"Harmonic Frequencies \(cm-1\)", text):
        block_start = m.end()

    if block_start is None:
        return None, None

    # Cut the section up to Thermochemistry or end-of-file
    section = text[block_start:]
    thermo_match = re.search(r"Thermochemistry", section)
    if thermo_match:
        section = section[: thermo_match.start()]

    lines = section.split("\n")

    all_freqs: list[float] = []
    all_ir: list[float] = []
    all_raman: list[float] = []
    all_modes: list[list[list[float]]] = []  # [mode_idx][atom_idx][xyz]

    i = 0
    while i < len(lines):
        line = lines[i]
        if "Frequencies --" not in line:
            i += 1
            continue

        # Parse frequency values
        group_freqs = _floats_from_line(line)
        nf = len(group_freqs)
        if nf == 0:
            i += 1
            continue
        all_freqs.extend(group_freqs)

        # Advance and look for IR Inten / Raman Activ
        i += 1
        group_ir: list[float] = []
        group_raman: list[float] = []

        while i < len(lines) and not lines[i].strip():
            i += 1
        if i < len(lines) and "IR Inten" in lines[i]:
            group_ir = _floats_from_line(lines[i])
            all_ir.extend(group_ir)
            i += 1
        while i < len(lines) and not lines[i].strip():
            i += 1
        if i < len(lines) and "Raman Activ" in lines[i]:
            group_raman = _floats_from_line(lines[i])
            all_raman.extend(group_raman)
            i += 1

        # Skip blank lines before displacement block
        while i < len(lines) and not lines[i].strip():
            i += 1

        # Build displacement matrix: atom -> [XX_line, YY_line, ZZ_line]
        atom_rows: list[list[str]] = []
        while i < len(lines) and _is_disp_line(lines[i]):
            atom_rows.append(lines[i])
            i += 1

        # Convert displacement rows to structured data
        mode_disps: list[list[list[float]]] = [
            [] for _ in range(nf)
        ]  # [mode_idx] -> list of [x, y, z] per atom

        # Group rows into triplets (XX, YY, ZZ per atom)
        atom_idx = 0
        row = 0
        while row + 2 < len(atom_rows) and atom_idx < (n_atoms or 999):
            triplet = atom_rows[row : row + 3]
            # Each line should be XX, YY, ZZ for the same atom
            coords: list[list[float]] = []
            for t_line in triplet:
                vals = _floats_from_line(t_line)
                coords.append(vals[:nf])
            # coords now: [xx_vals, yy_vals, zz_vals] each of length nf
            for m_idx in range(nf):
                mode_disps[m_idx].append(
                    [
                        coords[0][m_idx] if m_idx < len(coords[0]) else 0.0,
                        coords[1][m_idx] if m_idx < len(coords[1]) else 0.0,
                        coords[2][m_idx] if m_idx < len(coords[2]) else 0.0,
                    ]
                )
            atom_idx += 1
            row += 3

        for m_idx in range(nf):
            all_modes.append(mode_disps[m_idx])

        # i is already advanced past the displacement block
        continue

    if not all_freqs:
        return None, None

    freq_objects: list[Frequency] = []
    for idx, f_val in enumerate(all_freqs):
        freq_objects.append(
            Frequency(
                value=f_val,
                ir_intensity=all_ir[idx] if idx < len(all_ir) else None,
                raman_activity=all_raman[idx] if idx < len(all_raman) else None,
                modes=all_modes[idx] if idx < len(all_modes) else None,
            )
        )

    imag_count = sum(1 for f in all_freqs if f < -10.0)

    return freq_objects, imag_count


def _floats_from_line(line: str) -> list[float]:
    return [float(x) for x in re.findall(r"-?\d+\.\d+", line)]


def _is_disp_line(line: str) -> bool:
    return bool(
        re.match(
            r"\s*Atom\s+\d+\s+(?:XX|YY|ZZ)\s+[-.\d]",
            line,
        )
    )


# -- Thermochemistry ------------------------------------------


def _extract_thermochemistry(text: str) -> Thermochemistry | None:
    zpe: float | None = None
    enthalpy: float | None = None
    gibbs: float | None = None
    entropy: float | None = None

    m = re.search(r"Zero-point correction\s*=\s*([-\d.]+)", text)
    if m:
        zpe = float(m.group(1))

    m = re.search(r"Thermal correction to Enthalpy\s*=\s*([-\d.]+)", text)
    if m:
        enthalpy = float(m.group(1))

    m = re.search(r"Thermal correction to Gibbs Free Energy\s*=\s*([-\d.]+)", text)
    if m:
        gibbs = float(m.group(1))

    m = re.search(r"S\s*\(Total\)\s+([-\d.]+)", text)
    if m:
        entropy = float(m.group(1))

    if any(v is not None for v in (zpe, enthalpy, gibbs, entropy)):
        return Thermochemistry(
            ZPE_hartree=zpe,
            enthalpy_hartree=enthalpy,
            gibbs_hartree=gibbs,
            entropy_calmol=entropy,
        )
    return None


# -- SCF iteration history ------------------------------------


def _extract_scf_iterations(text: str) -> list[ScfCycle] | None:
    matches = re.findall(
        r"SCF Done:\s+E\(.*?\)\s*=\s*([-\d.]+)\s+A\.U\.\s+after\s+(\d+)\s+cycle",
        text,
    )
    if not matches:
        return None

    prev_energy: float | None = None
    cycles: list[ScfCycle] = []
    for energy_str, cycle_str in matches:
        energy = float(energy_str)
        delta: float | None = None
        if prev_energy is not None:
            delta = energy - prev_energy
        cycles.append(ScfCycle(cycle=int(cycle_str), energy=energy, delta=delta))
        prev_energy = energy

    return cycles if cycles else None


# -- Timing ---------------------------------------------------


def _parse_time_line(text: str, label: str) -> float | None:
    pat = re.compile(
        re.escape(label) + r"\s+"
        r"(?:(\d+)\s+days?\s+)?"
        r"(?:(\d+)\s+hours?\s+)?"
        r"(\d+)\s+minutes?\s+"
        r"([-\d.]+)\s+seconds?"
    )
    m = pat.search(text)
    if not m:
        return None
    days = int(m.group(1) or 0)
    hours = int(m.group(2) or 0)
    minutes = int(m.group(3))
    seconds = float(m.group(4))
    return days * 86400 + hours * 3600 + minutes * 60 + seconds


# -- TD-DFT excitations ---------------------------------------


def _extract_excitations(text: str) -> list[dict[str, Any]] | None:
    header_pat = re.compile(
        r"Excited State\s+(\d+):\s+(\S+)\s+([-\d.]+)\s+eV\s+([-\d.]+)\s+nm\s+f=([-\d.]+)"
    )
    transition_pat = re.compile(r"\s*(\S+)\s*->\s*(\S+)\s+([-\d.]+)")
    excitations: list[dict[str, Any]] = []

    for m in header_pat.finditer(text):
        state = int(m.group(1))
        symmetry = m.group(2)
        energy_eV = float(m.group(3))
        wavelength = float(m.group(4))
        osc = float(m.group(5))

        # Parse orbital transitions on subsequent lines
        transitions: list[dict[str, Any]] = []
        remainder = text[m.end() :]
        for line in remainder.split("\n"):
            line = line.strip()
            if not line:
                break
            tm = transition_pat.match(line)
            if not tm:
                break
            transitions.append(
                {
                    "from": tm.group(1),
                    "to": tm.group(2),
                    "coefficient": float(tm.group(3)),
                }
            )

        excitations.append(
            {
                "excited_state": state,
                "energy_eV": energy_eV,
                "wavelength_nm": wavelength,
                "oscillator_strength": osc,
                "symmetry": symmetry if symmetry != "?" else None,
                "transitions": transitions or None,
            }
        )

    return excitations or None


# -- Error / warning collection -------------------------------


def _collect_errors(text: str) -> list[str]:
    errors: list[str] = []

    # Order matters: more specific / impactful errors first
    if ">>> SCF convergence failure" in text:
        errors.append("SCF convergence failure")

    if "Error termination" in text:
        m = re.search(r"Error termination via\s+(\w+)", text)
        if m:
            errors.append(f"Error termination via {m.group(1)}")
        else:
            errors.append("Error termination")

    m = re.search(r"Link\s+(\S+)\s+died", text)
    if m:
        errors.append(f"Link {m.group(1)} died")

    if "No map to Z-matrix" in text:
        errors.append("No map to Z-matrix")

    if "Convergence failure" in text and "SCF convergence failure" not in text:
        errors.append("Convergence failure")

    if "SCF not converged" in text:
        msg = "SCF not converged"
        m = re.search(r"SCF not converged after\s+(\d+)\s+cycles", text)
        if m:
            msg = f"SCF not converged after {m.group(1)} cycles"
        if msg not in errors:
            errors.append(msg)

    return errors


def _collect_warnings(text: str) -> list[str]:
    warnings: list[str] = []

    for m in re.finditer(r"(?i)(?:^|\n)\s*Warning\s*[:\-]\s*(.*)", text):
        msg = m.group(1).strip()
        if msg:
            warnings.append(msg)

    if "Small basis set" in text:
        warnings.append("Small basis set detected")

    return warnings


# -- cclib extraction path ------------------------------------


def _cclib_extract(log_path: str) -> dict[str, Any]:
    """Extract data via cclib (ccread). Returns a dict keyed by field name."""
    result: dict[str, Any] = {}
    data = ccread(log_path)

    if data is None:
        return result

    # -- Energy ------------------------------------------------
    if hasattr(data, "scfenergies") and data.scfenergies is not None and len(data.scfenergies) > 0:
        result["energy_hartree"] = float(data.scfenergies[-1])

    # -- Method ------------------------------------------------
    if hasattr(data, "metadata") and data.metadata:
        meta_method = data.metadata.get("method")
        if meta_method:
            result["method"] = str(meta_method).upper() if meta_method else None
        meta_basis = data.metadata.get("basis")
        if meta_basis:
            result["basis"] = str(meta_basis)

    # Also check legacy cclib attributes
    if "method" not in result and hasattr(data, "metod") and data.metod:
        result["method"] = str(data.metod[0]).upper() if data.metod else None

    if "basis" not in result and hasattr(data, "gbasis") and data.gbasis:
        result["basis"] = str(data.gbasis)

    # -- Charge / multiplicity ---------------------------------
    if hasattr(data, "charge") and data.charge is not None:
        result["charge"] = int(data.charge)
    if hasattr(data, "mult") and data.mult is not None:
        result["multiplicity"] = int(data.mult)

    # -- Geometry ----------------------------------------------
    if hasattr(data, "atomcoords") and data.atomcoords is not None and len(data.atomcoords) > 0:
        final_coords = data.atomcoords[-1]  # shape (n_atoms, 3)
        if hasattr(data, "atomnos") and data.atomnos is not None:
            atoms: list[Atom] = []
            for i in range(len(final_coords)):
                atnum = int(data.atomnos[i])
                element = ATOMIC_NUMBERS.get(atnum, f"X{atnum}")
                atoms.append(
                    Atom(
                        element=element,
                        x=float(final_coords[i][0]),
                        y=float(final_coords[i][1]),
                        z=float(final_coords[i][2]),
                    )
                )
            if atoms:
                result["geometry"] = atoms

    # -- Vibrational frequencies -------------------------------
    if hasattr(data, "vibfreqs") and data.vibfreqs is not None and len(data.vibfreqs) > 0:
        vibfreqs = [float(f) for f in data.vibfreqs]
        vibirs: list[float] | None = None
        if hasattr(data, "vibirs") and data.vibirs is not None:
            vibirs = [float(v) for v in data.vibirs]

        vibraman: list[float] | None = None
        if hasattr(data, "vibraman") and data.vibraman is not None:
            vibraman = [float(v) for v in data.vibraman]

        vibdisps: Any = None
        if hasattr(data, "vibdisps") and data.vibdisps is not None and len(data.vibdisps) > 0:
            vibdisps = data.vibdisps
            # vibdisps shape: (n_modes, n_atoms, 3)

        freq_objects: list[Frequency] = []
        for idx, f_val in enumerate(vibfreqs):
            modes: list[list[float]] | None = None
            if vibdisps is not None and idx < len(vibdisps):
                disp = vibdisps[idx]
                modes = []
                for atom_idx in range(len(disp)):
                    modes.append(
                        [
                            float(disp[atom_idx][0]),
                            float(disp[atom_idx][1]),
                            float(disp[atom_idx][2]),
                        ]
                    )

            freq_objects.append(
                Frequency(
                    value=f_val,
                    ir_intensity=vibirs[idx] if vibirs and idx < len(vibirs) else None,
                    raman_activity=vibraman[idx] if vibraman and idx < len(vibraman) else None,
                    modes=modes,
                )
            )

        if freq_objects:
            result["frequencies"] = freq_objects
            result["imaginary_frequencies"] = sum(1 for f in vibfreqs if f < -10.0)

    # -- SCF iterations ----------------------------------------
    if hasattr(data, "scfenergies") and data.scfenergies is not None and len(data.scfenergies) > 0:
        scf_cycles: list[ScfCycle] = []
        prev: float | None = None
        for idx, en in enumerate(data.scfenergies):
            energy = float(en)
            delta = energy - prev if prev is not None else None
            scf_cycles.append(ScfCycle(cycle=idx + 1, energy=energy, delta=delta))
            prev = energy
        if scf_cycles:
            result["scf_iterations"] = scf_cycles

    return result
