import { digestCanonical, type QmmmProtocol } from "@eigengrid/scientific-schema";
import {
  type AmberQmmmBindingCheck,
  AmberQmmmBindingCheckSchema,
  type AmberQmmmObservation,
} from "./observations";

export function numericValue(token: string): number | null {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[EeDd][+-]?\d+)?$/u.test(token)) return null;
  const parsed = Number(token.replace(/[dD]/u, "E"));
  return Number.isFinite(parsed) ? parsed : null;
}

export function valuesMatch(expected: number, observed: number | null): boolean {
  if (observed === null) return false;
  return Math.abs(expected - observed) <= Math.max(1e-14, Math.abs(expected) * 1e-8);
}

function stringify(value: unknown): string {
  return Array.isArray(value) ? value.join(",") : String(value);
}

export function bindingChecks(
  protocol: QmmmProtocol,
  observed: AmberQmmmObservation,
): AmberQmmmBindingCheck[] {
  const check = (
    field: AmberQmmmBindingCheck["field"],
    expected: unknown,
    actual: unknown | null,
    matched: boolean,
  ): AmberQmmmBindingCheck => ({
    field,
    status: actual === null ? "not_observed" : matched ? "matched" : "mismatched",
    expected: stringify(expected),
    observed: actual === null ? null : stringify(actual),
  });
  const unsupported = (
    field: AmberQmmmBindingCheck["field"],
    expected: unknown,
    observedValue: string | null,
  ): AmberQmmmBindingCheck => ({
    field,
    status: "unsupported",
    expected: stringify(expected),
    observed: observedValue,
  });

  const result: AmberQmmmBindingCheck[] = [
    check("qmmm_enabled", true, observed.qmmmEnabled, observed.qmmmEnabled === true),
    check(
      "qm_generalized_born_mode",
      0,
      observed.qmGeneralizedBornMode,
      observed.qmGeneralizedBornMode === 0,
    ),
    check(
      "charge_adjustment_mode",
      2,
      observed.chargeAdjustmentMode,
      observed.chargeAdjustmentMode === 2,
    ),
    check(
      "theory",
      protocol.theory.theory.toUpperCase(),
      observed.theory?.toUpperCase() ?? null,
      observed.theory?.toUpperCase() === protocol.theory.theory.toUpperCase(),
    ),
    check(
      "qm_charge",
      protocol.electronicState.qmCharge,
      observed.qmCharge,
      observed.qmCharge === protocol.electronicState.qmCharge,
    ),
    check(
      "spin_multiplicity",
      protocol.electronicState.spinMultiplicity,
      observed.spinMultiplicity,
      observed.spinMultiplicity === protocol.electronicState.spinMultiplicity,
    ),
    check(
      "qm_atom_count",
      protocol.region.atomIndices.length,
      observed.qmAtomCount,
      observed.qmAtomCount === protocol.region.atomIndices.length,
    ),
    check(
      "qm_atom_indices",
      protocol.region.atomIndices,
      observed.qmAtomIndices.length === 0 ? null : observed.qmAtomIndices,
      digestCanonical(observed.qmAtomIndices) === digestCanonical(protocol.region.atomIndices),
    ),
    check(
      "link_atom_count",
      protocol.boundary.covalentBonds.length,
      observed.linkAtomCount,
      observed.linkAtomCount === protocol.boundary.covalentBonds.length,
    ),
    check(
      "cutoff",
      protocol.embedding.cutoffAngstrom,
      observed.cutoffAngstrom,
      valuesMatch(protocol.embedding.cutoffAngstrom, observed.cutoffAngstrom),
    ),
    check(
      "scf_tolerance",
      protocol.convergence.scfConvergenceTolerance,
      observed.scfConvergenceTolerance,
      valuesMatch(protocol.convergence.scfConvergenceTolerance, observed.scfConvergenceTolerance),
    ),
    check(
      "maximum_scf_iterations",
      protocol.convergence.maximumScfIterations,
      observed.maximumScfIterations,
      observed.maximumScfIterations === protocol.convergence.maximumScfIterations,
    ),
  ];

  if (protocol.embedding.mode === "electrostatic") {
    result.push(
      check(
        "embedding",
        "electrostatic:qmmm_int=1",
        observed.qmInteractionMode,
        observed.qmInteractionMode === 1,
      ),
    );
  } else {
    result.push(
      unsupported(
        "embedding",
        protocol.embedding.mode,
        observed.qmInteractionMode?.toString() ?? null,
      ),
    );
  }
  if (protocol.embedding.longRangeTreatment === "direct_cutoff") {
    const actual =
      observed.qmEwaldMode === null || observed.qmPme === null
        ? null
        : `${observed.qmEwaldMode}:${observed.qmPme}`;
    result.push(
      check(
        "long_range_treatment",
        "direct_cutoff:qm_ewald=0:qm_pme=false",
        actual,
        observed.qmEwaldMode === 0 && observed.qmPme === false,
      ),
    );
  } else {
    result.push(
      unsupported(
        "long_range_treatment",
        protocol.embedding.longRangeTreatment,
        observed.qmEwaldMode === null || observed.qmPme === null
          ? null
          : `${observed.qmEwaldMode}:${observed.qmPme}`,
      ),
    );
  }
  result.push(
    protocol.theory.parameterSet === undefined
      ? {
          field: "parameter_set",
          status: "matched",
          expected: "amber-builtin-qualified-theory",
          observed: "amber-builtin-qualified-theory",
        }
      : unsupported("parameter_set", protocol.theory.parameterSet.id, null),
  );
  result.push(
    protocol.boundary.mode === "no_covalent_boundary"
      ? check(
          "boundary_mapping",
          "no_covalent_boundary",
          observed.linkAtomCount,
          observed.linkAtomCount === 0,
        )
      : unsupported(
          "boundary_mapping",
          `${protocol.boundary.covalentBonds.length} exact boundary bonds`,
          observed.linkAtomCount?.toString() ?? null,
        ),
  );
  result.push(
    check("qm_shake_mode", 1, observed.qmShakeMode, observed.qmShakeMode === 1),
    check("link_atomic_number", 1, observed.linkAtomicNumber, observed.linkAtomicNumber === 1),
    check(
      "link_distance",
      1.09,
      observed.linkDistanceAngstrom,
      valuesMatch(1.09, observed.linkDistanceAngstrom),
    ),
    check("link_method", 1, observed.linkMethod, observed.linkMethod === 1),
    check(
      "gradient_method",
      "Analytical",
      observed.gradientMethod,
      observed.gradientMethod === "Analytical",
    ),
    check(
      "tight_density_convergence",
      false,
      observed.tightDensityConvergence,
      observed.tightDensityConvergence === false,
    ),
    check("verbosity", 0, observed.verbosity, observed.verbosity === 0),
    check("print_charges", false, observed.printCharges, observed.printCharges === false),
    check("print_dipole", false, observed.printDipole, observed.printDipole === false),
    check(
      "peptide_correction",
      false,
      observed.peptideCorrection,
      observed.peptideCorrection === false,
    ),
    check("qmmm_rij_incore", true, observed.qmmmRijIncore, observed.qmmmRijIncore === true),
    check("qmqm_erep_incore", true, observed.qmqmErepIncore, observed.qmqmErepIncore === true),
    check(
      "pseudo_diagonalization",
      true,
      observed.pseudoDiagonalization,
      observed.pseudoDiagonalization === true,
    ),
    check(
      "pseudo_diagonalization_criteria",
      0.05,
      observed.pseudoDiagonalizationCriteria,
      valuesMatch(0.05, observed.pseudoDiagonalizationCriteria),
    ),
    check(
      "diagonalization_routine",
      0,
      observed.diagonalizationRoutine,
      observed.diagonalizationRoutine === 0,
    ),
  );
  return result.map((candidate) => AmberQmmmBindingCheckSchema.parse(candidate));
}
