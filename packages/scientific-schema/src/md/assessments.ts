import { z } from "zod";
import { DigestSchema, IdSchema, SemverSchema, TimestampSchema } from "../schemas";
import { MdAssessmentSchemaVersion, StrictActorIdentitySchema } from "./common";
import { assertSelfDigest, canonicalSelfDigest } from "./digests";

export const MdAcceptanceEvaluationSchema = z
  .object({
    criterionId: IdSchema,
    criterionDigest: DigestSchema,
    required: z.boolean(),
    status: z.enum(["passed", "failed", "inconclusive", "not_applicable"]),
    observedValue: z.number().finite().optional(),
    observedUnit: z.string().min(1).optional(),
    summary: z.string().min(1),
    evidenceRefs: z.array(IdSchema).min(1),
  })
  .strict()
  .superRefine((evaluation, context) => {
    if ((evaluation.observedValue === undefined) !== (evaluation.observedUnit === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["observedUnit"],
        message: "An observed value and its unit must be recorded together",
      });
    }
  });

export type MdAcceptanceEvaluation = z.infer<typeof MdAcceptanceEvaluationSchema>;

export const MdStageAssessmentSchema = z
  .object({
    schemaVersion: z.literal(MdAssessmentSchemaVersion),
    id: IdSchema,
    revision: z.number().finite().int().safe().positive(),
    missionId: IdSchema,
    stageResultId: IdSchema,
    stageResultRevision: z.number().finite().int().safe().positive(),
    stageResultDigest: DigestSchema,
    status: z.enum(["accepted", "rejected", "indeterminate"]),
    evaluations: z.array(MdAcceptanceEvaluationSchema).min(1),
    nextStageEligible: z.boolean(),
    limitations: z.array(z.string().min(1)),
    evidenceRefs: z.array(IdSchema).min(1),
    assessor: StrictActorIdentitySchema,
    assessmentDigest: DigestSchema,
    createdAt: TimestampSchema,
  })
  .strict()
  .superRefine((assessment, context) => {
    const hasRequiredNonPass = assessment.evaluations.some(
      (evaluation) => evaluation.required && evaluation.status !== "passed",
    );
    if (assessment.status === "accepted" && hasRequiredNonPass) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "An accepted stage requires every required evaluation to pass",
      });
    }
    if (assessment.nextStageEligible !== (assessment.status === "accepted")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nextStageEligible"],
        message: "Only an accepted stage is eligible to advance",
      });
    }
    const criterionIds = assessment.evaluations.map((evaluation) => evaluation.criterionId);
    if (new Set(criterionIds).size !== criterionIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evaluations"],
        message: "A stage assessment may evaluate each criterion only once",
      });
    }
  });

export type MdStageAssessment = z.infer<typeof MdStageAssessmentSchema>;

export const ReplicaConvergenceAssessmentSchema = z
  .object({
    schemaVersion: z.literal(MdAssessmentSchemaVersion),
    id: IdSchema,
    revision: z.number().finite().int().safe().positive(),
    missionId: IdSchema,
    replicaSetId: IdSchema,
    replicaIds: z.array(IdSchema).min(2),
    status: z.enum(["converged", "not_converged", "indeterminate"]),
    observables: z
      .array(
        z
          .object({
            name: z.string().min(1),
            unit: z.string().min(1),
            method: z.string().min(1),
            effectiveSampleSize: z.number().finite().positive().optional(),
            betweenReplicaAssessment: z.string().min(1),
            evidenceRefs: z.array(IdSchema).min(1),
          })
          .strict(),
      )
      .min(1),
    samplingLimitations: z.array(z.string().min(1)).min(1),
    extensionDecisionRequired: z.boolean(),
    assessorVersion: SemverSchema,
    assessmentDigest: DigestSchema,
    createdAt: TimestampSchema,
  })
  .strict()
  .superRefine((assessment, context) => {
    if (new Set(assessment.replicaIds).size !== assessment.replicaIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["replicaIds"],
        message: "Convergence assessment replica identifiers must be unique",
      });
    }
    if (assessment.status === "converged" && assessment.extensionDecisionRequired) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["extensionDecisionRequired"],
        message: "A converged assessment cannot require a sampling extension",
      });
    }
  });

export type ReplicaConvergenceAssessment = z.infer<typeof ReplicaConvergenceAssessmentSchema>;

export const MdScientificAssessmentSchema = z
  .object({
    schemaVersion: z.literal(MdAssessmentSchemaVersion),
    id: IdSchema,
    revision: z.number().finite().int().safe().positive(),
    missionId: IdSchema,
    systemManifestId: IdSchema,
    systemManifestRevision: z.number().finite().int().safe().positive(),
    systemManifestDigest: DigestSchema,
    protocolId: IdSchema,
    protocolRevision: z.number().finite().int().safe().positive(),
    protocolDigest: DigestSchema,
    status: z.enum(["supported", "partially_supported", "inconclusive", "refuted"]),
    claims: z
      .array(
        z
          .object({
            statement: z.string().min(1),
            support: z.enum(["supported", "limited", "unsupported"]),
            evidenceRefs: z.array(IdSchema).min(1),
          })
          .strict(),
      )
      .min(1),
    uncertaintySources: z.array(z.string().min(1)).min(1),
    limitations: z.array(z.string().min(1)).min(1),
    stageAssessmentRefs: z.array(IdSchema).min(1),
    convergenceAssessmentRef: IdSchema.optional(),
    decisionRefs: z.array(IdSchema).min(1),
    generatedBy: StrictActorIdentitySchema,
    reviewedBy: z.array(StrictActorIdentitySchema),
    assessmentDigest: DigestSchema,
    createdAt: TimestampSchema,
  })
  .strict()
  .superRefine((assessment, context) => {
    const claimSupport = assessment.claims.map((claim) => claim.support);
    if (
      assessment.status === "supported" &&
      claimSupport.some((support) => support !== "supported")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "A supported assessment requires every claim to be supported",
      });
    }
    if (
      assessment.status === "refuted" &&
      claimSupport.some((support) => support !== "unsupported")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "A refuted assessment requires every claim to be unsupported",
      });
    }
    if (
      assessment.status === "partially_supported" &&
      (claimSupport.every((support) => support === "supported") ||
        claimSupport.every((support) => support === "unsupported"))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "A partially supported assessment requires mixed or limited claim support",
      });
    }
    if (
      assessment.status === "supported" &&
      !assessment.reviewedBy.some((reviewer) => reviewer.kind === "human")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reviewedBy"],
        message: "A supported scientific assessment requires human review",
      });
    }
    const reviewerIds = assessment.reviewedBy.map((reviewer) => reviewer.id);
    if (new Set(reviewerIds).size !== reviewerIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reviewedBy"],
        message: "Scientific assessment reviewers must be unique",
      });
    }
  });

export type MdScientificAssessment = z.infer<typeof MdScientificAssessmentSchema>;

/** Digests every stage-assessment field except `assessmentDigest` itself. */
export function computeMdStageAssessmentDigest(value: object): string {
  return canonicalSelfDigest(value, "assessmentDigest");
}

/** Validates an exact stage assessment before it may authorize downstream work. */
export function assertMdStageAssessmentDigest(value: unknown): MdStageAssessment {
  const assessment = MdStageAssessmentSchema.parse(value);
  return assertSelfDigest(
    "MdStageAssessment",
    assessment,
    assessment.assessmentDigest,
    "assessmentDigest",
  );
}
