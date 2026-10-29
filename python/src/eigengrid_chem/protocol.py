"""
Protocol models for TypeScript-Python JSON communication.

This module is the Python mirror of the Zod schemas defined in
packages/protocol/src/parse-result.schema.ts. Every field MUST
match the TypeScript definition exactly -- the bridge validates
both sides.

Usage:
    result = ParseResult(
        ok=True,
        parser="gaussian",
        status="completed",
        data=ParseResultData(
            normal_termination=True,
            energy_hartree=-1156.78392432,
            ...
        )
    )
    print(result.model_dump_json())
"""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field

# -- Sub-models ----------------------------------------------


class Atom(BaseModel):
    element: str = Field(description="Atomic symbol, e.g. H, O, Fe")
    x: float = Field(description="Cartesian X coordinate in Angstrom")
    y: float = Field(description="Cartesian Y coordinate in Angstrom")
    z: float = Field(description="Cartesian Z coordinate in Angstrom")


class Frequency(BaseModel):
    value: float = Field(description="Vibrational frequency in cm^-1")
    ir_intensity: Optional[float] = Field(None, description="IR intensity in km/mol")
    raman_activity: Optional[float] = Field(None, description="Raman activity in A^4/amu")
    modes: Optional[list[list[float]]] = Field(
        None, description="Normal mode displacement vectors [atom_index][xyz]"
    )


class ScfCycle(BaseModel):
    cycle: int = Field(description="SCF iteration number")
    energy: float = Field(description="Total energy at this cycle in Hartree")
    delta: Optional[float] = Field(None, description="Energy change from previous cycle")


class Thermochemistry(BaseModel):
    ZPE_hartree: Optional[float] = Field(None, description="Zero-point energy in Hartree")
    enthalpy_hartree: Optional[float] = Field(None, description="Enthalpy correction in Hartree")
    gibbs_hartree: Optional[float] = Field(
        None, description="Gibbs free energy correction in Hartree"
    )
    entropy_calmol: Optional[float] = Field(None, description="Entropy in cal/(mol*K)")


class Transition(BaseModel):
    from_: str = Field(alias="from", description="Source orbital label")
    to: str = Field(description="Target orbital label")
    coefficient: float = Field(description="Transition coefficient")


class Excitation(BaseModel):
    excited_state: int = Field(description="State number")
    energy_eV: float = Field(description="Excitation energy in eV")
    wavelength_nm: float = Field(description="Wavelength in nm")
    oscillator_strength: float = Field(description="Oscillator strength f")
    symmetry: Optional[str] = Field(None, description="State symmetry label")
    transitions: Optional[list[Transition]] = Field(
        None, description="Dominant orbital transitions"
    )


# -- Canonical Parse Result Data -----------------------------


class ParseResultData(BaseModel):
    """Canonical output shape for ALL quantum chemistry parsers.

    Every parser (Gaussian, ORCA, xTB, CP2K) MUST return this
    exact structure. Engine-specific data goes into ``raw``.
    """

    # Termination & convergence
    normal_termination: bool = Field(description="True if the program reported normal termination")
    scf_converged: bool = Field(description="True if the SCF procedure converged")
    energy_hartree: Optional[float] = Field(None, description="Final total energy in Hartree")

    # Method metadata
    method: Optional[str] = Field(None, description="Theoretical method, e.g. RB3LYP, UKS")
    basis: Optional[str] = Field(None, description="Basis set, e.g. 6-31G(d), def2-TZVP")
    charge: Optional[int] = Field(None, description="Molecular charge")
    multiplicity: Optional[int] = Field(None, description="Spin multiplicity (2S+1)")

    # Geometry
    geometry: Optional[list[Atom]] = Field(None, description="Final molecular geometry in Angstrom")

    # Vibrational analysis
    frequencies: Optional[list[Frequency]] = Field(
        None, description="Harmonic vibrational frequencies"
    )
    imaginary_frequencies: Optional[int] = Field(None, description="Count of imaginary frequencies")

    # Thermochemistry
    thermochemistry: Optional[Thermochemistry] = Field(
        None, description="Thermochemical corrections"
    )

    # SCF convergence history
    scf_iterations: Optional[list[ScfCycle]] = Field(
        None, description="Full SCF convergence trajectory"
    )

    # Timing
    cpu_time_seconds: Optional[float] = Field(None, description="Total CPU time in seconds")
    wall_time_seconds: Optional[float] = Field(None, description="Total wall-clock time in seconds")

    # Diagnostics
    warnings: list[str] = Field(
        default_factory=list, description="Non-fatal issues detected during parsing"
    )
    errors: list[str] = Field(
        default_factory=list, description="Fatal issues detected during parsing"
    )

    # Engine-specific
    raw: Optional[dict] = Field(
        None, description="Parser-specific data not fitting the canonical schema"
    )


# -- Top-level Response Wrappers -----------------------------


class ParseResult(BaseModel):
    """Top-level response from the Python parse CLI.

    Mirrors PythonParseResponseSchema from python.schema.ts.
    """

    ok: bool
    parser: str
    status: str  # "completed" | "failed" | "partial" | "unknown"
    data: Optional[ParseResultData] = None
    error: Optional[ParseError] = None


class ParseError(BaseModel):
    code: str
    message: str
    hint: Optional[str] = None
