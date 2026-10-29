import { z } from "zod";

// ------------------------------------------------------------
// Parse Result Data Schema
// ------------------------------------------------------------
//
// Canonical output shape for ALL quantum chemistry parsers
// (Gaussian, ORCA, xTB, CP2K). Every parser MUST return this
// exact structure. Engine-specific data that does not fit the
// canonical schema goes into the `raw` field.
//
// This schema is the hard contract between the Python scientific
// muscle and the TypeScript nervous system. Both sides MUST
// validate against it.

// -- Sub-schemas ---------------------------------------------

const AtomSchema = z.object({
  element: z.string().describe("Atomic symbol, e.g. H, O, Fe"),
  x: z.number().describe("Cartesian X coordinate in Angstrom"),
  y: z.number().describe("Cartesian Y coordinate in Angstrom"),
  z: z.number().describe("Cartesian Z coordinate in Angstrom"),
});

const FrequencySchema = z.object({
  value: z.number().describe("Vibrational frequency in cm^-1"),
  ir_intensity: z.number().nullable().describe("IR intensity in km/mol"),
  raman_activity: z.number().nullable().describe("Raman activity in A^4/amu"),
  modes: z
    .array(z.array(z.number()))
    .nullable()
    .describe("Normal mode displacement vectors [atom_index][xyz]"),
});

const ScfCycleSchema = z.object({
  cycle: z.number().describe("SCF iteration number"),
  energy: z.number().describe("Total energy at this cycle in Hartree"),
  delta: z.number().nullable().describe("Energy change from previous cycle"),
});

const ThermochemistrySchema = z.object({
  ZPE_hartree: z.number().nullable().describe("Zero-point energy in Hartree"),
  enthalpy_hartree: z.number().nullable().describe("Enthalpy correction in Hartree"),
  gibbs_hartree: z.number().nullable().describe("Gibbs free energy correction in Hartree"),
  entropy_calmol: z.number().nullable().describe("Entropy in cal/(mol*K)"),
});

// -- Top-level schema ----------------------------------------

export const ParseResultDataSchema = z.object({
  // -- Termination & convergence -------------------------
  normal_termination: z.boolean().describe("True if the program reported normal termination"),
  scf_converged: z.boolean().describe("True if the SCF procedure converged"),
  energy_hartree: z.number().nullable().describe("Final total energy in Hartree"),

  // -- Method metadata -----------------------------------
  method: z.string().nullable().describe("Theoretical method, e.g. RB3LYP, UKS, GFN2-xTB"),
  basis: z.string().nullable().describe("Basis set, e.g. 6-31G(d), def2-TZVP, SVP"),
  charge: z.number().int().nullable().describe("Molecular charge"),
  multiplicity: z.number().int().nullable().describe("Spin multiplicity (2S+1)"),

  // -- Geometry ------------------------------------------
  geometry: z.array(AtomSchema).nullable().describe("Final molecular geometry in Angstrom"),

  // -- Vibrational analysis ------------------------------
  frequencies: z
    .array(FrequencySchema)
    .nullable()
    .describe("Harmonic vibrational frequencies and normal modes"),
  imaginary_frequencies: z
    .number()
    .int()
    .nullable()
    .describe("Count of imaginary frequencies (convenience field)"),

  // -- Thermochemistry -----------------------------------
  thermochemistry: ThermochemistrySchema.nullable().describe(
    "Thermochemical corrections at the output temperature",
  ),

  // -- SCF convergence history ---------------------------
  scf_iterations: z.array(ScfCycleSchema).nullable().describe("Full SCF convergence trajectory"),

  // -- Timing --------------------------------------------
  cpu_time_seconds: z.number().nullable().describe("Total CPU time in seconds"),
  wall_time_seconds: z.number().nullable().describe("Total wall-clock time in seconds"),

  // -- Diagnostics ---------------------------------------
  warnings: z.array(z.string()).describe("Non-fatal issues detected during parsing"),
  errors: z.array(z.string()).describe("Fatal issues detected during parsing"),

  // -- Engine-specific data ------------------------------
  raw: z
    .record(z.unknown())
    .nullable()
    .describe("Parser-specific data that does not fit the canonical schema"),
});

export type ParseResultData = z.infer<typeof ParseResultDataSchema>;

// -- Default factory ----------------------------------------

export function createEmptyParseResultData(): ParseResultData {
  return {
    normal_termination: false,
    scf_converged: false,
    energy_hartree: null,
    method: null,
    basis: null,
    charge: null,
    multiplicity: null,
    geometry: null,
    frequencies: null,
    imaginary_frequencies: null,
    thermochemistry: null,
    scf_iterations: null,
    cpu_time_seconds: null,
    wall_time_seconds: null,
    warnings: [],
    errors: [],
    raw: null,
  };
}

// -- Schema for an engine-specific raw entry (TD-DFT excitations, etc.) --

export const ExcitationSchema = z.object({
  excited_state: z.number().describe("State number"),
  energy_eV: z.number().describe("Excitation energy in eV"),
  wavelength_nm: z.number().describe("Wavelength in nm"),
  oscillator_strength: z.number().describe("Oscillator strength f"),
  symmetry: z.string().nullable().describe("State symmetry label"),
  transitions: z
    .array(
      z.object({
        from: z.string(),
        to: z.string(),
        coefficient: z.number(),
      }),
    )
    .nullable()
    .describe("Dominant orbital transitions"),
});
