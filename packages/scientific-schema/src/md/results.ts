import { z } from "zod";
import { EngineBuildIdentitySchema } from "../biomolecular";
import { DigestSchema, IdSchema, TimestampSchema } from "../schemas";
import { MdArtifactReferenceSchema, MdStageKindSchema, MdStageResultSchemaVersion } from "./common";
import { assertSelfDigest, canonicalSelfDigest } from "./digests";
import { MdDiagnosticMessageSchema } from "./metrics";

export const MdStageResultSchema = z
  .object({
    schemaVersion: z.literal(MdStageResultSchemaVersion),
    id: IdSchema,
    revision: z.number().finite().int().safe().positive(),
    missionId: IdSchema,
    workUnitId: IdSchema,
    operationId: IdSchema,
    operationReceiptId: IdSchema,
    protocolId: IdSchema,
    protocolRevision: z.number().finite().int().safe().positive(),
    protocolDigest: DigestSchema,
    stageId: IdSchema,
    stageRevision: z.number().finite().int().safe().positive(),
    stageDigest: DigestSchema,
    stageKind: MdStageKindSchema,
    replicaSetId: IdSchema.optional(),
    replicaSetRevision: z.number().finite().int().safe().positive().optional(),
    replicaSetDigest: DigestSchema.optional(),
    replicaId: IdSchema.optional(),
    segmentIndex: z.number().finite().int().safe().nonnegative().optional(),
    parentRestartDigest: DigestSchema.optional(),
    terminalReason: z.enum([
      "completed",
      "cancelled",
      "timeout",
      "signal",
      "engine_failure",
      "validation_failure",
      "ambiguous",
    ]),
    exitCode: z.number().finite().int().safe().nonnegative().nullable(),
    signal: z.string().min(1).nullable(),
    startedAt: TimestampSchema,
    finishedAt: TimestampSchema,
    startStep: z.number().finite().int().safe().nonnegative(),
    endStep: z.number().finite().int().safe().nonnegative(),
    startTimePs: z.number().finite().nonnegative(),
    endTimePs: z.number().finite().nonnegative(),
    engine: EngineBuildIdentitySchema,
    gpu: z
      .object({
        model: z.string().min(1),
        driverVersion: z.string().min(1),
        runtimeVersion: z.string().min(1),
        deviceUuidDigest: DigestSchema,
      })
      .strict()
      .optional(),
    artifacts: z.array(MdArtifactReferenceSchema),
    normalizedMetricsRef: MdArtifactReferenceSchema.optional(),
    warnings: z.array(MdDiagnosticMessageSchema),
    errors: z.array(MdDiagnosticMessageSchema),
    validationStatus: z.enum(["passed", "failed", "inconclusive", "not_run"]),
    validationRefs: z.array(IdSchema),
    resultDigest: DigestSchema,
  })
  .strict()
  .superRefine((result, context) => {
    const segmentBinding = [
      result.replicaSetId,
      result.replicaSetRevision,
      result.replicaSetDigest,
      result.replicaId,
      result.segmentIndex,
      result.parentRestartDigest,
    ];
    const segmentBindingCount = segmentBinding.filter((value) => value !== undefined).length;
    if (segmentBindingCount !== 0 && segmentBindingCount !== segmentBinding.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["replicaSetId"],
        message: "Replica-set, replica, segment, and parent-restart identity are all-or-none",
      });
    }
    if (result.stageKind === "production" && segmentBindingCount !== segmentBinding.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["segmentIndex"],
        message: "Every production result must identify its exact replica segment",
      });
    }
    if (result.stageKind !== "production" && segmentBindingCount !== 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["replicaSetId"],
        message: "Replica segments are valid only for production stage results",
      });
    }
    if (Date.parse(result.finishedAt) < Date.parse(result.startedAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["finishedAt"],
        message: "A stage result cannot finish before it starts",
      });
    }
    if (result.endStep < result.startStep || result.endTimePs < result.startTimePs) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endStep"],
        message: "A stage result cannot move backward in step or simulated time",
      });
    }
    const roles = result.artifacts.map((artifact) => artifact.role);
    if (new Set(roles).size !== roles.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["artifacts"],
        message: "A stage result may record each canonical artifact role only once",
      });
    }
    if (result.terminalReason === "completed") {
      if (result.exitCode !== 0 || result.signal !== null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["exitCode"],
          message: "A completed stage requires exit code zero and no signal",
        });
      }
      for (const role of ["restart", "mdout", "mdinfo"] as const) {
        if (!result.artifacts.some((artifact) => artifact.role === role)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["artifacts"],
            message: `A completed stage result requires its ${role} artifact`,
          });
        }
      }
      if (
        result.stageKind === "production" &&
        !result.artifacts.some((artifact) => artifact.role === "trajectory")
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["artifacts"],
          message: "A completed production result requires a trajectory artifact",
        });
      }
    }
    if (result.terminalReason === "signal" && result.signal === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["signal"],
        message: "Signal termination must identify the observed signal",
      });
    }
    if (
      result.normalizedMetricsRef !== undefined &&
      result.normalizedMetricsRef.role !== "normalized_metrics"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["normalizedMetricsRef", "role"],
        message: "Normalized metrics reference must use the normalized_metrics role",
      });
    }
    if (result.warnings.some((warning) => !["info", "warning"].includes(warning.severity))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["warnings"],
        message: "Warnings may contain only info or warning diagnostics",
      });
    }
    if (result.errors.some((error) => !["error", "fatal"].includes(error.severity))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["errors"],
        message: "Errors may contain only error or fatal diagnostics",
      });
    }
    if (
      ["engine_failure", "validation_failure"].includes(result.terminalReason) &&
      result.errors.length === 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["errors"],
        message: "Engine and validation failures require a normalized error diagnostic",
      });
    }
  });

export type MdStageResult = z.infer<typeof MdStageResultSchema>;

/** Digests every normalized result field except `resultDigest` itself. */
export function computeMdStageResultDigest(value: object): string {
  return canonicalSelfDigest(value, "resultDigest");
}

/** Validates both the result schema and its canonical self-digest. */
export function assertMdStageResultDigest(value: unknown): MdStageResult {
  const result = MdStageResultSchema.parse(value);
  return assertSelfDigest("MdStageResult", result, result.resultDigest, "resultDigest");
}
