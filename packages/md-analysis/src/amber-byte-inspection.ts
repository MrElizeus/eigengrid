import { DigestSchema, IdSchema, type MdArtifactReference } from "@eigengrid/scientific-schema";
import { z } from "zod";
import {
  AnalysisDiagnosticSchema,
  ParserIdentitySchema,
  TrajectoryByteCellObservationSchema,
  TrajectoryByteEvidenceSchema,
  TrajectoryByteTimeObservationSchema,
  TrajectoryInspectionSchemaVersion,
  analysisDiagnostic,
} from "./contracts";
import {
  TrajectoryInspectionResultSchema,
  trajectoryArtifact,
  type TrajectoryInspectionResult,
} from "./trajectory-qc";

/** Wire contract emitted by the dependency-free Python AMBER byte decoder. */
export const AmberByteInspectionSchemaVersion = "eigengrid.amber-byte-inspection/v1" as const;
export const AmberMinimizationParseSchemaVersion = "eigengrid.amber-minimization-parse/v1" as const;

const AmberByteDiagnosticSchema = z
  .object({
    code: z.string().regex(/^[a-z][a-z0-9_]*$/u),
    severity: z.enum(["info", "warning", "error", "fatal"]),
    message: z.string().min(1).max(2048),
  })
  .strict();
export type AmberByteDiagnostic = z.infer<typeof AmberByteDiagnosticSchema>;

/** AMBER wire aliases keep the raw decoder contract explicit and reusable. */
export const AmberByteTimeObservationSchema = TrajectoryByteTimeObservationSchema;
export type AmberByteTimeObservation = z.infer<typeof AmberByteTimeObservationSchema>;
export const AmberByteCellObservationSchema = TrajectoryByteCellObservationSchema;
export type AmberByteCellObservation = z.infer<typeof AmberByteCellObservationSchema>;

/**
 * A real observation only. The caller cannot supply atom/frame/time values to
 * make a result look decoded: it can merely compare this response to an
 * immutable artifact and a predeclared stage contract after validation.
 */
export const AmberByteInspectionSchema = z
  .object({
    schemaVersion: z.literal(AmberByteInspectionSchemaVersion),
    decoder: ParserIdentitySchema,
    artifactKind: z.enum(["prmtop", "restart", "trajectory"]),
    observedContentDigest: DigestSchema,
    byteLength: z.number().int().nonnegative(),
    format: z.enum(["amber_netcdf", "amber_ascii_restart", "amber_prmtop"]),
    inspectionLevel: z.enum(["decoded", "metadata_only"]),
    readStatus: z.enum(["complete", "truncated", "unreadable"]),
    convention: z.string().min(1).max(256).nullable(),
    atomCount: z.number().int().positive().nullable(),
    frameCount: z.number().int().positive().nullable(),
    hasPeriodicBox: z.boolean().nullable(),
    // Additive v0.1.3 byte evidence: absent in historical records, never inferred as true.
    hasVelocities: z.boolean().nullable().optional(),
    finiteValues: z.boolean().nullable(),
    dimensions: z
      .record(z.number().int().nonnegative())
      .refine(
        (dimensions) => Object.keys(dimensions).length <= 256,
        "AMBER decoder returned too many dimensions",
      ),
    time: AmberByteTimeObservationSchema,
    cell: AmberByteCellObservationSchema,
    atomIdentityDigest: DigestSchema.nullable(),
    diagnostics: z.array(AmberByteDiagnosticSchema).max(256),
  })
  .strict()
  .superRefine((value, context) => {
    const diagnosticFailure = value.diagnostics.some((item) =>
      ["error", "fatal"].includes(item.severity),
    );
    if (value.inspectionLevel === "metadata_only") {
      if (
        value.atomCount !== null ||
        value.frameCount !== null ||
        value.hasPeriodicBox !== null ||
        value.finiteValues !== null ||
        Object.keys(value.dimensions).length !== 0 ||
        value.convention !== null ||
        value.atomIdentityDigest !== null ||
        value.time.status !== "not_applicable" ||
        value.cell.status !== "not_applicable"
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Metadata-only AMBER inspection may not make decoded-byte claims",
        });
      }
      return;
    }
    if (value.readStatus !== "complete" && !diagnosticFailure) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Truncated or unreadable AMBER byte decode requires an error diagnostic",
      });
    }
    if (value.readStatus !== "complete") return;
    if (value.artifactKind === "trajectory") {
      if (
        value.format !== "amber_netcdf" ||
        value.atomCount === null ||
        value.frameCount === null ||
        value.hasPeriodicBox === null ||
        value.finiteValues === null ||
        value.dimensions.atom !== value.atomCount ||
        value.dimensions.frame !== value.frameCount
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "A decoded trajectory requires NetCDF atom/frame observations from bytes",
        });
      }
      if (
        value.time.count !== value.frameCount ||
        (value.cell.status === "complete" && value.cell.frameCount !== value.frameCount)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Decoded trajectory time and complete-cell observations must cover every frame",
        });
      }
      const intrinsicFailure =
        value.finiteValues !== true ||
        ["missing", "duplicate", "nonmonotonic", "non_finite"].includes(value.time.status) ||
        ["partial", "non_finite", "malformed"].includes(value.cell.status) ||
        (value.hasPeriodicBox === true && value.cell.status !== "complete");
      if (intrinsicFailure && !diagnosticFailure) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "A decoded trajectory with invalid finite/time/cell observations requires an error diagnostic",
        });
      }
    }
    if (value.artifactKind === "restart" && (value.atomCount === null || value.frameCount !== 1)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A decoded restart requires its observed atom count and one frame",
      });
    }
    if (value.artifactKind === "restart") {
      if (
        !["amber_netcdf", "amber_ascii_restart"].includes(value.format) ||
        value.dimensions.atom !== value.atomCount ||
        value.dimensions.spatial !== 3
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Restart format and decoded atom/spatial dimensions must agree",
        });
      }
      const invalidNumeric =
        value.finiteValues !== true ||
        ["duplicate", "nonmonotonic", "non_finite"].includes(value.time.status) ||
        ["partial", "non_finite", "malformed"].includes(value.cell.status) ||
        (value.hasPeriodicBox === true &&
          (value.cell.status !== "complete" || value.cell.frameCount !== 1));
      if (invalidNumeric && !diagnosticFailure) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Invalid restart numeric/cell observations require an error diagnostic",
        });
      }
      // An initial ASCII coordinate file may have no time; continuation consumers must require one.
      if (
        value.time.status === "single_frame" &&
        (value.time.count !== 1 ||
          value.time.firstPs === null ||
          value.time.lastPs !== value.time.firstPs ||
          value.time.firstPs < 0)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "A restart timestamp must describe one nonnegative instant",
        });
      }
    }
    if (value.artifactKind === "prmtop" && value.atomCount === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A decoded prmtop requires its observed NATOM",
      });
    }
  });
export type AmberByteInspection = z.infer<typeof AmberByteInspectionSchema>;

export function assertAmberByteInspection(value: unknown): AmberByteInspection {
  return AmberByteInspectionSchema.parse(value);
}

/** Returns observed representational precision, never a scientific tolerance. */
export function observedAmberTimeResolutionPs(value: unknown): number | null {
  return assertAmberByteInspection(value).time.precisionPs;
}

export const AmberTrajectoryInspectionBindingSchema = z
  .object({
    artifactId: IdSchema,
    evidenceRef: IdSchema,
    expectedContentDigest: DigestSchema,
    operationReceiptRef: IdSchema,
  })
  .strict();
export type AmberTrajectoryInspectionBinding = z.infer<
  typeof AmberTrajectoryInspectionBindingSchema
>;

function intrinsicTrajectoryDiagnostics(
  inspection: AmberByteInspection,
  binding: AmberTrajectoryInspectionBinding,
) {
  if (inspection.artifactKind !== "trajectory") return [];
  const diagnostics: Array<{ code: string; severity: "error"; message: string }> = [];
  if (inspection.finiteValues !== true) {
    diagnostics.push({
      code: "trajectory_non_finite_values",
      severity: "error",
      message: "Decoded trajectory bytes contain non-finite or unverified numeric values",
    });
  }
  if (["missing", "duplicate", "nonmonotonic", "non_finite"].includes(inspection.time.status)) {
    diagnostics.push({
      code: "trajectory_invalid_time_observation",
      severity: "error",
      message: `Decoded trajectory time observation is ${inspection.time.status}`,
    });
  }
  if (
    ["partial", "non_finite", "malformed"].includes(inspection.cell.status) ||
    (inspection.hasPeriodicBox === true && inspection.cell.status !== "complete")
  ) {
    diagnostics.push({
      code: "trajectory_invalid_cell_observation",
      severity: "error",
      message: `Decoded trajectory cell observation is ${inspection.cell.status}`,
    });
  }
  return diagnostics.map((diagnostic) =>
    AnalysisDiagnosticSchema.parse(
      analysisDiagnostic({ ...diagnostic, evidenceRefs: [binding.evidenceRef] }),
    ),
  );
}

function boundDiagnostics(
  inspection: AmberByteInspection,
  binding: AmberTrajectoryInspectionBinding,
) {
  const raw = inspection.diagnostics.map((diagnostic) =>
    AnalysisDiagnosticSchema.parse(
      analysisDiagnostic({
        code: diagnostic.code,
        severity: diagnostic.severity,
        message: diagnostic.message,
        evidenceRefs: [binding.evidenceRef],
      }),
    ),
  );
  const existingCodes = new Set(raw.map((diagnostic) => diagnostic.code));
  return [
    ...raw,
    ...intrinsicTrajectoryDiagnostics(inspection, binding).filter(
      (diagnostic) => !existingCodes.has(diagnostic.code),
    ),
  ];
}

/**
 * Bind a Python decoder observation to the exact artifact selected by the
 * coordinator. A digest mismatch is preserved as an observed mismatch for QC;
 * it cannot turn into a success merely because the caller supplied metadata.
 */
export function bindAmberTrajectoryInspection(
  inspectionValue: unknown,
  bindingValue: unknown,
): TrajectoryInspectionResult {
  const inspection = assertAmberByteInspection(inspectionValue);
  const binding = AmberTrajectoryInspectionBindingSchema.parse(bindingValue);
  if (inspection.artifactKind !== "trajectory")
    throw new Error("Only a trajectory byte observation may bind a trajectory inspection");
  const decodedNetcdf =
    inspection.inspectionLevel === "decoded" && inspection.format === "amber_netcdf";
  const byteEvidence = decodedNetcdf
    ? TrajectoryByteEvidenceSchema.parse({
        finiteValues: inspection.finiteValues,
        time: inspection.time,
        cell: inspection.cell,
      })
    : undefined;
  const result = {
    schemaVersion: TrajectoryInspectionSchemaVersion,
    artifactId: binding.artifactId,
    evidenceRef: binding.evidenceRef,
    expectedContentDigest: binding.expectedContentDigest,
    observedContentDigest: inspection.observedContentDigest,
    inspectorId: inspection.decoder.id,
    inspectorVersion: inspection.decoder.version,
    operationReceiptRef: binding.operationReceiptRef,
    inspectionLevel: decodedNetcdf ? ("decoded_netcdf" as const) : ("metadata_only" as const),
    readStatus: inspection.readStatus,
    convention: inspection.convention,
    atomCount: inspection.atomCount,
    frameCount: inspection.frameCount,
    hasPeriodicBox: inspection.hasPeriodicBox,
    byteLength: inspection.byteLength,
    byteEvidence,
    diagnostics: boundDiagnostics(inspection, binding),
  };
  return TrajectoryInspectionResultSchema.parse(result);
}

/**
 * A narrow convenience guard for callers that already hold a canonical
 * scientific-schema artifact. It refuses roles other than trajectory before
 * the Python response is considered.
 */
export function bindAmberTrajectoryArtifactInspection(
  inspectionValue: unknown,
  artifact: MdArtifactReference,
  operationReceiptRef: string,
): TrajectoryInspectionResult {
  const trajectory = trajectoryArtifact(artifact);
  return bindAmberTrajectoryInspection(inspectionValue, {
    artifactId: trajectory.artifactId,
    evidenceRef: trajectory.evidenceRef,
    expectedContentDigest: trajectory.contentDigest,
    operationReceiptRef,
  });
}

export const AmberMinimizationSampleSchema = z
  .object({
    step: z.number().int().nonnegative(),
    energyKcalMol: z.number().finite(),
    rmsGradientKcalMolAngstrom: z.number().finite().nonnegative(),
    gmaxKcalMolAngstrom: z.number().finite().nonnegative(),
    maxGradientAtomName: z.string().min(1).max(16),
    maxGradientAtomNumber: z.number().int().positive(),
    line: z.number().int().positive(),
  })
  .strict();
export type AmberMinimizationSample = z.infer<typeof AmberMinimizationSampleSchema>;

export const AmberMinimizationParseResultSchema = z
  .object({
    schemaVersion: z.literal(AmberMinimizationParseSchemaVersion),
    parser: ParserIdentitySchema,
    observedContentDigest: DigestSchema,
    byteLength: z.number().int().nonnegative(),
    status: z.enum(["completed", "partial", "truncated", "unreadable"]),
    terminalMarkerObserved: z.boolean(),
    finalResultsMarkerObserved: z.boolean(),
    convergenceStatus: z.literal("not_assessed"),
    samples: z.array(AmberMinimizationSampleSchema).max(1_000_000),
    final: AmberMinimizationSampleSchema.nullable(),
    diagnostics: z.array(AmberByteDiagnosticSchema).max(256),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "completed" && (!value.terminalMarkerObserved || value.final === null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Completed minimization parse requires terminal and FINAL RESULTS observations",
      });
    }
    if (value.finalResultsMarkerObserved !== (value.final !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "FINAL RESULTS marker must agree with the decoded final minimization row",
      });
    }
    if (
      value.status === "completed" &&
      value.diagnostics.some((item) => item.severity !== "warning")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Completed minimization parse cannot retain error/fatal diagnostics",
      });
    }
  });
export type AmberMinimizationParseResult = z.infer<typeof AmberMinimizationParseResultSchema>;

export function assertAmberMinimizationParseResult(value: unknown): AmberMinimizationParseResult {
  return AmberMinimizationParseResultSchema.parse(value);
}
