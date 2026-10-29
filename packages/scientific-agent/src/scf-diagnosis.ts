import {
  ScientificObservationSchema,
  SkillFragmentReferenceSchema,
  digestCanonical,
  type EvidenceReference,
  type ScientificObservation,
  type ScientificProtocol,
  type SkillFragmentReference,
} from "@eigengrid/scientific-schema";
import { z } from "zod";

export const ScfDiagnosisVersion = "eigengrid.scf-diagnosis/v1" as const;

export const ScfFailureEvidenceSchema = z
  .object({
    signature: z.literal("scf_nonconvergence"),
    termination: z.enum(["iteration_limit", "numerical_failure", "transport_failure", "unknown"]),
    effectState: z.enum(["confirmed", "failed", "ambiguous"]),
    parserStatus: z.enum(["parsed", "failed", "not_run"]),
    artifactIntegrity: z.enum(["verified", "corrupt", "unknown"]),
    cyclesCompleted: z.number().int().nonnegative().optional(),
    configuredMaximumCycles: z.number().int().positive().optional(),
    finalEnergyChange: z.number().finite().optional(),
    finalDensityResidual: z.number().nonnegative().optional(),
    residualTrend: z.enum(["decreasing", "flat", "increasing", "oscillating"]).optional(),
    oscillationDetected: z.boolean().optional(),
    linearDependencyDetected: z.boolean().optional(),
    geometryConcernDetected: z.boolean().optional(),
    chargeMultiplicityVerified: z.boolean().optional(),
  })
  .strict();
export type ScfFailureEvidence = z.infer<typeof ScfFailureEvidenceSchema>;

export interface ScfDiagnosisPolicy {
  currentScfMaximumIterations: number;
  maximumScfIterations: number;
  allowedGuessStrategies: string[];
  allowAutomaticOperationalRemediation: boolean;
  allowAutomaticNumericalRemediation: boolean;
  materialChangesRequireApproval: true;
}

export interface ScfDiagnosisInput {
  missionId: string;
  planId: string;
  planRevision: number;
  failedWorkUnitId: string;
  failedAttemptId: string;
  protocol: ScientificProtocol;
  observations: ScientificObservation[];
  evidence: EvidenceReference[];
  diagnosticSkillFragment: SkillFragmentReference;
  policy: ScfDiagnosisPolicy;
}

const HypothesisSchema = z
  .object({
    id: z.string().min(1),
    rank: z.number().int().positive(),
    code: z.enum([
      "external_effect_unreconciled",
      "evidence_pipeline_failure",
      "iteration_limit_reached",
      "scf_oscillation",
      "near_linear_dependency",
      "challenging_starting_geometry",
      "charge_or_spin_uncertain",
      "general_numerical_stiffness",
    ]),
    plausibility: z.enum(["high", "medium", "low"]),
    score: z.number().int().min(0).max(100),
    basis: z.string().min(1),
    evidenceRefs: z.array(z.string().min(1)),
    missingEvidence: z.array(z.string().min(1)),
    skillRefs: z.array(SkillFragmentReferenceSchema).min(1),
  })
  .strict();
export type ScfHypothesis = z.infer<typeof HypothesisSchema>;

const changeFieldSchema = z.enum([
  "scf_max_iterations",
  "scf_guess_strategy",
  "charge",
  "multiplicity",
  "method",
  "basis",
  "physicalModel",
  "objective",
]);

const RemediationSchema = z
  .object({
    id: z.string().min(1),
    classification: z.enum(["operational", "numerically_bounded", "scientifically_material"]),
    riskClass: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    action: z.enum([
      "reconcile_existing_effect",
      "reparse_preserved_artifact",
      "recollect_artifact_with_integrity_check",
      "retry_identical_request",
      "increase_scf_iteration_limit",
      "use_bounded_guess_stabilization",
      "request_charge_review",
      "request_multiplicity_review",
      "request_method_review",
      "request_basis_review",
      "request_geometry_review",
    ]),
    summary: z.string().min(1),
    changes: z.array(
      z
        .object({
          field: changeFieldSchema,
          currentValue: z.union([z.string(), z.number()]),
          proposedValue: z.union([z.string(), z.number()]).nullable(),
        })
        .strict(),
    ),
    bounds: z
      .object({
        minimum: z.number().optional(),
        maximum: z.number().optional(),
        allowedValues: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    evidenceRefs: z.array(z.string().min(1)),
    skillRefs: z.array(SkillFragmentReferenceSchema).min(1),
    requiresApproval: z.boolean(),
    requiresPlanRevision: z.boolean(),
    eligibleForPolicyApplication: z.boolean(),
  })
  .strict()
  .superRefine((remediation, context) => {
    const immutableFields = new Set([
      "charge",
      "multiplicity",
      "method",
      "basis",
      "physicalModel",
      "objective",
    ]);
    if (
      remediation.classification !== "scientifically_material" &&
      remediation.changes.some((change) => immutableFields.has(change.field))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["changes"],
        message: "Operational and numerical remediations cannot alter scientific invariants",
      });
    }
    if (remediation.classification === "operational" && remediation.riskClass !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Operational remediation is class 1",
      });
    }
    if (
      remediation.classification === "numerically_bounded" &&
      (remediation.riskClass !== 2 || !remediation.bounds)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Numerical remediation must be class 2 with explicit bounds",
      });
    }
    if (
      remediation.classification === "scientifically_material" &&
      (!remediation.requiresApproval ||
        !remediation.requiresPlanRevision ||
        remediation.eligibleForPolicyApplication)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Material remediation must create a revision, require approval, and never auto-apply",
      });
    }
  });
export type ScfRemediation = z.infer<typeof RemediationSchema>;

const DecisionProposalSchema = z
  .object({
    category: z.enum(["charge", "multiplicity", "method", "basis", "physical_model"]),
    question: z.string().min(1),
    selectedOption: z.null(),
    riskClass: z.union([z.literal(3), z.literal(4)]),
    requiresApproval: z.literal(true),
    evidenceRefs: z.array(z.string().min(1)),
    skillRefs: z.array(SkillFragmentReferenceSchema).min(1),
  })
  .strict();

export const ScfDiagnosisResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("not_applicable"),
      schemaVersion: z.literal(ScfDiagnosisVersion),
      code: z.literal("SCF_FAILURE_SIGNATURE_NOT_FOUND"),
      missionId: z.string().min(1),
      planId: z.string().min(1),
      preservedPlanRevision: z.number().int().positive(),
      preservedAttemptId: z.string().min(1),
      replayBlockedUntilReconciled: z.boolean(),
    })
    .strict(),
  z
    .object({
      status: z.literal("diagnosed"),
      schemaVersion: z.literal(ScfDiagnosisVersion),
      diagnosisDigest: z.string().regex(/^[a-f0-9]{64}$/u),
      missionId: z.string().min(1),
      planId: z.string().min(1),
      failedWorkUnitId: z.string().min(1),
      preservedPlanRevision: z.number().int().positive(),
      preservedAttemptId: z.string().min(1),
      triggerObservationIds: z.array(z.string().min(1)).min(1),
      triggerEvidenceIds: z.array(z.string().min(1)).min(1),
      diagnosticSkillFragment: SkillFragmentReferenceSchema,
      hypotheses: z.array(HypothesisSchema).min(1),
      missingEvidence: z.array(z.string().min(1)),
      remediations: z.array(RemediationSchema).min(1),
      decisionProposals: z.array(DecisionProposalSchema),
      requiresPlanRevision: z.boolean(),
      replayBlockedUntilReconciled: z.boolean(),
      preservedScientificFields: z
        .object({
          objectiveId: z.string().min(1),
          charge: z.number().int(),
          multiplicity: z.number().int().positive(),
          method: z.string().min(1),
          basis: z.string().min(1),
          physicalModel: z.string().min(1),
        })
        .strict(),
    })
    .strict(),
]);
export type ScfDiagnosisResult = z.infer<typeof ScfDiagnosisResultSchema>;

interface RankedHypothesis extends Omit<ScfHypothesis, "id" | "rank"> {}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function evidenceForObservation(
  observation: ScientificObservation,
  availableEvidence: ReadonlySet<string>,
): string[] {
  return observation.evidenceRefs.filter((id) => availableEvidence.has(id)).sort();
}

function hypothesis(
  code: RankedHypothesis["code"],
  score: number,
  basis: string,
  evidenceRefs: string[],
  missingEvidence: string[],
  skill: SkillFragmentReference,
): RankedHypothesis {
  return {
    code,
    plausibility: score >= 75 ? "high" : score >= 50 ? "medium" : "low",
    score,
    basis,
    evidenceRefs,
    missingEvidence,
    skillRefs: [skill],
  };
}

function remediation(
  input: ScfDiagnosisInput,
  classification: ScfRemediation["classification"],
  riskClass: ScfRemediation["riskClass"],
  action: ScfRemediation["action"],
  summary: string,
  evidenceRefs: string[],
  changes: ScfRemediation["changes"] = [],
  bounds?: ScfRemediation["bounds"],
): ScfRemediation {
  const material = classification === "scientifically_material";
  const eligibleForPolicyApplication =
    classification === "operational"
      ? input.policy.allowAutomaticOperationalRemediation
      : classification === "numerically_bounded"
        ? input.policy.allowAutomaticNumericalRemediation
        : false;
  return RemediationSchema.parse({
    id: `remediation-${digestCanonical({ action, changes, evidenceRefs }).slice(0, 24)}`,
    classification,
    riskClass,
    action,
    summary,
    changes,
    ...(bounds ? { bounds } : {}),
    evidenceRefs: uniqueSorted(evidenceRefs),
    skillRefs: [input.diagnosticSkillFragment],
    requiresApproval: material,
    requiresPlanRevision: material,
    eligibleForPolicyApplication,
  });
}

/**
 * Diagnoses only structured SCF evidence and proposes typed actions. It never mutates a plan,
 * retries an operation, renders engine input, or selects a new scientific value.
 */
export function diagnoseScfNonconvergence(input: ScfDiagnosisInput): ScfDiagnosisResult {
  if (input.diagnosticSkillFragment.skillId !== "diagnostics.scf-nonconvergence") {
    throw new TypeError("SCF diagnosis requires diagnostics.scf-nonconvergence exact attribution");
  }
  if (!Number.isSafeInteger(input.planRevision) || input.planRevision <= 0) {
    throw new RangeError("planRevision must be a positive integer");
  }
  if (
    !Number.isSafeInteger(input.policy.currentScfMaximumIterations) ||
    !Number.isSafeInteger(input.policy.maximumScfIterations) ||
    input.policy.currentScfMaximumIterations <= 0 ||
    input.policy.maximumScfIterations < input.policy.currentScfMaximumIterations
  ) {
    throw new RangeError("SCF iteration policy bounds are invalid");
  }

  const availableEvidence = new Set(input.evidence.map((item) => item.id));
  const matches = input.observations
    .map((observation) => ({
      observation: ScientificObservationSchema.parse(observation),
      failure: ScfFailureEvidenceSchema.safeParse(observation.payload),
    }))
    .filter(
      (
        item,
      ): item is {
        observation: ScientificObservation;
        failure: z.SafeParseSuccess<ScfFailureEvidence>;
      } => item.observation.type === "failure_signature" && item.failure.success,
    )
    .sort((left, right) => left.observation.id.localeCompare(right.observation.id));

  if (matches.length === 0) {
    return ScfDiagnosisResultSchema.parse({
      status: "not_applicable",
      schemaVersion: ScfDiagnosisVersion,
      code: "SCF_FAILURE_SIGNATURE_NOT_FOUND",
      missionId: input.missionId,
      planId: input.planId,
      preservedPlanRevision: input.planRevision,
      preservedAttemptId: input.failedAttemptId,
      replayBlockedUntilReconciled: false,
    });
  }

  const triggerEvidence = uniqueSorted(
    matches.flatMap((item) => evidenceForObservation(item.observation, availableEvidence)),
  );
  if (triggerEvidence.length === 0) {
    throw new TypeError("SCF failure observations must cite available immutable evidence");
  }
  const merged = matches.map((item) => item.failure.data);
  const hasAmbiguity = merged.some((item) => item.effectState === "ambiguous");
  const parserFailed = merged.some((item) => item.parserStatus === "failed");
  const corruptArtifact = merged.some((item) => item.artifactIntegrity === "corrupt");
  const hitIterationLimit = merged.some(
    (item) =>
      item.termination === "iteration_limit" ||
      (item.cyclesCompleted !== undefined &&
        item.configuredMaximumCycles !== undefined &&
        item.cyclesCompleted >= item.configuredMaximumCycles),
  );
  const oscillating = merged.some(
    (item) => item.oscillationDetected === true || item.residualTrend === "oscillating",
  );
  const linearDependency = merged.some((item) => item.linearDependencyDetected === true);
  const geometryConcern = merged.some((item) => item.geometryConcernDetected === true);
  const chargeSpinUnverified = merged.some((item) => item.chargeMultiplicityVerified !== true);
  const allEvidenceRefs = triggerEvidence;
  const ranked: RankedHypothesis[] = [];

  if (hasAmbiguity) {
    ranked.push(
      hypothesis(
        "external_effect_unreconciled",
        100,
        "The effect acknowledgement is ambiguous, so scientific replay would risk duplicate work.",
        allEvidenceRefs,
        ["reconciled external identity or confirmed operation receipt"],
        input.diagnosticSkillFragment,
      ),
    );
  }
  if (parserFailed || corruptArtifact) {
    ranked.push(
      hypothesis(
        "evidence_pipeline_failure",
        95,
        "Parser or artifact-integrity evidence is incomplete independently of SCF behavior.",
        allEvidenceRefs,
        corruptArtifact
          ? ["uncorrupted authoritative output artifact"]
          : ["schema-valid parser output"],
        input.diagnosticSkillFragment,
      ),
    );
  }
  if (hitIterationLimit) {
    ranked.push(
      hypothesis(
        "iteration_limit_reached",
        merged.some((item) => item.residualTrend === "decreasing") ? 90 : 78,
        "The calculation reached its configured iteration boundary before satisfying convergence.",
        allEvidenceRefs,
        merged.some((item) => item.finalDensityResidual === undefined)
          ? ["final density residual"]
          : [],
        input.diagnosticSkillFragment,
      ),
    );
  }
  if (oscillating) {
    ranked.push(
      hypothesis(
        "scf_oscillation",
        88,
        "The structured residual history reports oscillatory behavior.",
        allEvidenceRefs,
        ["orbital occupations near the oscillatory iterations"],
        input.diagnosticSkillFragment,
      ),
    );
  }
  if (linearDependency) {
    ranked.push(
      hypothesis(
        "near_linear_dependency",
        86,
        "The engine-reported numerical signature indicates near-linear basis dependence.",
        allEvidenceRefs,
        ["overlap-matrix eigenvalue spectrum"],
        input.diagnosticSkillFragment,
      ),
    );
  }
  if (geometryConcern) {
    ranked.push(
      hypothesis(
        "challenging_starting_geometry",
        72,
        "Structured diagnostics flag the starting geometry as a possible convergence driver.",
        allEvidenceRefs,
        ["independent structure-validity observation"],
        input.diagnosticSkillFragment,
      ),
    );
  }
  if (chargeSpinUnverified) {
    ranked.push(
      hypothesis(
        "charge_or_spin_uncertain",
        60,
        "The failure evidence does not verify the current charge and multiplicity; it does not prove either is wrong.",
        allEvidenceRefs,
        ["independent charge assignment", "electronic-state comparison"],
        input.diagnosticSkillFragment,
      ),
    );
  }
  if (ranked.length === 0) {
    ranked.push(
      hypothesis(
        "general_numerical_stiffness",
        40,
        "The SCF failure is confirmed but the available evidence does not isolate a mechanism.",
        allEvidenceRefs,
        ["SCF residual history", "orbital occupations", "overlap diagnostics"],
        input.diagnosticSkillFragment,
      ),
    );
  }

  ranked.sort((left, right) => right.score - left.score || left.code.localeCompare(right.code));
  const hypotheses: ScfHypothesis[] = ranked.map((item, index) =>
    HypothesisSchema.parse({
      ...item,
      id: `hypothesis-${digestCanonical({ code: item.code, evidenceRefs: item.evidenceRefs }).slice(0, 24)}`,
      rank: index + 1,
    }),
  );
  const remediations: ScfRemediation[] = [];

  if (hasAmbiguity) {
    remediations.push(
      remediation(
        input,
        "operational",
        1,
        "reconcile_existing_effect",
        "Reconcile the persisted operation and external identity before any replay.",
        allEvidenceRefs,
      ),
    );
  } else {
    if (parserFailed) {
      remediations.push(
        remediation(
          input,
          "operational",
          1,
          "reparse_preserved_artifact",
          "Run the allowlisted parser again against the preserved immutable artifact.",
          allEvidenceRefs,
        ),
      );
    }
    if (corruptArtifact) {
      remediations.push(
        remediation(
          input,
          "operational",
          1,
          "recollect_artifact_with_integrity_check",
          "Recollect the existing artifact and verify its checksum; do not rerun the calculation.",
          allEvidenceRefs,
        ),
      );
    }
    if (merged.some((item) => item.termination === "transport_failure")) {
      remediations.push(
        remediation(
          input,
          "operational",
          1,
          "retry_identical_request",
          "Retry only the exact idempotent request after confirmed transport failure.",
          allEvidenceRefs,
        ),
      );
    }
    if (
      hitIterationLimit &&
      input.policy.maximumScfIterations > input.policy.currentScfMaximumIterations
    ) {
      const proposed = Math.min(
        input.policy.maximumScfIterations,
        Math.max(
          input.policy.currentScfMaximumIterations + 1,
          input.policy.currentScfMaximumIterations * 2,
        ),
      );
      remediations.push(
        remediation(
          input,
          "numerically_bounded",
          2,
          "increase_scf_iteration_limit",
          "Increase only the SCF iteration ceiling within the predeclared numerical bound.",
          allEvidenceRefs,
          [
            {
              field: "scf_max_iterations",
              currentValue: input.policy.currentScfMaximumIterations,
              proposedValue: proposed,
            },
          ],
          {
            minimum: input.policy.currentScfMaximumIterations,
            maximum: input.policy.maximumScfIterations,
          },
        ),
      );
    }
    if (oscillating && input.policy.allowedGuessStrategies.length > 0) {
      remediations.push(
        remediation(
          input,
          "numerically_bounded",
          2,
          "use_bounded_guess_stabilization",
          "Select only a pre-approved SCF guess stabilization strategy; preserve the physical model.",
          allEvidenceRefs,
          [
            {
              field: "scf_guess_strategy",
              currentValue: "default",
              proposedValue: input.policy.allowedGuessStrategies[0],
            },
          ],
          { allowedValues: [...input.policy.allowedGuessStrategies] },
        ),
      );
    }
  }

  const decisionProposals: Array<z.infer<typeof DecisionProposalSchema>> = [];
  const addMaterial = (
    action: ScfRemediation["action"],
    field: "charge" | "multiplicity" | "method" | "basis",
    currentValue: string | number,
    question: string,
  ): void => {
    remediations.push(
      remediation(
        input,
        "scientifically_material",
        3,
        action,
        `${question} No replacement value is selected by diagnosis.`,
        allEvidenceRefs,
        [{ field, currentValue, proposedValue: null }],
      ),
    );
    decisionProposals.push(
      DecisionProposalSchema.parse({
        category: field,
        question,
        selectedOption: null,
        riskClass: 3,
        requiresApproval: true,
        evidenceRefs: allEvidenceRefs,
        skillRefs: [input.diagnosticSkillFragment],
      }),
    );
  };

  if (chargeSpinUnverified) {
    addMaterial(
      "request_charge_review",
      "charge",
      input.protocol.charge,
      "Is the approved molecular charge supported by independent evidence?",
    );
    addMaterial(
      "request_multiplicity_review",
      "multiplicity",
      input.protocol.multiplicity,
      "Should an alternative electronic-state multiplicity be evaluated?",
    );
  }
  if (linearDependency) {
    addMaterial(
      "request_basis_review",
      "basis",
      input.protocol.basis,
      "Does the basis require a scientifically reviewed alternative after linear-dependency evidence?",
    );
  }
  if (!hasAmbiguity && !hitIterationLimit && !oscillating && !linearDependency) {
    addMaterial(
      "request_method_review",
      "method",
      input.protocol.method,
      "Is the current method appropriate for the unresolved convergence behavior?",
    );
  }
  if (geometryConcern) {
    remediations.push(
      remediation(
        input,
        "scientifically_material",
        3,
        "request_geometry_review",
        "Review the starting structure as a new plan decision; do not overwrite the objective structure.",
        allEvidenceRefs,
        [],
      ),
    );
  }

  const missingEvidence = uniqueSorted(hypotheses.flatMap((item) => item.missingEvidence));
  const payload = {
    status: "diagnosed" as const,
    schemaVersion: ScfDiagnosisVersion,
    missionId: input.missionId,
    planId: input.planId,
    failedWorkUnitId: input.failedWorkUnitId,
    preservedPlanRevision: input.planRevision,
    preservedAttemptId: input.failedAttemptId,
    triggerObservationIds: matches.map((item) => item.observation.id),
    triggerEvidenceIds: triggerEvidence,
    diagnosticSkillFragment: input.diagnosticSkillFragment,
    hypotheses,
    missingEvidence,
    remediations,
    decisionProposals,
    requiresPlanRevision: remediations.some((item) => item.requiresPlanRevision),
    replayBlockedUntilReconciled: hasAmbiguity,
    preservedScientificFields: {
      objectiveId: input.protocol.objectiveId,
      charge: input.protocol.charge,
      multiplicity: input.protocol.multiplicity,
      method: input.protocol.method,
      basis: input.protocol.basis,
      physicalModel: input.protocol.physicalModel,
    },
  };
  return ScfDiagnosisResultSchema.parse({
    ...payload,
    diagnosisDigest: digestCanonical(payload),
  });
}
