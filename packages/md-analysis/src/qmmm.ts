import {
  IdSchema,
  MdArtifactReferenceSchema,
  MdStageResultSchema,
  OperationReceiptSchema,
  ApprovalRequestSchema,
  QmmmProtocolSchema,
  assertMdStageResultDigest,
  assertQmmmProtocolDigest,
  digestBytes,
  digestCanonical,
  type QmmmProtocol,
  type ApprovalRequest,
  type OperationReceipt,
} from "@eigengrid/scientific-schema";
import { z } from "zod";
import {
  AnalysisDiagnosticSchema,
  analysisDiagnostic,
  cleanDiagnosticLine,
  type AnalysisDiagnostic,
} from "./contracts";

export const AmberQmmmParseSchemaVersion = "eigengrid.amber-qmmm-parse/v1" as const;
export const AmberQmmmParserVersion = "1.0.0" as const;
export const AmberQmmmQualifiedEngine = Object.freeze({
  engine: "amber",
  executable: "sander",
  version: "AmberTools 26.0",
  compatibilityVersion: "1.0.0",
  rendererCompatibilityVersion: "1.0.0",
});

export const AmberQmmmParseRequestSchema = z
  .object({
    schemaVersion: z.literal(AmberQmmmParseSchemaVersion),
    missionId: IdSchema,
    source: MdArtifactReferenceSchema,
    stageResult: MdStageResultSchema,
    protocol: QmmmProtocolSchema,
    parserVersion: z.literal(AmberQmmmParserVersion),
    executionCompletion: z.enum(["confirmed", "unconfirmed"]),
    operationReceiptRef: IdSchema.optional(),
  })
  .strict()
  .superRefine((request, context) => {
    const resultSource = request.stageResult.artifacts.find(
      (artifact) => artifact.role === "mdout",
    );
    if (
      request.source.role !== "mdout" ||
      resultSource === undefined ||
      digestCanonical(resultSource) !== digestCanonical(request.source)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["source"],
        message: "QM/MM parsing requires the exact mdout artifact of the exact stage result",
      });
    }
    if (
      request.missionId !== request.stageResult.missionId ||
      request.missionId !== request.protocol.missionId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["missionId"],
        message: "QM/MM protocol, stage result, and parse request must belong to one mission",
      });
    }
    if (
      request.stageResult.protocolId !== request.protocol.parentMdProtocol.id ||
      request.stageResult.protocolRevision !== request.protocol.parentMdProtocol.revision ||
      request.stageResult.protocolDigest !== request.protocol.parentMdProtocol.digest ||
      !request.protocol.appliedStageIds.includes(request.stageResult.stageId)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["protocol"],
        message: "QM/MM protocol must bind the exact parent MD protocol and executed stage",
      });
    }
    if (request.protocol.status !== "approved" || request.protocol.approvedByRef === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["protocol", "status"],
        message: "Only an exactly approved QM/MM protocol is eligible for authoritative parsing",
      });
    }
    if (
      request.operationReceiptRef !== undefined &&
      request.operationReceiptRef !== request.stageResult.operationReceiptId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["operationReceiptRef"],
        message: "QM/MM parser receipt must match the exact stage result receipt",
      });
    }
    if (request.operationReceiptRef === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["operationReceiptRef"],
        message: "QM/MM parsing requires the exact durable operation receipt",
      });
    }
    if (
      (request.executionCompletion === "unconfirmed") !==
      (request.stageResult.terminalReason === "ambiguous")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["executionCompletion"],
        message:
          "Only an ambiguous stage outcome may remain unconfirmed; every terminal outcome must be confirmed",
      });
    }
    if (
      request.stageResult.engine.engine !== AmberQmmmQualifiedEngine.engine ||
      request.stageResult.engine.executable !== AmberQmmmQualifiedEngine.executable ||
      request.stageResult.engine.version !== AmberQmmmQualifiedEngine.version ||
      request.stageResult.engine.compatibilityVersion !==
        AmberQmmmQualifiedEngine.compatibilityVersion ||
      request.protocol.rendererCompatibilityVersion !==
        AmberQmmmQualifiedEngine.rendererCompatibilityVersion
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stageResult", "engine"],
        message:
          "QM/MM parser v1 is qualified only for the exact sander AmberTools 26.0 and renderer 1.0.0 envelope",
      });
    }
    if (request.protocol.region.selectionClass !== "all_qm_engine_check") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["protocol", "region", "selectionClass"],
        message:
          "QM/MM parser v1 is qualified only for the all-QM module check; hybrid coupling remains unqualified",
      });
    }
  });
export type AmberQmmmParseRequest = z.infer<typeof AmberQmmmParseRequestSchema>;

export interface AmberQmmmAuthorityValidation {
  approval: ApprovalRequest;
  operationReceipt: OperationReceipt;
}

export interface AmberQmmmAuthorityValidator {
  /** Application-owned lookup/validation; model output is never a valid implementation. */
  verify(
    evidence: AmberQmmmAuthorityValidation,
    bindingDigest: string,
  ): Promise<{ approvalRecordDigest: string; operationReceiptRecordDigest: string }>;
}

export interface AmberQmmmParseAuthority {
  readonly bindingDigest: string;
  readonly authorityDigest: string;
}

const issuedParseAuthorities = new WeakSet<object>();

function authorityBindingDigest(request: AmberQmmmParseRequest): string {
  return digestCanonical({
    schemaVersion: "eigengrid.amber-qmmm-parse-authority/v1",
    missionId: request.missionId,
    protocol: {
      id: request.protocol.id,
      revision: request.protocol.revision,
      digest: request.protocol.protocolDigest,
      approvalRef: request.protocol.approvedByRef,
    },
    stageResult: {
      id: request.stageResult.id,
      revision: request.stageResult.revision,
      digest: request.stageResult.resultDigest,
      operationId: request.stageResult.operationId,
      operationReceiptId: request.stageResult.operationReceiptId,
    },
    source: {
      artifactId: request.source.artifactId,
      contentDigest: request.source.contentDigest,
    },
    parserVersion: request.parserVersion,
    executionCompletion: request.executionCompletion,
    operationReceiptRef: request.operationReceiptRef,
  });
}

/**
 * Create a process-local capability only after the host has verified the exact
 * durable approval and operation receipt records. The parser rejects lookalike
 * plain objects, even when their self-described digests match.
 */
export async function authorizeAmberQmmmParse(
  requestValue: unknown,
  evidenceValue: AmberQmmmAuthorityValidation,
  validator: AmberQmmmAuthorityValidator,
): Promise<AmberQmmmParseAuthority> {
  const request = AmberQmmmParseRequestSchema.parse(requestValue);
  assertMdStageResultDigest(request.stageResult);
  assertQmmmProtocolDigest(request.protocol);
  const approval = ApprovalRequestSchema.parse(evidenceValue.approval);
  const operationReceipt = OperationReceiptSchema.parse(evidenceValue.operationReceipt);
  if (
    approval.id !== request.protocol.approvedByRef ||
    approval.missionId !== request.missionId ||
    approval.subjectType !== "qmmm_protocol" ||
    approval.subjectId !== request.protocol.id ||
    approval.subjectVersion !== 1 ||
    approval.subjectRevision !== request.protocol.revision ||
    approval.payloadDigest !== request.protocol.protocolDigest ||
    approval.state !== "approved" ||
    approval.response?.decision !== "approved" ||
    approval.response.approvalRequestId !== approval.id ||
    approval.response.subjectVersion !== approval.subjectVersion ||
    approval.response.subjectRevision !== approval.subjectRevision ||
    approval.response.payloadDigest !== approval.payloadDigest ||
    approval.response.policyDigest !== approval.policyDigest
  ) {
    throw new Error("QM/MM parse approval does not bind the exact approved protocol");
  }
  const receiptIdentity = operationReceipt.externalIdentity;
  const requiredReceiptStatus =
    request.executionCompletion === "unconfirmed"
      ? "ambiguous"
      : request.stageResult.terminalReason === "completed"
        ? "confirmed"
        : "failed";
  if (
    operationReceipt.id !== request.stageResult.operationReceiptId ||
    operationReceipt.operationId !== request.stageResult.operationId ||
    operationReceipt.status !== requiredReceiptStatus ||
    receiptIdentity?.stageResultId !== request.stageResult.id ||
    receiptIdentity.stageResultDigest !== request.stageResult.resultDigest ||
    receiptIdentity.sourceArtifactId !== request.source.artifactId ||
    receiptIdentity.sourceContentDigest !== request.source.contentDigest ||
    operationReceipt.detailDigest !== digestCanonical(receiptIdentity)
  ) {
    throw new Error("QM/MM operation receipt does not bind the exact stage result and mdout");
  }
  const bindingDigest = authorityBindingDigest(request);
  const validated = await validator.verify({ approval, operationReceipt }, bindingDigest);
  const recordDigestPattern = /^[a-f0-9]{64}$/u;
  if (
    !recordDigestPattern.test(validated.approvalRecordDigest) ||
    !recordDigestPattern.test(validated.operationReceiptRecordDigest)
  ) {
    throw new Error("QM/MM authority validator returned invalid durable record evidence");
  }
  const authority = Object.freeze({
    bindingDigest,
    authorityDigest: digestCanonical({ bindingDigest, ...validated }),
  });
  issuedParseAuthorities.add(authority);
  return authority;
}

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

const AmberQmmmBindingFields = [
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

export const AmberQmmmParseResultSchema = z
  .object({
    schemaVersion: z.literal(AmberQmmmParseSchemaVersion),
    missionId: IdSchema,
    protocol: z
      .object({
        id: IdSchema,
        revision: z.number().int().positive(),
        protocolDigest: z.string().regex(/^[a-f0-9]{64}$/u),
        approvalRef: IdSchema,
      })
      .strict(),
    regionSelectionClass: z.literal("all_qm_engine_check"),
    stageResult: z
      .object({
        id: IdSchema,
        revision: z.number().int().positive(),
        resultDigest: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict(),
    source: MdArtifactReferenceSchema,
    operationReceiptRef: IdSchema.optional(),
    parserVersion: z.literal(AmberQmmmParserVersion),
    authorityDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    status: z.enum([
      "completed",
      "nonconverged",
      "unsupported_protocol",
      "authority_mismatch",
      "fatal",
      "nonzero_exit",
      "partial",
      "no_data",
    ]),
    terminalMarkerObserved: z.boolean(),
    qmScfStatus: z.enum(["no_failure_reported", "failed", "not_observed"]),
    minimizationCycleLimit: z.enum(["reached", "not_reached", "not_applicable", "unknown"]),
    observations: AmberQmmmObservationSchema,
    bindingChecks: z.array(AmberQmmmBindingCheckSchema).length(AmberQmmmBindingFields.length),
    energySamples: z.array(AmberQmmmEnergySampleSchema),
    diagnostics: z.array(AnalysisDiagnosticSchema),
    scientificAssessmentEligible: z.boolean(),
    requiresEscalation: z.boolean(),
    automaticScientificCorrectionAllowed: z.literal(false),
    parseDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict()
  .superRefine((result, context) => {
    const bindingFields = result.bindingChecks.map((check) => check.field);
    if (
      new Set(bindingFields).size !== AmberQmmmBindingFields.length ||
      AmberQmmmBindingFields.some((field) => !bindingFields.includes(field))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["bindingChecks"],
        message: "QM/MM parse results require each exact material binding check once",
      });
    }
    if (result.scientificAssessmentEligible !== (result.status === "completed")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scientificAssessmentEligible"],
        message: "Only an exact completed parse is eligible for a separate scientific assessment",
      });
    }
    if (result.requiresEscalation === result.scientificAssessmentEligible) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requiresEscalation"],
        message: "Every ineligible QM/MM parse must stop and escalate",
      });
    }
    if (
      result.status === "completed" &&
      result.bindingChecks.some((check) => check.status !== "matched")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["bindingChecks"],
        message: "A completed QM/MM parse requires every material control to match",
      });
    }
    if (result.status === "completed") {
      const observationValues = [
        result.observations.qmmmEnabled,
        result.observations.qmGeneralizedBornMode,
        result.observations.chargeAdjustmentMode,
        result.observations.theory,
        result.observations.qmCharge,
        result.observations.spinMultiplicity,
        result.observations.qmAtomCount,
        result.observations.linkAtomCount,
        result.observations.cutoffAngstrom,
        result.observations.scfConvergenceTolerance,
        result.observations.maximumScfIterations,
        result.observations.qmInteractionMode,
        result.observations.qmEwaldMode,
        result.observations.qmPme,
        result.observations.qmShakeMode,
        result.observations.linkAtomicNumber,
        result.observations.linkDistanceAngstrom,
        result.observations.linkMethod,
        result.observations.gradientMethod,
        result.observations.tightDensityConvergence,
        result.observations.verbosity,
        result.observations.printCharges,
        result.observations.printDipole,
        result.observations.peptideCorrection,
        result.observations.qmmmRijIncore,
        result.observations.qmqmErepIncore,
        result.observations.pseudoDiagonalization,
        result.observations.pseudoDiagonalizationCriteria,
        result.observations.diagonalizationRoutine,
      ];
      if (
        !result.terminalMarkerObserved ||
        result.qmScfStatus !== "no_failure_reported" ||
        result.minimizationCycleLimit !== "not_reached" ||
        result.operationReceiptRef === undefined ||
        observationValues.some((value) => value === null) ||
        result.observations.qmAtomIndices.length === 0 ||
        result.energySamples.length === 0 ||
        result.energySamples.some((sample) => sample.qmEnergyKcalMol === null) ||
        result.diagnostics.some((diagnostic) => ["error", "fatal"].includes(diagnostic.severity))
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["status"],
          message:
            "Completed QM/MM parsing requires confirmed terminal, control, energy, and clean diagnostic evidence",
        });
      }
    }
    if (result.status === "nonconverged" && result.minimizationCycleLimit !== "reached") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["minimizationCycleLimit"],
        message: "A nonconverged minimization result requires an observed cycle limit",
      });
    }
  });
export type AmberQmmmParseResult = z.infer<typeof AmberQmmmParseResultSchema>;

export function computeAmberQmmmParseDigest(
  value: Omit<AmberQmmmParseResult, "parseDigest"> | AmberQmmmParseResult,
): string {
  const { parseDigest: _parseDigest, ...payload } = value as AmberQmmmParseResult;
  return digestCanonical(payload);
}

export function assertAmberQmmmParseResult(value: unknown): AmberQmmmParseResult {
  const result = AmberQmmmParseResultSchema.parse(value);
  if (result.parseDigest !== computeAmberQmmmParseDigest(result)) {
    throw new Error(`AMBER QM/MM parse digest mismatch for ${result.source.artifactId}`);
  }
  return result;
}

function numericValue(token: string): number | null {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[EeDd][+-]?\d+)?$/u.test(token)) return null;
  const parsed = Number(token.replace(/[dD]/u, "E"));
  return Number.isFinite(parsed) ? parsed : null;
}

function valuesMatch(expected: number, observed: number | null): boolean {
  if (observed === null) return false;
  return Math.abs(expected - observed) <= Math.max(1e-14, Math.abs(expected) * 1e-8);
}

function stringify(value: unknown): string {
  return Array.isArray(value) ? value.join(",") : String(value);
}

function bindingChecks(
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

/**
 * Parse stable AMBER 26 QM/MM control and result observations. The parser never
 * changes scientific controls: any missing, unsupported, or contradictory
 * observation stops assessment and requires external review.
 */
export function parseAmberQmmmMdout(
  content: string,
  requestValue: unknown,
  authority: AmberQmmmParseAuthority,
): AmberQmmmParseResult {
  const request = AmberQmmmParseRequestSchema.parse(requestValue);
  assertMdStageResultDigest(request.stageResult);
  assertQmmmProtocolDigest(request.protocol);
  if (
    !issuedParseAuthorities.has(authority as object) ||
    authority.bindingDigest !== authorityBindingDigest(request)
  ) {
    throw new Error("QM/MM parsing requires genuine host-validated exact authority");
  }
  const diagnostics: AnalysisDiagnostic[] = [];
  const energySamples: AmberQmmmEnergySample[] = [];
  const observation: AmberQmmmObservation = {
    qmmmEnabled: null,
    qmGeneralizedBornMode: null,
    chargeAdjustmentMode: null,
    theory: null,
    qmCharge: null,
    spinMultiplicity: null,
    qmAtomCount: null,
    qmAtomIndices: [],
    linkAtomCount: null,
    cutoffAngstrom: null,
    scfConvergenceTolerance: null,
    maximumScfIterations: null,
    qmInteractionMode: null,
    qmEwaldMode: null,
    qmPme: null,
    qmShakeMode: null,
    linkAtomicNumber: null,
    linkDistanceAngstrom: null,
    linkMethod: null,
    gradientMethod: null,
    tightDensityConvergence: null,
    verbosity: null,
    printCharges: null,
    printDipole: null,
    peptideCorrection: null,
    qmmmRijIncore: null,
    qmqmErepIncore: null,
    pseudoDiagonalization: null,
    pseudoDiagonalizationCriteria: null,
    diagonalizationRoutine: null,
  };

  if (digestBytes(content) !== request.source.contentDigest) {
    diagnostics.push(
      analysisDiagnostic({
        code: "source_digest_mismatch",
        severity: "fatal",
        message: "Injected QM/MM mdout bytes do not match the exact source artifact digest",
        evidenceRefs: [request.source.evidenceRef],
      }),
    );
  }

  let inQmmmOptions = false;
  let inQmCoordinates = false;
  let inResults = false;
  let inFinalResults = false;
  let terminalMarkerObserved = false;
  let scfFailureObserved = false;
  let cycleLimitObserved = false;
  let qmmmOptionsCount = 0;
  let coordinateSectionCount = 0;
  let resultsSectionCount = 0;
  let finalResultsCount = 0;
  let timingsSectionCount = 0;
  let qmmmOptionsIndex = -1;
  let coordinateSectionIndex = -1;
  let resultsSectionIndex = -1;
  let finalResultsIndex = -1;
  let timingsSectionIndex = -1;
  let finalEnergySample: AmberQmmmEnergySample | null = null;
  const observedControlFields = new Set<string>();

  const addDiagnostic = (code: string, line: number, message: string): void => {
    diagnostics.push(
      analysisDiagnostic({
        code,
        severity: "fatal",
        line,
        message,
        evidenceRefs: [request.source.evidenceRef],
      }),
    );
  };
  const controlAssignmentCount = (raw: string, field: string): number =>
    [...raw.matchAll(new RegExp(`\\b${field}\\s*=`, "giu"))].length;
  const observeNumber = (
    raw: string,
    line: number,
    field: string,
    current: number | null,
    valid: (value: number) => boolean,
  ): number | null => {
    const assignments = controlAssignmentCount(raw, field);
    if (assignments === 0) return current;
    const matches = [...raw.matchAll(new RegExp(`\\b${field}\\s*=\\s*([^\\s,]+)`, "giu"))];
    if (observedControlFields.has(field) || assignments !== 1 || matches.length !== 1) {
      addDiagnostic(
        "qmmm_duplicate_control",
        line,
        `QM/MM runtime control ${field} was observed more than once`,
      );
      observedControlFields.add(field);
      return null;
    }
    observedControlFields.add(field);
    const value = numericValue(matches[0]![1]!);
    if (value === null || !valid(value)) {
      addDiagnostic(
        "qmmm_invalid_control",
        line,
        `QM/MM runtime control ${field} is malformed or outside its contract`,
      );
      return null;
    }
    return value;
  };
  const observeToken = (
    raw: string,
    line: number,
    field: string,
    current: string | null,
  ): string | null => {
    const assignments = controlAssignmentCount(raw, field);
    if (assignments === 0) return current;
    const matches = [...raw.matchAll(new RegExp(`\\b${field}\\s*=\\s*([^\\s,]+)`, "giu"))];
    if (observedControlFields.has(field) || assignments !== 1 || matches.length !== 1) {
      addDiagnostic(
        "qmmm_duplicate_control",
        line,
        `QM/MM runtime control ${field} was observed more than once`,
      );
      observedControlFields.add(field);
      return null;
    }
    observedControlFields.add(field);
    const rawValue = matches[0]![1]!;
    const value =
      rawValue.startsWith("'") && rawValue.endsWith("'") && rawValue.length > 2
        ? rawValue.slice(1, -1)
        : rawValue;
    if (rawValue.includes("'") && rawValue !== `'${value}'`) {
      addDiagnostic("qmmm_invalid_control", line, `QM/MM runtime control ${field} is malformed`);
      return null;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9+_.-]*$/u.test(value)) {
      addDiagnostic("qmmm_invalid_control", line, `QM/MM runtime control ${field} is malformed`);
      return null;
    }
    return value;
  };
  const observeBoolean = (
    raw: string,
    line: number,
    field: string,
    current: boolean | null,
  ): boolean | null => {
    const assignments = controlAssignmentCount(raw, field);
    if (assignments === 0) return current;
    const matches = [...raw.matchAll(new RegExp(`\\b${field}\\s*=\\s*([^\\s,]+)`, "giu"))];
    if (observedControlFields.has(field) || assignments !== 1 || matches.length !== 1) {
      addDiagnostic(
        "qmmm_duplicate_control",
        line,
        `QM/MM runtime control ${field} was observed more than once`,
      );
      observedControlFields.add(field);
      return null;
    }
    observedControlFields.add(field);
    const value = matches[0]![1]!;
    if (!/^(?:True|False)$/u.test(value)) {
      addDiagnostic(
        "qmmm_invalid_control",
        line,
        `QM/MM runtime control ${field} must be exactly True or False`,
      );
      return null;
    }
    return value === "True";
  };

  const lines = content.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]!;
    const line = index + 1;
    if (/^\s*QMMM options:\s*$/u.test(raw)) {
      qmmmOptionsCount += 1;
      qmmmOptionsIndex = qmmmOptionsIndex < 0 ? index : qmmmOptionsIndex;
      inQmmmOptions = true;
    } else if (inQmmmOptions && /^\s*(?:-{8,}|\d+\.\s+)/u.test(raw)) {
      inQmmmOptions = false;
    }
    if (/QMMM:\s+QM Region Cartesian Coordinates/iu.test(raw)) {
      coordinateSectionCount += 1;
      coordinateSectionIndex = coordinateSectionIndex < 0 ? index : coordinateSectionIndex;
      inQmCoordinates = true;
    }
    if (inQmCoordinates && /^\s*-{8,}/u.test(raw)) inQmCoordinates = false;
    if (/^\s*4\.\s+RESULTS\s*$/u.test(raw)) {
      resultsSectionCount += 1;
      resultsSectionIndex = resultsSectionIndex < 0 ? index : resultsSectionIndex;
      inResults = true;
    }
    if (/^\s*FINAL RESULTS\s*$/u.test(raw)) {
      finalResultsCount += 1;
      finalResultsIndex = finalResultsIndex < 0 ? index : finalResultsIndex;
      inFinalResults = true;
    }
    if (/^\s*5\.\s+TIMINGS\s*$/iu.test(raw)) {
      timingsSectionCount += 1;
      timingsSectionIndex = timingsSectionIndex < 0 ? index : timingsSectionIndex;
      if (finalResultsIndex >= 0 && index > finalResultsIndex) terminalMarkerObserved = true;
    }
    if (
      inResults &&
      !inFinalResults &&
      /Maximum number of minimization cycles reached/iu.test(raw)
    ) {
      cycleLimitObserved = true;
    }
    if (
      /(?:QMMM.*(?:SCF|self[- ]consisten).*(?:failed|failure|not converge)|Unable to achieve self consistency)/iu.test(
        raw,
      )
    ) {
      scfFailureObserved = true;
      addDiagnostic("qmmm_scf_failure", line, cleanDiagnosticLine(raw));
    } else if (/SANDER BOMB|PMEMD BOMB|\bFATAL\b|segmentation fault/iu.test(raw)) {
      addDiagnostic("engine_fatal", line, cleanDiagnosticLine(raw));
    }

    if (inQmmmOptions) {
      observation.qmmmEnabled = observeBoolean(raw, line, "ifqnt", observation.qmmmEnabled);
      observation.qmAtomCount = observeNumber(
        raw,
        line,
        "nquant",
        observation.qmAtomCount,
        (value) => Number.isInteger(value) && value > 0,
      );
      observation.qmGeneralizedBornMode = observeNumber(
        raw,
        line,
        "qmgb",
        observation.qmGeneralizedBornMode,
        Number.isInteger,
      );
      observation.chargeAdjustmentMode = observeNumber(
        raw,
        line,
        "adjust_q",
        observation.chargeAdjustmentMode,
        Number.isInteger,
      );
      observation.qmCharge = observeNumber(
        raw,
        line,
        "qmcharge",
        observation.qmCharge,
        Number.isInteger,
      );
      observation.spinMultiplicity = observeNumber(
        raw,
        line,
        "spin",
        observation.spinMultiplicity,
        (value) => Number.isInteger(value) && value > 0,
      );
      observation.cutoffAngstrom = observeNumber(
        raw,
        line,
        "qmcut",
        observation.cutoffAngstrom,
        (value) => value > 0,
      );
      observation.qmShakeMode = observeNumber(
        raw,
        line,
        "qmshake",
        observation.qmShakeMode,
        Number.isInteger,
      );
      observation.linkAtomicNumber = observeNumber(
        raw,
        line,
        "lnk_atomic_no",
        observation.linkAtomicNumber,
        Number.isInteger,
      );
      observation.linkDistanceAngstrom = observeNumber(
        raw,
        line,
        "lnk_dis",
        observation.linkDistanceAngstrom,
        (value) => value > 0,
      );
      observation.linkMethod = observeNumber(
        raw,
        line,
        "lnk_method",
        observation.linkMethod,
        Number.isInteger,
      );
      observation.maximumScfIterations = observeNumber(
        raw,
        line,
        "itrmax",
        observation.maximumScfIterations,
        (value) => Number.isInteger(value) && value > 0,
      );
      observation.scfConvergenceTolerance = observeNumber(
        raw,
        line,
        "scfconv",
        observation.scfConvergenceTolerance,
        (value) => value > 0 && value < 1,
      );
      observation.qmInteractionMode = observeNumber(
        raw,
        line,
        "qmmm_int",
        observation.qmInteractionMode,
        Number.isInteger,
      );
      observation.qmEwaldMode = observeNumber(
        raw,
        line,
        "qm_ewald",
        observation.qmEwaldMode,
        Number.isInteger,
      );
      observation.theory = observeToken(raw, line, "qm_theory", observation.theory);
      observation.gradientMethod = observeToken(raw, line, "qmqmdx", observation.gradientMethod);
      observation.tightDensityConvergence = observeBoolean(
        raw,
        line,
        "tight_p_conv",
        observation.tightDensityConvergence,
      );
      observation.verbosity = observeNumber(
        raw,
        line,
        "verbosity",
        observation.verbosity,
        Number.isInteger,
      );
      observation.printCharges = observeBoolean(
        raw,
        line,
        "printcharges",
        observation.printCharges,
      );
      observation.printDipole = observeBoolean(raw, line, "printdipole", observation.printDipole);
      observation.peptideCorrection = observeBoolean(
        raw,
        line,
        "peptide_corr",
        observation.peptideCorrection,
      );
      observation.qmmmRijIncore = observeBoolean(
        raw,
        line,
        "qmmmrij_incore",
        observation.qmmmRijIncore,
      );
      observation.qmqmErepIncore = observeBoolean(
        raw,
        line,
        "qmqm_erep_incore",
        observation.qmqmErepIncore,
      );
      observation.pseudoDiagonalization = observeBoolean(
        raw,
        line,
        "pseudo_diag",
        observation.pseudoDiagonalization,
      );
      observation.pseudoDiagonalizationCriteria = observeNumber(
        raw,
        line,
        "pseudo_diag_criteria",
        observation.pseudoDiagonalizationCriteria,
        (value) => value > 0,
      );
      observation.diagonalizationRoutine = observeNumber(
        raw,
        line,
        "diag_routine",
        observation.diagonalizationRoutine,
        Number.isInteger,
      );
      observation.qmPme = observeBoolean(raw, line, "qm_pme", observation.qmPme);
    }

    if (inQmCoordinates) {
      const row = raw.match(
        /^\s*QMMM:\s+(\d+)\s+(\d+)\s+\S+\s+([-+0-9.EeDd]+)\s+([-+0-9.EeDd]+)\s+([-+0-9.EeDd]+)\s*$/u,
      );
      if (row?.[2] !== undefined) {
        const qmIndex = Number(row[1]);
        if (qmIndex !== observation.qmAtomIndices.length + 1) {
          addDiagnostic(
            "qmmm_atom_mapping_invalid",
            line,
            "QM atom rows must have a unique contiguous QM index",
          );
        }
        const coordinates = row.slice(3, 6).map(numericValue);
        if (coordinates.some((value) => value === null)) {
          addDiagnostic("qmmm_coordinate_invalid", line, cleanDiagnosticLine(raw));
        }
        observation.qmAtomIndices.push(Number(row[2]));
      } else if (
        /^\s*QMMM:/u.test(raw) &&
        !/QM Region Cartesian Coordinates|QM_NO\.\s+MM_NO\./u.test(raw)
      ) {
        addDiagnostic(
          "qmmm_coordinate_invalid",
          line,
          "Malformed row was present in the QM coordinate section",
        );
      }
    }
    if (/\bnlink\s*=/iu.test(raw)) {
      observation.linkAtomCount = observeNumber(
        raw,
        line,
        "nlink",
        observation.linkAtomCount,
        (value) => Number.isInteger(value) && value >= 0,
      );
    }

    if (inResults) {
      const row = raw.match(
        /^\s*(\d+)\s+([-+0-9.EeDd]+)\s+([-+0-9.EeDd]+)\s+([-+0-9.EeDd]+)\s+(\S+)\s+(\d+)\s*$/u,
      );
      if (row !== null) {
        const values = row.slice(2, 5).map(numericValue);
        if (values.some((value) => value === null)) {
          addDiagnostic("qmmm_numeric_overflow", line, cleanDiagnosticLine(raw));
        } else {
          const sample = {
            sourceLine: line,
            step: Number(row[1]),
            totalEnergyKcalMol: values[0]!,
            rmsGradient: values[1]!,
            maximumGradient: values[2]!,
            maximumGradientAtomName: row[5]!,
            maximumGradientAtomIndex: Number(row[6]),
            qmEnergyKcalMol: null,
          };
          if (inFinalResults) {
            if (finalEnergySample !== null) {
              addDiagnostic(
                "qmmm_final_result_mismatch",
                line,
                "FINAL RESULTS contains more than one energy row",
              );
            } else finalEnergySample = AmberQmmmEnergySampleSchema.parse(sample);
          } else energySamples.push(sample);
        }
      } else if (/^\s*\d+\s+/u.test(raw)) {
        addDiagnostic("qmmm_numeric_overflow", line, "Malformed minimization energy row");
      }
      const energyAssignments = [...raw.matchAll(/\b([A-Za-z0-9+_.-]+)ESCF\s*=/gu)];
      if (energyAssignments.length > 1) {
        addDiagnostic(
          "qmmm_duplicate_energy",
          line,
          "A physical output line contains more than one QM energy assignment",
        );
      }
      const qmEnergy =
        energyAssignments.length === 1
          ? raw.match(/^\s*([A-Za-z0-9+_.-]+)ESCF\s*=\s*([^\s]+)\s*$/u)
          : null;
      if (energyAssignments.length === 1 && qmEnergy === null) {
        addDiagnostic("qmmm_numeric_overflow", line, "Malformed QM energy observation");
      }
      if (qmEnergy?.[2] !== undefined) {
        const value = numericValue(qmEnergy[2]);
        const target = inFinalResults ? finalEnergySample : energySamples.at(-1);
        if (value === null || target == null) {
          addDiagnostic("qmmm_numeric_overflow", line, cleanDiagnosticLine(raw));
        } else if (
          observation.theory === null ||
          qmEnergy[1]!.toUpperCase() !== observation.theory.toUpperCase()
        ) {
          addDiagnostic(
            "qmmm_energy_theory_mismatch",
            line,
            `QM energy label ${qmEnergy[1]} does not match runtime theory ${observation.theory ?? "unobserved"}`,
          );
        } else if (target.qmEnergyKcalMol !== null) {
          addDiagnostic(
            "qmmm_duplicate_energy",
            line,
            "A minimization sample has more than one QM energy observation",
          );
        } else {
          target.qmEnergyKcalMol = value;
        }
      }
    }
  }

  const sectionCounts = [
    qmmmOptionsCount,
    coordinateSectionCount,
    resultsSectionCount,
    finalResultsCount,
    timingsSectionCount,
  ];
  const sectionOrder = [
    qmmmOptionsIndex,
    coordinateSectionIndex,
    resultsSectionIndex,
    finalResultsIndex,
    timingsSectionIndex,
  ];
  if (
    sectionCounts.some((count) => count !== 1) ||
    sectionOrder.some((position) => position < 0) ||
    sectionOrder.some((position, index) => index > 0 && position <= sectionOrder[index - 1]!)
  ) {
    diagnostics.push(
      analysisDiagnostic({
        code: "qmmm_section_integrity",
        severity: "fatal",
        message:
          "QM/MM mdout requires exactly one ordered control, coordinate, result, final, and timing section",
        evidenceRefs: [request.source.evidenceRef],
      }),
    );
  }
  if (
    energySamples.length === 0 ||
    energySamples.some((sample) => sample.qmEnergyKcalMol === null)
  ) {
    diagnostics.push(
      analysisDiagnostic({
        code: "qmmm_result_incomplete",
        severity: "fatal",
        message: "QM/MM minimization requires at least one complete total/QM energy observation",
        evidenceRefs: [request.source.evidenceRef],
      }),
    );
  }
  if (
    energySamples.some(
      (sample, index) =>
        sample.step < request.stageResult.startStep ||
        sample.step > request.stageResult.endStep ||
        sample.maximumGradientAtomIndex > request.protocol.region.atomMap.atomCount ||
        (index > 0 && sample.step <= energySamples[index - 1]!.step),
    ) ||
    (energySamples.length > 0 && energySamples.at(-1)!.step !== request.stageResult.endStep)
  ) {
    diagnostics.push(
      analysisDiagnostic({
        code: "qmmm_step_sequence_mismatch",
        severity: "fatal",
        message:
          "QM/MM minimization steps and maximum-gradient atoms must stay within the exact stage and atom-map bounds",
        evidenceRefs: [request.source.evidenceRef],
      }),
    );
  }

  const checks = bindingChecks(request.protocol, AmberQmmmObservationSchema.parse(observation));
  for (const check of checks) {
    if (check.status === "matched") continue;
    diagnostics.push(
      analysisDiagnostic({
        code:
          check.status === "unsupported"
            ? "qmmm_protocol_control_unsupported"
            : "qmmm_protocol_binding_mismatch",
        severity: "fatal",
        message: `${check.field} expected ${check.expected} but observed ${check.observed ?? "nothing"}`,
        evidenceRefs: [request.source.evidenceRef, request.protocol.approvedByRef!],
      }),
    );
  }

  const stageKindUnsupported = request.stageResult.stageKind !== "minimization";
  if (stageKindUnsupported) {
    diagnostics.push(
      analysisDiagnostic({
        code: "qmmm_stage_kind_unsupported",
        severity: "fatal",
        message: `QM/MM parser v${AmberQmmmParserVersion} supports exact minimization output only`,
        evidenceRefs: [request.source.evidenceRef],
      }),
    );
  }
  if (
    request.stageResult.validationStatus === "failed" ||
    request.stageResult.errors.length > 0 ||
    ["engine_failure", "validation_failure"].includes(request.stageResult.terminalReason)
  ) {
    diagnostics.push(
      analysisDiagnostic({
        code: "qmmm_stage_result_failure",
        severity: "fatal",
        message:
          "The durable stage result records a validation, engine, or normalized execution failure",
        evidenceRefs: [
          request.source.evidenceRef,
          ...request.stageResult.errors.flatMap((error) => error.sourceEvidenceRefs),
        ],
      }),
    );
  }

  const hasUnsupported = checks.some((check) => check.status === "unsupported");
  const hasMismatch = checks.some((check) => ["mismatched", "not_observed"].includes(check.status));
  const hasSourceMismatch = diagnostics.some(
    (diagnostic) => diagnostic.code === "source_digest_mismatch",
  );
  const hasEngineFatal = diagnostics.some((diagnostic) =>
    ["engine_fatal", "qmmm_scf_failure", "qmmm_stage_result_failure"].includes(diagnostic.code),
  );
  const lastIterativeSample = energySamples.at(-1);
  if (
    finalEnergySample === null ||
    finalEnergySample.qmEnergyKcalMol === null ||
    lastIterativeSample === undefined
  ) {
    diagnostics.push(
      analysisDiagnostic({
        code: "qmmm_final_result_mismatch",
        severity: "fatal",
        message: "QM/MM minimization requires one complete FINAL RESULTS energy observation",
        evidenceRefs: [request.source.evidenceRef],
      }),
    );
  } else if (
    finalEnergySample.step !== lastIterativeSample.step ||
    !valuesMatch(finalEnergySample.totalEnergyKcalMol, lastIterativeSample.totalEnergyKcalMol) ||
    !valuesMatch(finalEnergySample.rmsGradient, lastIterativeSample.rmsGradient) ||
    !valuesMatch(finalEnergySample.maximumGradient, lastIterativeSample.maximumGradient) ||
    finalEnergySample.maximumGradientAtomName !== lastIterativeSample.maximumGradientAtomName ||
    finalEnergySample.maximumGradientAtomIndex !== lastIterativeSample.maximumGradientAtomIndex ||
    !valuesMatch(finalEnergySample.qmEnergyKcalMol, lastIterativeSample.qmEnergyKcalMol)
  ) {
    diagnostics.push(
      analysisDiagnostic({
        code: "qmmm_final_result_mismatch",
        severity: "fatal",
        message: "FINAL RESULTS does not agree with the last iterative minimization sample",
        evidenceRefs: [request.source.evidenceRef],
      }),
    );
  }
  const hasStructuralFailure = diagnostics.some((diagnostic) =>
    [
      "qmmm_duplicate_control",
      "qmmm_invalid_control",
      "qmmm_atom_mapping_invalid",
      "qmmm_coordinate_invalid",
      "qmmm_section_integrity",
      "qmmm_result_incomplete",
      "qmmm_numeric_overflow",
      "qmmm_energy_theory_mismatch",
      "qmmm_duplicate_energy",
      "qmmm_final_result_mismatch",
      "qmmm_step_sequence_mismatch",
    ].includes(diagnostic.code),
  );
  let status: AmberQmmmParseResult["status"];
  if (hasSourceMismatch) status = "authority_mismatch";
  else if (request.stageResult.exitCode !== null && request.stageResult.exitCode !== 0) {
    status = "nonzero_exit";
  } else if (request.stageResult.signal !== null || hasEngineFatal || scfFailureObserved) {
    status = "fatal";
  } else if (hasStructuralFailure || hasMismatch) status = "authority_mismatch";
  else if (stageKindUnsupported || hasUnsupported) status = "unsupported_protocol";
  else if (content.trim().length === 0) status = "no_data";
  else if (
    request.executionCompletion !== "confirmed" ||
    request.stageResult.terminalReason !== "completed" ||
    !terminalMarkerObserved
  ) {
    status = "partial";
  } else if (request.stageResult.stageKind === "minimization" && cycleLimitObserved) {
    status = "nonconverged";
  } else status = "completed";

  const unsigned = {
    schemaVersion: AmberQmmmParseSchemaVersion,
    missionId: request.missionId,
    protocol: {
      id: request.protocol.id,
      revision: request.protocol.revision,
      protocolDigest: request.protocol.protocolDigest,
      approvalRef: request.protocol.approvedByRef!,
    },
    // Request validation above admits only this qualified envelope. Keep the
    // emitted evidence type equally narrow rather than mirroring the wider
    // protocol union.
    regionSelectionClass: "all_qm_engine_check" as const,
    stageResult: {
      id: request.stageResult.id,
      revision: request.stageResult.revision,
      resultDigest: request.stageResult.resultDigest,
    },
    source: request.source,
    operationReceiptRef: request.operationReceiptRef,
    parserVersion: request.parserVersion,
    authorityDigest: authority.authorityDigest,
    status,
    terminalMarkerObserved,
    qmScfStatus: scfFailureObserved
      ? ("failed" as const)
      : observation.theory === null
        ? ("not_observed" as const)
        : ("no_failure_reported" as const),
    minimizationCycleLimit:
      request.stageResult.stageKind !== "minimization"
        ? ("not_applicable" as const)
        : cycleLimitObserved
          ? ("reached" as const)
          : terminalMarkerObserved
            ? ("not_reached" as const)
            : ("unknown" as const),
    observations: AmberQmmmObservationSchema.parse(observation),
    bindingChecks: checks,
    energySamples: energySamples.map((sample) => AmberQmmmEnergySampleSchema.parse(sample)),
    diagnostics,
    scientificAssessmentEligible: status === "completed",
    requiresEscalation: status !== "completed",
    automaticScientificCorrectionAllowed: false as const,
  };
  return AmberQmmmParseResultSchema.parse({
    ...unsigned,
    parseDigest: computeAmberQmmmParseDigest(unsigned),
  });
}
