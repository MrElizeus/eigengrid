import {
  DigestSchema,
  IdSchema,
  MdMetricNameSchema,
  SemverSchema,
} from "@eigengrid/scientific-schema";
import { z } from "zod";

export const MdAnalysisPlanSchemaVersion = "eigengrid.md-analysis-plan/v1" as const;
export const MdAnalysisRenderSchemaVersion = "eigengrid.md-analysis-render/v1" as const;
export const MdAnalysisParseSchemaVersion = "eigengrid.md-analysis-parse/v2" as const;
export const CpptrajAnalysisPlanSchemaVersion = "eigengrid.cpptraj-analysis-plan/v3" as const;
export const CpptrajTableParseSchemaVersion = "eigengrid.cpptraj-table-parse/v2" as const;
export const CpptrajMetricSeriesSchemaVersion = "eigengrid.cpptraj-metric-series/v1" as const;
export const TrajectoryInspectionSchemaVersion = "eigengrid.trajectory-inspection/v1" as const;
export const TrajectoryQcSchemaVersion = "eigengrid.trajectory-qc/v2" as const;
export const MdDiagnosisSchemaVersion = "eigengrid.md-diagnosis/v1" as const;

const NullableFiniteNumberSchema = z.number().finite().nullable();

/**
 * Byte-level trajectory observations shared by decoders and QC projections.
 * They describe what an inspector observed; they are not scientific criteria
 * or caller-supplied trajectory metadata.
 */
export const TrajectoryByteTimeObservationSchema = z
  .object({
    status: z.enum([
      "not_applicable",
      "missing",
      "single_frame",
      "strictly_increasing",
      "duplicate",
      "nonmonotonic",
      "non_finite",
    ]),
    cadenceStatus: z.enum(["not_applicable", "missing", "single_frame", "uniform", "irregular"]),
    count: z.number().int().nonnegative(),
    firstPs: NullableFiniteNumberSchema,
    lastPs: NullableFiniteNumberSchema,
    minDeltaPs: NullableFiniteNumberSchema,
    maxDeltaPs: NullableFiniteNumberSchema,
    precisionPs: z.number().finite().positive().nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const noSamples = value.status === "not_applicable" || value.status === "missing";
    if (noSamples && (value.count !== 0 || value.firstPs !== null || value.lastPs !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Missing/not-applicable trajectory time observations cannot carry samples",
      });
    }
    if (
      ["single_frame", "strictly_increasing", "duplicate", "nonmonotonic"].includes(value.status) &&
      (value.count === 0 ||
        value.firstPs === null ||
        value.lastPs === null ||
        value.precisionPs === null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Decoded trajectory time observations require count, bounds, and format precision",
      });
    }
    if (value.status === "single_frame" && value.count !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A single-frame trajectory time observation must contain one sample",
      });
    }
    if (
      value.count <= 1 &&
      !["single_frame", "missing", "not_applicable", "non_finite"].includes(value.status)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Multi-frame trajectory time status requires multiple samples",
      });
    }
    if (
      value.status === "strictly_increasing" &&
      value.count > 1 &&
      !["uniform", "irregular"].includes(value.cadenceStatus)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Increasing multi-frame trajectory time requires a cadence observation",
      });
    }
  });
export type TrajectoryByteTimeObservation = z.infer<typeof TrajectoryByteTimeObservationSchema>;

export const TrajectoryByteCellObservationSchema = z
  .object({
    status: z.enum([
      "not_applicable",
      "not_present",
      "partial",
      "complete",
      "non_finite",
      "malformed",
    ]),
    frameCount: z.number().int().positive().nullable(),
    variableAcrossFrames: z.boolean().nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      ["not_applicable", "not_present", "partial"].includes(value.status) &&
      (value.frameCount !== null || value.variableAcrossFrames !== null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Absent trajectory cell observations cannot carry decoded cell metadata",
      });
    }
    if (
      ["complete", "non_finite", "malformed"].includes(value.status) &&
      (value.frameCount === null || value.variableAcrossFrames === null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Decoded trajectory cell observations require frame count and variability state",
      });
    }
  });
export type TrajectoryByteCellObservation = z.infer<typeof TrajectoryByteCellObservationSchema>;

export const TrajectoryByteEvidenceSchema = z
  .object({
    finiteValues: z.boolean().nullable(),
    time: TrajectoryByteTimeObservationSchema,
    cell: TrajectoryByteCellObservationSchema,
  })
  .strict();
export type TrajectoryByteEvidence = z.infer<typeof TrajectoryByteEvidenceSchema>;

const LogicalPathSegmentSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);

/**
 * Workspace-relative logical identifier. Resolution to a host path belongs to
 * the execution coordinator, never this package.
 */
export const AnalysisLogicalPathSchema = z
  .string()
  .min(1)
  .max(512)
  .superRefine((path, context) => {
    if (
      path.startsWith("/") ||
      path.startsWith("\\") ||
      path.includes("\\") ||
      /^[A-Za-z]:/u.test(path)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Analysis paths must be workspace-relative POSIX logical paths",
      });
      return;
    }
    for (const [index, segment] of path.split("/").entries()) {
      if (!LogicalPathSegmentSchema.safeParse(segment).success) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: "Analysis paths may not contain traversal or special path segments",
        });
      }
    }
  });
export type AnalysisLogicalPath = z.infer<typeof AnalysisLogicalPathSchema>;

export const AnalysisDiagnosticSchema = z
  .object({
    code: z.string().regex(/^[a-z][a-z0-9_]*$/u),
    severity: z.enum(["info", "warning", "error", "fatal"]),
    message: z.string().min(1).max(2048),
    line: z.number().int().positive().optional(),
    evidenceRefs: z.array(IdSchema),
  })
  .strict();
export type AnalysisDiagnostic = z.infer<typeof AnalysisDiagnosticSchema>;

export const ParserIdentitySchema = z
  .object({
    id: z.string().min(1),
    version: SemverSchema,
  })
  .strict();
export type ParserIdentity = z.infer<typeof ParserIdentitySchema>;

export const ExactArtifactDigestSchema = z
  .object({
    artifactId: IdSchema,
    evidenceRef: IdSchema,
    contentDigest: DigestSchema,
  })
  .strict();
export type ExactArtifactDigest = z.infer<typeof ExactArtifactDigestSchema>;

/** Exact numeric table contract carried by a digested CPPTRAJ analysis plan. */
export const CpptrajColumnSchema = z
  .object({
    sourceName: z.string().min(1).max(128),
    valueKind: z.enum(["integer", "number"]),
    semantic: z.enum(["frame", "time_ps", "index", "value", "auxiliary"]),
    unit: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((column, context) => {
    if (["frame", "index"].includes(column.semantic) && column.valueKind !== "integer") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["valueKind"],
        message: "Frame and index columns must contain integers",
      });
    }
    if (column.semantic === "value" && column.unit === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["unit"],
        message: "Scientific value columns require an exact unit",
      });
    }
  });
export type CpptrajColumn = z.infer<typeof CpptrajColumnSchema>;

export const CpptrajFrameMappingSchema = z
  .object({
    frameColumn: z.string().min(1).max(128),
    firstFrame: z.number().int().nonnegative(),
    firstStep: z.number().int().nonnegative(),
    cadenceSteps: z.number().int().positive(),
    firstTimePs: z.number().nonnegative(),
    cadenceTimePs: z.number().positive(),
  })
  .strict();
export type CpptrajFrameMapping = z.infer<typeof CpptrajFrameMappingSchema>;

export const CpptrajFrameSeriesContractSchema = z
  .object({
    metric: MdMetricNameSchema,
    customMetricName: z.string().min(1).max(256).optional(),
    valueColumn: z.string().min(1).max(128),
    unit: z.string().min(1).max(64),
    frameMapping: CpptrajFrameMappingSchema,
  })
  .strict()
  .superRefine((normalization, context) => {
    if ((normalization.metric === "custom") !== (normalization.customMetricName !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["customMetricName"],
        message: "Only custom metrics must provide a custom metric name",
      });
    }
  });
export type CpptrajFrameSeriesContract = z.infer<typeof CpptrajFrameSeriesContractSchema>;

export const CpptrajTableOutputContractSchema = z
  .object({
    format: z.enum(["whitespace", "csv"]),
    headerStyle: z.enum(["plain", "commented"]),
    columns: z.array(CpptrajColumnSchema).min(2).max(64),
    expectedRowCount: z.number().int().nonnegative().optional(),
    normalization: CpptrajFrameSeriesContractSchema.nullable(),
  })
  .strict()
  .superRefine((contract, context) => {
    const names = contract.columns.map((column) => column.sourceName);
    if (new Set(names).size !== names.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["columns"],
        message: "CPPTRAJ output columns must have unique source names",
      });
    }
    const axisColumns = contract.columns.filter((column) =>
      ["frame", "time_ps", "index"].includes(column.semantic),
    );
    if (axisColumns.length !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["columns"],
        message: "CPPTRAJ output contracts require exactly one declared axis",
      });
    }
    if (!contract.columns.some((column) => column.semantic === "value")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["columns"],
        message: "CPPTRAJ output contracts require at least one scientific value column",
      });
    }
    if (contract.normalization !== null) {
      const frame = contract.columns.find(
        (column) => column.sourceName === contract.normalization!.frameMapping.frameColumn,
      );
      const value = contract.columns.find(
        (column) => column.sourceName === contract.normalization!.valueColumn,
      );
      if (frame?.semantic !== "frame") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["normalization", "frameMapping", "frameColumn"],
          message: "Frame-series normalization must use the exact declared frame column",
        });
      }
      if (value?.semantic !== "value" || value.unit !== contract.normalization.unit) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["normalization", "valueColumn"],
          message: "Normalized metric and unit must match the exact declared value column",
        });
      }
    }
  });
export type CpptrajTableOutputContract = z.infer<typeof CpptrajTableOutputContractSchema>;

/** Immutable identity copied into parse and normalization products. */
export const CpptrajOutputProvenanceSchema = z
  .object({
    planId: IdSchema,
    planRevision: z.number().int().positive(),
    planDigest: DigestSchema,
    stageResultId: IdSchema,
    replicaId: IdSchema.optional(),
    analysisKind: z.enum(["rmsd", "rmsf", "distance", "hbond"]),
    outputName: IdSchema,
    outputPath: AnalysisLogicalPathSchema,
    outputContractDigest: DigestSchema,
  })
  .strict();
export type CpptrajOutputProvenance = z.infer<typeof CpptrajOutputProvenanceSchema>;

export function cleanDiagnosticLine(line: string): string {
  return line.trim().replace(/\s+/gu, " ").slice(0, 2048);
}

export function analysisDiagnostic(
  input: z.input<typeof AnalysisDiagnosticSchema>,
): AnalysisDiagnostic {
  return AnalysisDiagnosticSchema.parse(input);
}
