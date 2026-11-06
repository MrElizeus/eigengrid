import { z } from "zod";

const NullableFiniteNumberSchema = z.number().finite().nullable();

const NullableIntegerSchema = z.number().int().nullable();

export const AmberQmmmObservationSchema = z
  .object({
    qmmmEnabled: z.boolean().nullable(),
    qmGeneralizedBornMode: NullableIntegerSchema,
    chargeAdjustmentMode: NullableIntegerSchema,
    theory: z.string().min(1).nullable(),
    qmCharge: NullableIntegerSchema,
    spinMultiplicity: NullableIntegerSchema,
    qmAtomCount: z.number().int().nonnegative().nullable(),
    qmAtomIndices: z.array(z.number().int().positive()),
    linkAtomCount: z.number().int().nonnegative().nullable(),
    cutoffAngstrom: NullableFiniteNumberSchema,
    scfConvergenceTolerance: NullableFiniteNumberSchema,
    maximumScfIterations: z.number().int().positive().nullable(),
    qmInteractionMode: NullableIntegerSchema,
    qmEwaldMode: NullableIntegerSchema,
    qmPme: z.boolean().nullable(),
    qmShakeMode: NullableIntegerSchema,
    linkAtomicNumber: NullableIntegerSchema,
    linkDistanceAngstrom: NullableFiniteNumberSchema,
    linkMethod: NullableIntegerSchema,
    gradientMethod: z.string().min(1).nullable(),
    tightDensityConvergence: z.boolean().nullable(),
    verbosity: NullableIntegerSchema,
    printCharges: z.boolean().nullable(),
    printDipole: z.boolean().nullable(),
    peptideCorrection: z.boolean().nullable(),
    qmmmRijIncore: z.boolean().nullable(),
    qmqmErepIncore: z.boolean().nullable(),
    pseudoDiagonalization: z.boolean().nullable(),
    pseudoDiagonalizationCriteria: NullableFiniteNumberSchema,
    diagonalizationRoutine: NullableIntegerSchema,
  })
  .strict();

export type AmberQmmmObservation = z.infer<typeof AmberQmmmObservationSchema>;

export const AmberQmmmEnergySampleSchema = z
  .object({
    sourceLine: z.number().int().positive(),
    step: z.number().int().nonnegative(),
    totalEnergyKcalMol: z.number().finite(),
    rmsGradient: z.number().finite().nonnegative(),
    maximumGradient: z.number().finite().nonnegative(),
    maximumGradientAtomName: z.string().min(1),
    maximumGradientAtomIndex: z.number().int().positive(),
    qmEnergyKcalMol: z.number().finite().nullable(),
  })
  .strict();

export type AmberQmmmEnergySample = z.infer<typeof AmberQmmmEnergySampleSchema>;

export const AmberQmmmBindingFields = [
  "qmmm_enabled",
  "qm_generalized_born_mode",
  "charge_adjustment_mode",
  "theory",
  "qm_charge",
  "spin_multiplicity",
  "qm_atom_count",
  "qm_atom_indices",
  "link_atom_count",
  "cutoff",
  "scf_tolerance",
  "maximum_scf_iterations",
  "embedding",
  "long_range_treatment",
  "parameter_set",
  "boundary_mapping",
  "qm_shake_mode",
  "link_atomic_number",
  "link_distance",
  "link_method",
  "gradient_method",
  "tight_density_convergence",
  "verbosity",
  "print_charges",
  "print_dipole",
  "peptide_correction",
  "qmmm_rij_incore",
  "qmqm_erep_incore",
  "pseudo_diagonalization",
  "pseudo_diagonalization_criteria",
  "diagonalization_routine",
] as const;

export const AmberQmmmBindingCheckSchema = z
  .object({
    field: z.enum(AmberQmmmBindingFields),
    status: z.enum(["matched", "mismatched", "not_observed", "unsupported"]),
    expected: z.string().min(1),
    observed: z.string().min(1).nullable(),
  })
  .strict();

export type AmberQmmmBindingCheck = z.infer<typeof AmberQmmmBindingCheckSchema>;
