import { IdSchema, MdArtifactReferenceSchema, digestCanonical } from "@eigengrid/scientific-schema";
import { z } from "zod";
import { AnalysisDiagnosticSchema } from "../contracts";
import {
  AmberQmmmBindingCheckSchema,
  AmberQmmmBindingFields,
  AmberQmmmEnergySampleSchema,
  AmberQmmmObservationSchema,
} from "./observations";
import { AmberQmmmParseSchemaVersion, AmberQmmmParserVersion } from "./versions";

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
