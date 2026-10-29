import {
  AtomMapSchema,
  BiomolecularSystemManifestReferenceSchema,
  DigestSchema,
  IdSchema,
  MdArtifactReferenceSchema,
  MdStageResultSchema,
  SemverSchema,
  TrajectorySegmentSchema,
  assertAtomMapDigest,
  assertMdStageResultDigest,
  assertTrajectorySegmentDigest,
  digestCanonical,
  type MdArtifactReference,
  type TrajectorySegment,
} from "@eigengrid/scientific-schema";
import { z } from "zod";
import {
  AnalysisDiagnosticSchema,
  TrajectoryByteEvidenceSchema,
  TrajectoryInspectionSchemaVersion,
  TrajectoryQcSchemaVersion,
  analysisDiagnostic,
} from "./contracts";

export const TrajectoryInspectionRequestSchema = z
  .object({
    schemaVersion: z.literal(TrajectoryInspectionSchemaVersion),
    artifact: MdArtifactReferenceSchema,
    expectedAtomCount: z.number().int().positive(),
    expectedFrameCount: z.number().int().positive(),
    periodicBoxRequired: z.boolean(),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.artifact.role !== "trajectory") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["artifact", "role"],
        message: "Trajectory inspectors accept only canonical trajectory artifacts",
      });
    }
  });
export type TrajectoryInspectionRequest = z.infer<typeof TrajectoryInspectionRequestSchema>;

export const TrajectoryInspectionResultSchema = z
  .object({
    schemaVersion: z.literal(TrajectoryInspectionSchemaVersion),
    artifactId: IdSchema,
    evidenceRef: IdSchema,
    expectedContentDigest: DigestSchema,
    observedContentDigest: DigestSchema.nullable(),
    inspectorId: z.string().min(1),
    inspectorVersion: SemverSchema,
    operationReceiptRef: IdSchema,
    inspectionLevel: z.enum(["decoded_netcdf", "metadata_only"]),
    readStatus: z.enum(["complete", "truncated", "unreadable", "indeterminate"]),
    convention: z.string().min(1).nullable(),
    atomCount: z.number().int().positive().nullable(),
    frameCount: z.number().int().nonnegative().nullable(),
    hasPeriodicBox: z.boolean().nullable(),
    byteLength: z.number().int().nonnegative().nullable(),
    /**
     * Added as an optional forward-evidence extension so historical v1 result
     * records remain readable. New QC never issues PASS from a decoded result
     * that lacks this byte-derived evidence.
     */
    byteEvidence: TrajectoryByteEvidenceSchema.optional(),
    diagnostics: z.array(AnalysisDiagnosticSchema),
  })
  .strict()
  .superRefine((result, context) => {
    if (
      result.inspectionLevel === "decoded_netcdf" &&
      result.readStatus === "complete" &&
      (result.observedContentDigest === null ||
        result.convention === null ||
        result.atomCount === null ||
        result.frameCount === null ||
        result.hasPeriodicBox === null ||
        result.byteLength === null ||
        result.byteLength === 0 ||
        result.frameCount === 0)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["readStatus"],
        message: "A complete decoded NetCDF inspection requires digest and decoded metadata",
      });
    }
    if (result.byteEvidence !== undefined && result.inspectionLevel === "metadata_only") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["byteEvidence"],
        message: "Metadata-only inspection cannot carry decoded trajectory byte evidence",
      });
    }
  });
export type TrajectoryInspectionResult = z.infer<typeof TrajectoryInspectionResultSchema>;

/** CAS-aware implementations are injected by the application layer. */
export interface TrajectoryInspector {
  inspect(request: TrajectoryInspectionRequest): Promise<unknown>;
}

export const TrajectoryQcRequestSchema = z
  .object({
    schemaVersion: z.literal(TrajectoryQcSchemaVersion),
    id: IdSchema,
    revision: z.number().int().positive(),
    missionId: IdSchema,
    replicaId: IdSchema,
    system: BiomolecularSystemManifestReferenceSchema,
    atomMap: AtomMapSchema,
    topology: MdArtifactReferenceSchema,
    topologyAtomCount: z.number().int().positive(),
    periodicBoxRequired: z.boolean(),
    stageResults: z.array(MdStageResultSchema).min(1).max(256),
    segments: z.array(TrajectorySegmentSchema).min(1).max(256),
    timeTolerancePs: z.number().finite().nonnegative().default(1e-9),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.topology.role !== "topology") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["topology", "role"],
        message: "Trajectory QC requires a canonical topology artifact",
      });
    }
    if (request.topology.contentDigest !== request.system.topologyDigest) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["topology", "contentDigest"],
        message: "Trajectory QC topology must match the exact system manifest reference",
      });
    }
    if (
      request.atomMap.systemManifestId !== request.system.id ||
      request.atomMap.systemManifestRevision !== request.system.revision ||
      request.atomMap.mapDigest !== request.system.atomMapDigest ||
      request.atomMap.topologyDigest !== request.system.topologyDigest ||
      request.atomMap.coordinateDigest !== request.system.coordinateDigest ||
      request.atomMap.atomCount !== request.topologyAtomCount
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["atomMap"],
        message: "Trajectory QC AtomMap must belong to the exact system and topology",
      });
    }
    if (request.segments.some((segment) => segment.missionId !== request.missionId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["segments"],
        message: "Every segment must belong to the requested mission",
      });
    }
    if (request.segments.some((segment) => segment.replicaId !== request.replicaId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["segments"],
        message: "Every segment must belong to the requested replica",
      });
    }
    const ids = request.segments.map((segment) => segment.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["segments"],
        message: "Trajectory segment identifiers must be unique",
      });
    }
    const resultIds = request.stageResults.map((result) => result.id);
    if (new Set(resultIds).size !== resultIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stageResults"],
        message: "Stage-result identifiers must be unique",
      });
    }
    if (request.stageResults.length !== request.segments.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stageResults"],
        message: "Trajectory QC requires one exact stage result per segment",
      });
    }
    for (const [index, segment] of request.segments.entries()) {
      const result = request.stageResults.find(
        (candidate) => candidate.id === segment.stageResultId,
      );
      const restart = result?.artifacts.find((artifact) => artifact.role === "restart");
      const trajectory = result?.artifacts.find((artifact) => artifact.role === "trajectory");
      if (
        result === undefined ||
        result.missionId !== request.missionId ||
        result.stageKind !== "production" ||
        result.terminalReason !== "completed" ||
        result.validationStatus !== "passed" ||
        result.replicaId !== request.replicaId ||
        result.segmentIndex !== segment.segmentIndex ||
        result.parentRestartDigest !== segment.parentRestart.contentDigest ||
        restart === undefined ||
        digestCanonical(restart) !== digestCanonical(segment.restart) ||
        trajectory === undefined ||
        digestCanonical(trajectory) !== digestCanonical(segment.trajectory)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["segments", index],
          message: "Segment must bind the exact production result and its canonical artifacts",
        });
      }
    }
  });
export type TrajectoryQcRequest = z.infer<typeof TrajectoryQcRequestSchema>;

export const TrajectoryQcCheckSchema = z
  .object({
    code: z.string().regex(/^[a-z][a-z0-9_]*$/u),
    status: z.enum(["passed", "failed", "indeterminate"]),
    message: z.string().min(1),
    segmentId: IdSchema.optional(),
    evidenceRefs: z.array(IdSchema).min(1),
  })
  .strict();
export type TrajectoryQcCheck = z.infer<typeof TrajectoryQcCheckSchema>;

const RecordedInspectionSchema = z
  .object({
    segmentId: IdSchema,
    status: z.enum(["observed", "invalid_response", "inspector_failure"]),
    result: TrajectoryInspectionResultSchema.optional(),
    diagnostic: AnalysisDiagnosticSchema.optional(),
  })
  .strict()
  .superRefine((record, context) => {
    if ((record.status === "observed") !== (record.result !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["result"],
        message: "Only an observed inspection carries a typed result",
      });
    }
    if ((record.status !== "observed") !== (record.diagnostic !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["diagnostic"],
        message: "Failed inspection calls require a diagnostic",
      });
    }
  });

export const TrajectoryQcReportSchema = z
  .object({
    schemaVersion: z.literal(TrajectoryQcSchemaVersion),
    id: IdSchema,
    revision: z.number().int().positive(),
    missionId: IdSchema,
    replicaId: IdSchema,
    system: BiomolecularSystemManifestReferenceSchema,
    atomMap: z
      .object({
        id: IdSchema,
        revision: z.number().int().positive(),
        mapDigest: DigestSchema,
      })
      .strict(),
    stageResultRefs: z
      .array(
        z
          .object({
            id: IdSchema,
            revision: z.number().int().positive(),
            resultDigest: DigestSchema,
          })
          .strict(),
      )
      .min(1),
    segmentRefs: z
      .array(
        z
          .object({
            id: IdSchema,
            revision: z.number().int().positive(),
            stageResultId: IdSchema,
            segmentIndex: z.number().int().nonnegative(),
            segmentDigest: DigestSchema,
          })
          .strict(),
      )
      .min(1),
    topologyArtifactId: IdSchema,
    topologyEvidenceRef: IdSchema,
    topologyDigest: DigestSchema,
    status: z.enum(["passed", "failed", "indeterminate"]),
    checks: z.array(TrajectoryQcCheckSchema).min(1),
    inspections: z.array(RecordedInspectionSchema).min(1),
    limitations: z.array(z.string().min(1)),
    reportDigest: DigestSchema,
  })
  .strict()
  .superRefine((report, context) => {
    const stageResultIds = report.stageResultRefs.map((result) => result.id);
    const segmentIds = report.segmentRefs.map((segment) => segment.id);
    const segmentIndices = report.segmentRefs.map((segment) => segment.segmentIndex);
    if (
      report.topologyDigest !== report.system.topologyDigest ||
      report.atomMap.mapDigest !== report.system.atomMapDigest
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["system"],
        message: "Trajectory QC report artifacts must retain the exact system identities",
      });
    }
    if (
      report.stageResultRefs.length !== report.segmentRefs.length ||
      new Set(stageResultIds).size !== stageResultIds.length ||
      new Set(segmentIds).size !== segmentIds.length ||
      new Set(segmentIndices).size !== segmentIndices.length ||
      report.segmentRefs.some((segment) => !stageResultIds.includes(segment.stageResultId))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["segmentRefs"],
        message:
          "Trajectory QC report requires one unique exact stage-result reference per segment",
      });
    }
  });
export type TrajectoryQcReport = z.infer<typeof TrajectoryQcReportSchema>;

export function computeTrajectoryQcReportDigest(
  value: Omit<TrajectoryQcReport, "reportDigest"> | TrajectoryQcReport,
): string {
  const { reportDigest: _reportDigest, ...payload } = value as TrajectoryQcReport;
  return digestCanonical(payload);
}

export function assertTrajectoryQcReport(value: unknown): TrajectoryQcReport {
  const report = TrajectoryQcReportSchema.parse(value);
  if (report.reportDigest !== computeTrajectoryQcReportDigest(report)) {
    throw new Error(`Trajectory QC report digest mismatch for ${report.id}@${report.revision}`);
  }
  return report;
}

function check(
  code: string,
  status: TrajectoryQcCheck["status"],
  message: string,
  evidenceRefs: string[],
  segmentId?: string,
): TrajectoryQcCheck {
  return TrajectoryQcCheckSchema.parse({ code, status, message, evidenceRefs, segmentId });
}

function continuityChecks(
  segments: readonly TrajectorySegment[],
  tolerance: number,
): TrajectoryQcCheck[] {
  const checks: TrajectoryQcCheck[] = [];
  for (const [index, segment] of segments.entries()) {
    const refs = [
      segment.parentRestart.evidenceRef,
      segment.restart.evidenceRef,
      segment.trajectory.evidenceRef,
    ];
    try {
      assertTrajectorySegmentDigest(segment);
      checks.push(
        check(
          "segment_digest",
          "passed",
          "Segment projection matches its canonical digest",
          refs,
          segment.id,
        ),
      );
    } catch {
      checks.push(
        check(
          "segment_digest",
          "failed",
          "Segment projection does not match its canonical digest",
          refs,
          segment.id,
        ),
      );
    }

    const declaredExact =
      segment.continuity.expectedParentRestartDigest === segment.parentRestart.contentDigest &&
      segment.continuity.expectedStartStep === segment.startStep &&
      segment.continuity.observedStartStep === segment.startStep &&
      Math.abs(segment.continuity.expectedStartTimePs - segment.startTimePs) <= tolerance &&
      Math.abs(segment.continuity.observedStartTimePs - segment.startTimePs) <= tolerance;
    const declaredStatus =
      segment.continuity.status === "failed" ||
      (segment.continuity.status === "verified" && !declaredExact)
        ? "failed"
        : segment.continuity.status === "verified"
          ? "passed"
          : "indeterminate";
    checks.push(
      check(
        "declared_continuity",
        declaredStatus,
        declaredExact
          ? `Segment declares continuity as ${segment.continuity.status}: ${segment.continuity.reason}`
          : "Segment continuity projection does not match its actual parent/start boundary",
        refs,
        segment.id,
      ),
    );

    const previous = segments[index - 1];
    if (previous === undefined) continue;
    const pairRefs = [previous.restart.evidenceRef, segment.parentRestart.evidenceRef];
    const consecutiveIndex = segment.segmentIndex === previous.segmentIndex + 1;
    checks.push(
      check(
        "segment_index_continuity",
        consecutiveIndex ? "passed" : "failed",
        consecutiveIndex
          ? "Segment indices are consecutive"
          : "Segment indices contain a gap, duplicate, or reversal",
        pairRefs,
        segment.id,
      ),
    );
    const exactParent = segment.parentRestart.contentDigest === previous.restart.contentDigest;
    checks.push(
      check(
        "restart_parent_continuity",
        exactParent ? "passed" : "failed",
        exactParent
          ? "Segment consumes the exact previous restart digest"
          : "Segment parent restart does not match the previous restart digest",
        pairRefs,
        segment.id,
      ),
    );
    const exactStep = segment.startStep === previous.endStep;
    checks.push(
      check(
        "step_continuity",
        exactStep ? "passed" : "failed",
        exactStep
          ? "Segment step boundary is continuous"
          : "Segment step boundary contains a gap or overlap",
        pairRefs,
        segment.id,
      ),
    );
    const exactTime = Math.abs(segment.startTimePs - previous.endTimePs) <= tolerance;
    checks.push(
      check(
        "time_continuity",
        exactTime ? "passed" : "failed",
        exactTime
          ? "Segment simulation-time boundary is continuous"
          : "Segment simulation-time boundary contains a gap or overlap",
        pairRefs,
        segment.id,
      ),
    );
  }
  return checks;
}

function inspectionChecks(
  segment: TrajectorySegment,
  request: TrajectoryQcRequest,
  inspection: TrajectoryInspectionResult,
): TrajectoryQcCheck[] {
  const refs = [segment.trajectory.evidenceRef, request.topology.evidenceRef];
  const checks: TrajectoryQcCheck[] = [];
  const exactBinding =
    inspection.artifactId === segment.trajectory.artifactId &&
    inspection.evidenceRef === segment.trajectory.evidenceRef &&
    inspection.expectedContentDigest === segment.trajectory.contentDigest;
  checks.push(
    check(
      "inspection_binding",
      exactBinding ? "passed" : "failed",
      exactBinding
        ? "Inspector response is bound to the exact trajectory artifact"
        : "Inspector response is not bound to the requested trajectory artifact",
      refs,
      segment.id,
    ),
  );

  const inspectorHasError = inspection.diagnostics.some((diagnostic) =>
    ["error", "fatal"].includes(diagnostic.severity),
  );
  checks.push(
    check(
      "inspector_diagnostics",
      inspectorHasError ? "failed" : "passed",
      inspectorHasError
        ? "Trajectory inspector reported an error or fatal diagnostic"
        : "Trajectory inspector reported no error or fatal diagnostic",
      refs,
      segment.id,
    ),
  );

  const digestStatus =
    inspection.observedContentDigest === null
      ? "indeterminate"
      : inspection.observedContentDigest === segment.trajectory.contentDigest
        ? "passed"
        : "failed";
  checks.push(
    check(
      "trajectory_checksum",
      digestStatus,
      digestStatus === "passed"
        ? "Observed trajectory bytes match the content-addressed artifact digest"
        : digestStatus === "failed"
          ? "Observed trajectory bytes do not match the artifact digest"
          : "Inspector did not report an observed content digest",
      refs,
      segment.id,
    ),
  );

  const conventionStatus =
    inspection.convention === null
      ? "indeterminate"
      : inspection.convention === segment.netcdf.convention
        ? "passed"
        : "failed";
  checks.push(
    check(
      "trajectory_convention",
      conventionStatus,
      conventionStatus === "passed"
        ? "Decoded trajectory convention matches the segment contract"
        : conventionStatus === "failed"
          ? "Decoded trajectory convention differs from the segment contract"
          : "Inspector did not report a trajectory convention",
      refs,
      segment.id,
    ),
  );

  const decoded =
    inspection.inspectionLevel === "decoded_netcdf" && inspection.readStatus === "complete";
  const readStatus = ["truncated", "unreadable"].includes(inspection.readStatus)
    ? "failed"
    : decoded
      ? "passed"
      : "indeterminate";
  checks.push(
    check(
      "netcdf_decoding",
      readStatus,
      readStatus === "passed"
        ? `Inspector ${inspection.inspectorId}@${inspection.inspectorVersion} decoded a complete NetCDF artifact`
        : readStatus === "failed"
          ? `Inspector reported trajectory as ${inspection.readStatus}`
          : "No complete decoded-NetCDF inspection is available",
      refs,
      segment.id,
    ),
  );

  const atomStatus =
    inspection.atomCount === null
      ? "indeterminate"
      : inspection.atomCount === request.topologyAtomCount &&
          inspection.atomCount === segment.netcdf.atomCount
        ? "passed"
        : "failed";
  checks.push(
    check(
      "trajectory_atom_count",
      atomStatus,
      atomStatus === "passed"
        ? "Decoded trajectory atom count matches topology and segment metadata"
        : atomStatus === "failed"
          ? "Decoded trajectory atom count differs from topology or segment metadata"
          : "Inspector did not report a decoded atom count",
      refs,
      segment.id,
    ),
  );

  const frameStatus =
    inspection.frameCount === null
      ? "indeterminate"
      : inspection.frameCount === segment.frameCount &&
          inspection.frameCount === segment.netcdf.frameCount
        ? "passed"
        : "failed";
  checks.push(
    check(
      "trajectory_frame_count",
      frameStatus,
      frameStatus === "passed"
        ? "Decoded trajectory frame count matches the segment contract"
        : frameStatus === "failed"
          ? "Decoded trajectory frame count differs from the segment contract"
          : "Inspector did not report a decoded frame count",
      refs,
      segment.id,
    ),
  );

  const boxStatus =
    inspection.hasPeriodicBox === null
      ? "indeterminate"
      : inspection.hasPeriodicBox === segment.netcdf.hasPeriodicBox &&
          (!request.periodicBoxRequired || inspection.hasPeriodicBox)
        ? "passed"
        : "failed";
  checks.push(
    check(
      "trajectory_periodic_box",
      boxStatus,
      boxStatus === "passed"
        ? "Decoded periodic-box metadata matches the trajectory contract"
        : boxStatus === "failed"
          ? "Periodic-box metadata is absent or inconsistent"
          : "Inspector did not report periodic-box metadata",
      refs,
      segment.id,
    ),
  );

  const byteEvidence = inspection.byteEvidence;
  const finiteStatus =
    byteEvidence === undefined || byteEvidence.finiteValues === null
      ? "indeterminate"
      : byteEvidence.finiteValues
        ? "passed"
        : "failed";
  checks.push(
    check(
      "trajectory_finite_values",
      finiteStatus,
      finiteStatus === "passed"
        ? "Decoded trajectory numeric values are finite"
        : finiteStatus === "failed"
          ? "Decoded trajectory contains non-finite numeric values"
          : "No byte-derived finite-value observation is available",
      refs,
      segment.id,
    ),
  );

  const timeStatus = byteEvidence?.time.status;
  const observedFrameCount = inspection.frameCount;
  const temporalOrderStatus =
    byteEvidence === undefined
      ? "indeterminate"
      : timeStatus === "duplicate" ||
          timeStatus === "nonmonotonic" ||
          timeStatus === "non_finite" ||
          timeStatus === "missing"
        ? "failed"
        : timeStatus === "strictly_increasing" || timeStatus === "single_frame"
          ? observedFrameCount !== null && byteEvidence.time.count === observedFrameCount
            ? "passed"
            : "failed"
          : "indeterminate";
  checks.push(
    check(
      "trajectory_time_order",
      temporalOrderStatus,
      temporalOrderStatus === "passed"
        ? "Decoded trajectory times are ordered and cover every observed frame"
        : temporalOrderStatus === "failed"
          ? "Decoded trajectory time observations are invalid or do not cover every frame"
          : "No byte-derived ordered time observation is available",
      refs,
      segment.id,
    ),
  );

  const cadenceStatus =
    byteEvidence === undefined
      ? "indeterminate"
      : byteEvidence.time.cadenceStatus === "uniform" ||
          byteEvidence.time.cadenceStatus === "single_frame"
        ? "passed"
        : byteEvidence.time.cadenceStatus === "irregular"
          ? "indeterminate"
          : "indeterminate";
  checks.push(
    check(
      "trajectory_time_cadence",
      cadenceStatus,
      cadenceStatus === "passed"
        ? "Decoded trajectory has a uniform representational cadence"
        : byteEvidence?.time.cadenceStatus === "irregular"
          ? "Decoded trajectory cadence is irregular; no predeclared cadence contract is available"
          : "No usable byte-derived trajectory cadence observation is available",
      refs,
      segment.id,
    ),
  );

  const cellStatus = byteEvidence?.cell.status;
  const cellIntegrityStatus =
    byteEvidence === undefined
      ? "indeterminate"
      : cellStatus === "partial" || cellStatus === "non_finite" || cellStatus === "malformed"
        ? "failed"
        : cellStatus === "complete"
          ? inspection.hasPeriodicBox === true &&
            observedFrameCount !== null &&
            byteEvidence.cell.frameCount === observedFrameCount
            ? "passed"
            : "failed"
          : cellStatus === "not_present"
            ? inspection.hasPeriodicBox === false && !request.periodicBoxRequired
              ? "passed"
              : "failed"
            : "indeterminate";
  checks.push(
    check(
      "trajectory_cell_integrity",
      cellIntegrityStatus,
      cellIntegrityStatus === "passed"
        ? "Decoded trajectory cell representation is complete and consistent"
        : cellIntegrityStatus === "failed"
          ? "Decoded trajectory cell representation is missing, malformed, or inconsistent"
          : "No byte-derived cell-integrity observation is available",
      refs,
      segment.id,
    ),
  );
  return checks;
}

/**
 * Evaluates trajectory integrity and continuity using an injected inspector.
 * Metadata-only inspection can never produce a passed report.
 */
export async function assessTrajectoryQc(
  requestValue: unknown,
  inspector: TrajectoryInspector,
): Promise<TrajectoryQcReport> {
  const request = TrajectoryQcRequestSchema.parse(requestValue);
  assertAtomMapDigest(request.atomMap);
  for (const result of request.stageResults) assertMdStageResultDigest(result);
  for (const segment of request.segments) assertTrajectorySegmentDigest(segment);
  const checks = continuityChecks(request.segments, request.timeTolerancePs);
  const inspections: z.infer<typeof RecordedInspectionSchema>[] = [];

  for (const segment of request.segments) {
    const inspectionRequest = TrajectoryInspectionRequestSchema.parse({
      schemaVersion: TrajectoryInspectionSchemaVersion,
      artifact: segment.trajectory,
      expectedAtomCount: request.topologyAtomCount,
      expectedFrameCount: segment.frameCount,
      periodicBoxRequired: request.periodicBoxRequired,
    });
    try {
      const value = await inspector.inspect(inspectionRequest);
      const parsed = TrajectoryInspectionResultSchema.safeParse(value);
      if (!parsed.success) {
        const diagnostic = analysisDiagnostic({
          code: "invalid_inspector_response",
          severity: "error",
          message: "Injected trajectory inspector returned a value outside its typed contract",
          evidenceRefs: [segment.trajectory.evidenceRef],
        });
        inspections.push({ segmentId: segment.id, status: "invalid_response", diagnostic });
        checks.push(
          check(
            "trajectory_inspection",
            "indeterminate",
            "Trajectory inspection response was invalid and was not trusted",
            [segment.trajectory.evidenceRef],
            segment.id,
          ),
        );
        continue;
      }
      inspections.push({ segmentId: segment.id, status: "observed", result: parsed.data });
      checks.push(...inspectionChecks(segment, request, parsed.data));
    } catch {
      const diagnostic = analysisDiagnostic({
        code: "trajectory_inspector_failure",
        severity: "error",
        message: "Injected trajectory inspector failed; the artifact remains unverified",
        evidenceRefs: [segment.trajectory.evidenceRef],
      });
      inspections.push({ segmentId: segment.id, status: "inspector_failure", diagnostic });
      checks.push(
        check(
          "trajectory_inspection",
          "indeterminate",
          "Trajectory inspector failed and no NetCDF validation claim can be made",
          [segment.trajectory.evidenceRef],
          segment.id,
        ),
      );
    }
  }

  const status: TrajectoryQcReport["status"] = checks.some((item) => item.status === "failed")
    ? "failed"
    : checks.some((item) => item.status === "indeterminate")
      ? "indeterminate"
      : "passed";
  const limitations = [
    "Trajectory QC establishes artifact integrity and structural readability, not scientific convergence.",
  ];
  if (status !== "passed") {
    limitations.push("One or more integrity claims remain failed or indeterminate.");
  }
  const unsigned = {
    schemaVersion: TrajectoryQcSchemaVersion,
    id: request.id,
    revision: request.revision,
    missionId: request.missionId,
    replicaId: request.replicaId,
    system: request.system,
    atomMap: {
      id: request.atomMap.id,
      revision: request.atomMap.revision,
      mapDigest: request.atomMap.mapDigest,
    },
    stageResultRefs: request.segments.map((segment) => {
      const result = request.stageResults.find(
        (candidate) => candidate.id === segment.stageResultId,
      )!;
      return {
        id: result.id,
        revision: result.revision,
        resultDigest: result.resultDigest,
      };
    }),
    segmentRefs: request.segments.map((segment) => ({
      id: segment.id,
      revision: segment.revision,
      stageResultId: segment.stageResultId,
      segmentIndex: segment.segmentIndex,
      segmentDigest: segment.segmentDigest,
    })),
    topologyArtifactId: request.topology.artifactId,
    topologyEvidenceRef: request.topology.evidenceRef,
    topologyDigest: request.topology.contentDigest,
    status,
    checks,
    inspections,
    limitations,
  };
  return TrajectoryQcReportSchema.parse({
    ...unsigned,
    reportDigest: computeTrajectoryQcReportDigest(unsigned),
  });
}

export function trajectoryArtifact(
  artifact: MdArtifactReference,
): z.infer<typeof MdArtifactReferenceSchema> {
  const parsed = MdArtifactReferenceSchema.parse(artifact);
  if (parsed.role !== "trajectory") throw new Error("Expected a trajectory artifact reference");
  return parsed;
}
