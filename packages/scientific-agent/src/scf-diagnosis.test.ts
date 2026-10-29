import { describe, expect, test } from "bun:test";
import { diagnoseScfNonconvergence, type ScfDiagnosisInput } from "./scf-diagnosis";
import {
  diagnosisSkillFragment,
  makeProtocol,
  makeScfObservation,
  mission,
  scfEvidence,
} from "./test-fixtures";

function diagnosisInput(overrides: Partial<ScfDiagnosisInput> = {}): ScfDiagnosisInput {
  return {
    missionId: mission.id,
    planId: "plan-1",
    planRevision: 1,
    failedWorkUnitId: "work-unit-scf",
    failedAttemptId: "attempt-original-failure",
    protocol: makeProtocol(),
    observations: [
      makeScfObservation({
        signature: "scf_nonconvergence",
        termination: "iteration_limit",
        effectState: "confirmed",
        parserStatus: "failed",
        artifactIntegrity: "verified",
        cyclesCompleted: 64,
        configuredMaximumCycles: 64,
        finalEnergyChange: 0.0002,
        finalDensityResidual: 0.0001,
        residualTrend: "oscillating",
        oscillationDetected: true,
        linearDependencyDetected: true,
        geometryConcernDetected: true,
        chargeMultiplicityVerified: false,
      }),
    ],
    evidence: [scfEvidence],
    diagnosticSkillFragment: diagnosisSkillFragment,
    policy: {
      currentScfMaximumIterations: 64,
      maximumScfIterations: 256,
      allowedGuessStrategies: ["damped", "level_shifted"],
      allowAutomaticOperationalRemediation: true,
      allowAutomaticNumericalRemediation: true,
      materialChangesRequireApproval: true,
    },
    ...overrides,
  };
}

describe("skill-backed SCF nonconvergence diagnosis", () => {
  test("ranks hypotheses and separates operational, bounded numerical, and material remedies", () => {
    const input = diagnosisInput();
    const result = diagnoseScfNonconvergence(input);
    expect(result.status).toBe("diagnosed");
    if (result.status !== "diagnosed") return;

    expect(result.hypotheses.map((item) => item.rank)).toEqual(
      result.hypotheses.map((_item, index) => index + 1),
    );
    expect(result.hypotheses[0].code).toBe("evidence_pipeline_failure");
    expect(result.hypotheses.some((item) => item.code === "iteration_limit_reached")).toBe(true);
    expect(result.missingEvidence).toContain("independent charge assignment");
    expect(new Set(result.remediations.map((item) => item.classification))).toEqual(
      new Set(["operational", "numerically_bounded", "scientifically_material"]),
    );

    const numerical = result.remediations.filter(
      (item) => item.classification === "numerically_bounded",
    );
    expect(numerical.length).toBeGreaterThanOrEqual(2);
    expect(
      numerical.every(
        (item) =>
          item.riskClass === 2 &&
          item.bounds !== undefined &&
          item.changes.every((change) =>
            ["scf_max_iterations", "scf_guess_strategy"].includes(change.field),
          ),
      ),
    ).toBe(true);

    const material = result.remediations.filter(
      (item) => item.classification === "scientifically_material",
    );
    expect(material.length).toBeGreaterThanOrEqual(3);
    expect(
      material.every(
        (item) =>
          item.requiresApproval &&
          item.requiresPlanRevision &&
          !item.eligibleForPolicyApplication &&
          item.changes.every((change) => change.proposedValue === null),
      ),
    ).toBe(true);
    expect(result.requiresPlanRevision).toBe(true);
    expect(result.decisionProposals.every((decision) => decision.selectedOption === null)).toBe(
      true,
    );
    expect(result.decisionProposals.every((decision) => decision.requiresApproval)).toBe(true);
    expect(result.preservedAttemptId).toBe("attempt-original-failure");
    expect(result.preservedPlanRevision).toBe(1);
    expect(result.preservedScientificFields).toEqual({
      objectiveId: input.protocol.objectiveId,
      charge: input.protocol.charge,
      multiplicity: input.protocol.multiplicity,
      method: input.protocol.method,
      basis: input.protocol.basis,
      physicalModel: input.protocol.physicalModel,
    });
  });

  test("blocks expensive replay after ambiguous acknowledgement and only proposes reconciliation", () => {
    const input = diagnosisInput({
      observations: [
        makeScfObservation({
          signature: "scf_nonconvergence",
          termination: "iteration_limit",
          effectState: "ambiguous",
          parserStatus: "parsed",
          artifactIntegrity: "verified",
          cyclesCompleted: 64,
          configuredMaximumCycles: 64,
          residualTrend: "decreasing",
          chargeMultiplicityVerified: true,
        }),
      ],
    });
    const result = diagnoseScfNonconvergence(input);
    expect(result.status).toBe("diagnosed");
    if (result.status !== "diagnosed") return;
    expect(result.replayBlockedUntilReconciled).toBe(true);
    expect(result.hypotheses[0].code).toBe("external_effect_unreconciled");
    expect(result.remediations.map((item) => item.action)).toEqual(["reconcile_existing_effect"]);
    expect(result.remediations[0].classification).toBe("operational");
  });

  test("rebuilds the exact diagnosis digest from reordered persisted evidence", () => {
    const firstObservation = diagnosisInput().observations[0];
    const secondObservation = makeScfObservation(
      {
        signature: "scf_nonconvergence",
        termination: "numerical_failure",
        effectState: "confirmed",
        parserStatus: "parsed",
        artifactIntegrity: "verified",
        oscillationDetected: true,
        chargeMultiplicityVerified: true,
      },
      { id: "observation-scf-secondary" },
    );
    const first = diagnoseScfNonconvergence(
      diagnosisInput({ observations: [firstObservation, secondObservation] }),
    );
    const restarted = diagnoseScfNonconvergence(
      structuredClone(diagnosisInput({ observations: [secondObservation, firstObservation] })),
    );
    expect(first.status).toBe("diagnosed");
    expect(restarted.status).toBe("diagnosed");
    if (first.status !== "diagnosed" || restarted.status !== "diagnosed") return;
    expect(first).toEqual(restarted);
    expect(first.diagnosisDigest).toBe(restarted.diagnosisDigest);
  });

  test("returns not-applicable rather than guessing without a structured signature", () => {
    const result = diagnoseScfNonconvergence(
      diagnosisInput({
        observations: [
          makeScfObservation({ signature: "generic_failure", message: "SCF maybe failed" }),
        ],
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        status: "not_applicable",
        code: "SCF_FAILURE_SIGNATURE_NOT_FOUND",
        preservedAttemptId: "attempt-original-failure",
      }),
    );
  });

  test("fails closed on wrong skill attribution or missing immutable evidence", () => {
    expect(() =>
      diagnoseScfNonconvergence(
        diagnosisInput({
          diagnosticSkillFragment: {
            ...diagnosisSkillFragment,
            skillId: "diagnostics.geometry-nonconvergence",
          },
        }),
      ),
    ).toThrow("diagnostics.scf-nonconvergence");
    expect(() => diagnoseScfNonconvergence(diagnosisInput({ evidence: [] }))).toThrow(
      "available immutable evidence",
    );
  });
});
