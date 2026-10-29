import {
  AtomMapSchemaVersion,
  MdArtifactReferenceSchema,
  MdStageResultSchemaVersion,
  TrajectorySegmentSchema,
  TrajectorySegmentSchemaVersion,
  computeAtomMapDigest,
  computeMdStageResultDigest,
  computeTrajectorySegmentDigest,
  digestBytes,
  type MdArtifactReference,
  type MdArtifactRole,
  type MdStageResult,
  type TrajectorySegment,
} from "@eigengrid/scientific-schema";
import {
  MdAnalysisParseSchemaVersion,
  TrajectoryInspectionSchemaVersion,
  type AmberTelemetryParseRequest,
  type TrajectoryInspectionRequest,
  type TrajectoryInspector,
} from "../src/index";

export const TIMESTAMP = "2026-08-23T12:00:00.000Z";

export function digest(character: string): string {
  return character.repeat(64);
}

export function artifact(
  role: MdArtifactRole,
  character: string,
  overrides: Partial<MdArtifactReference> = {},
): MdArtifactReference {
  return MdArtifactReferenceSchema.parse({
    artifactId: `${role}-${character}`,
    evidenceRef: `${role}-evidence-${character}`,
    role,
    contentDigest: digest(character),
    mediaType: "application/octet-stream",
    ...overrides,
  });
}

export function sourceFor(content: string, name: string) {
  return {
    artifactId: `${name}-artifact`,
    evidenceRef: `${name}-evidence`,
    contentDigest: digestBytes(content),
  };
}

export function telemetryRequest(
  content: string,
  overrides: Partial<AmberTelemetryParseRequest> = {},
): AmberTelemetryParseRequest {
  const sourceKind = overrides.sourceKind ?? "mdout";
  const source =
    overrides.source ??
    ({
      ...sourceFor(content, sourceKind),
      role: sourceKind,
      mediaType: "text/plain",
    } as const);
  const executionCompletion = overrides.executionCompletion ?? "confirmed";
  const exitCode = overrides.exitCode === undefined ? 0 : overrides.exitCode;
  const signal = overrides.signal === undefined ? null : overrides.signal;
  const terminalReason =
    signal !== null
      ? ("signal" as const)
      : exitCode !== null && exitCode !== 0
        ? ("engine_failure" as const)
        : executionCompletion === "confirmed"
          ? ("completed" as const)
          : ("ambiguous" as const);
  const errors =
    terminalReason === "engine_failure"
      ? [
          {
            code: "fixture_engine_failure",
            severity: "error" as const,
            message: "Synthetic nonzero exit",
            sourceEvidenceRefs: [source.evidenceRef],
          },
        ]
      : [];
  const mdout =
    sourceKind === "mdout"
      ? source
      : artifact("mdout", "f", {
          artifactId: "mdout-companion",
          evidenceRef: "mdout-companion-evidence",
          mediaType: "text/plain",
        });
  const mdinfo =
    sourceKind === "mdinfo"
      ? source
      : artifact("mdinfo", "e", {
          artifactId: "mdinfo-companion",
          evidenceRef: "mdinfo-companion-evidence",
          mediaType: "text/plain",
        });
  const stageResultBase = {
    schemaVersion: MdStageResultSchemaVersion,
    id: "stage-result-1",
    revision: 1,
    missionId: "mission-1",
    workUnitId: "work-unit-telemetry-1",
    operationId: "operation-telemetry-1",
    operationReceiptId: "operation-receipt-1",
    protocolId: "protocol-telemetry-1",
    protocolRevision: 1,
    protocolDigest: digest("d"),
    stageId: "equilibration-telemetry-1",
    stageRevision: 1,
    stageDigest: digest("c"),
    stageKind: "equilibration" as const,
    terminalReason,
    exitCode,
    signal,
    startedAt: TIMESTAMP,
    finishedAt: "2026-08-23T12:01:00.000Z",
    startStep: 0,
    endStep: 200,
    startTimePs: 0,
    endTimePs: 0.4,
    engine: {
      engine: "amber",
      executable: "sander",
      version: "AmberTools fixture",
      buildDigest: digest("b"),
      environmentDigest: digest("a"),
      compatibilityVersion: "1.0.0",
    },
    artifacts: [artifact("restart", "9"), mdout, mdinfo],
    warnings: [],
    errors,
    validationStatus: terminalReason === "completed" ? ("passed" as const) : ("not_run" as const),
    validationRefs: terminalReason === "completed" ? ["validation-telemetry-1"] : [],
  };
  const stageResult = {
    ...stageResultBase,
    resultDigest: computeMdStageResultDigest(stageResultBase),
  };
  return {
    schemaVersion: MdAnalysisParseSchemaVersion,
    sourceKind,
    missionId: "mission-1",
    source,
    stageResult,
    parserVersion: "1.0.0",
    executionCompletion,
    operationReceiptRef: "operation-receipt-1",
    exitCode,
    signal,
    ...overrides,
  };
}

export function trajectorySegment(input: {
  id: string;
  index: number;
  parent: MdArtifactReference;
  restart: MdArtifactReference;
  trajectory: MdArtifactReference;
  startStep: number;
  endStep: number;
  startTimePs: number;
  endTimePs: number;
  frameCount?: number;
}): TrajectorySegment {
  const frameCount = input.frameCount ?? 10;
  const unsigned = {
    schemaVersion: TrajectorySegmentSchemaVersion,
    id: input.id,
    revision: 1,
    missionId: "mission-1",
    replicaId: "replica-1",
    stageResultId: `stage-result-${input.index}`,
    segmentIndex: input.index,
    parentRestart: input.parent,
    restart: input.restart,
    trajectory: input.trajectory,
    startStep: input.startStep,
    endStep: input.endStep,
    startTimePs: input.startTimePs,
    endTimePs: input.endTimePs,
    frameCount,
    netcdf: {
      convention: "AMBER NetCDF trajectory",
      atomCount: 100,
      frameCount,
      hasPeriodicBox: true,
    },
    continuity: {
      status: "verified" as const,
      expectedParentRestartDigest: input.parent.contentDigest,
      observedParentRestartDigest: input.parent.contentDigest,
      expectedStartStep: input.startStep,
      observedStartStep: input.startStep,
      expectedStartTimePs: input.startTimePs,
      observedStartTimePs: input.startTimePs,
      reason: "Synthetic exact-boundary fixture",
    },
    createdAt: TIMESTAMP,
  };
  return TrajectorySegmentSchema.parse({
    ...unsigned,
    segmentDigest: computeTrajectorySegmentDigest(unsigned),
  });
}

export function trajectoryQcBindings(
  segments: readonly TrajectorySegment[],
  topology: MdArtifactReference,
): {
  system: {
    id: string;
    revision: number;
    systemClass: "membrane";
    manifestDigest: string;
    topologyDigest: string;
    coordinateDigest: string;
    atomMapDigest: string;
  };
  atomMap: ReturnType<typeof canonicalAtomMap>;
  stageResults: MdStageResult[];
} {
  const atomMap = canonicalAtomMap(topology.contentDigest);
  return {
    system: {
      id: atomMap.systemManifestId,
      revision: atomMap.systemManifestRevision,
      systemClass: "membrane",
      manifestDigest: digest("9"),
      topologyDigest: topology.contentDigest,
      coordinateDigest: atomMap.coordinateDigest,
      atomMapDigest: atomMap.mapDigest,
    },
    atomMap,
    stageResults: segments.map(stageResultForSegment),
  };
}

function canonicalAtomMap(topologyDigest: string) {
  const unsigned = {
    schemaVersion: AtomMapSchemaVersion,
    id: "atom-map-qc-1",
    revision: 1,
    systemManifestId: "system-qc-1",
    systemManifestRevision: 1,
    indexBase: 1 as const,
    atomCount: 100,
    topologyDigest,
    coordinateDigest: digest("8"),
    entries: Array.from({ length: 100 }, (_, index) => ({
      systemAtomIndex: index + 1,
      componentId: "component-qc-1",
      componentAtomIndex: index + 1,
      chainId: "A",
      residueIndex: Math.floor(index / 10) + 1,
      residueName: "ALA",
      atomName: `A${index + 1}`.slice(0, 8),
      element: "C",
    })),
  };
  return { ...unsigned, mapDigest: computeAtomMapDigest(unsigned) };
}

function stageResultForSegment(segment: TrajectorySegment): MdStageResult {
  const unsigned = {
    schemaVersion: MdStageResultSchemaVersion,
    id: segment.stageResultId,
    revision: 1,
    missionId: segment.missionId,
    workUnitId: `work-unit-${segment.id}`,
    operationId: `operation-${segment.id}`,
    operationReceiptId: `receipt-${segment.id}`,
    protocolId: "protocol-qc-1",
    protocolRevision: 1,
    protocolDigest: digest("7"),
    stageId: "production-qc-1",
    stageRevision: 1,
    stageDigest: digest("6"),
    stageKind: "production" as const,
    replicaSetId: "replica-set-qc-1",
    replicaSetRevision: 1,
    replicaSetDigest: digest("5"),
    replicaId: segment.replicaId,
    segmentIndex: segment.segmentIndex,
    parentRestartDigest: segment.parentRestart.contentDigest,
    terminalReason: "completed" as const,
    exitCode: 0,
    signal: null,
    startedAt: TIMESTAMP,
    finishedAt: "2026-08-23T12:01:00.000Z",
    startStep: segment.startStep,
    endStep: segment.endStep,
    startTimePs: segment.startTimePs,
    endTimePs: segment.endTimePs,
    engine: {
      engine: "amber",
      executable: "sander",
      version: "AmberTools fixture",
      buildDigest: digest("4"),
      environmentDigest: digest("3"),
      compatibilityVersion: "1.0.0",
    },
    artifacts: [
      segment.restart,
      segment.trajectory,
      artifact("mdout", "2", {
        artifactId: `mdout-${segment.id}`,
        evidenceRef: `mdout-evidence-${segment.id}`,
      }),
      artifact("mdinfo", "1", {
        artifactId: `mdinfo-${segment.id}`,
        evidenceRef: `mdinfo-evidence-${segment.id}`,
      }),
    ],
    warnings: [],
    errors: [],
    validationStatus: "passed" as const,
    validationRefs: [`validation-${segment.id}`],
  };
  return {
    ...unsigned,
    resultDigest: computeMdStageResultDigest(unsigned),
  };
}

export function decodedInspector(
  overrides: Partial<{
    inspectionLevel: "decoded_netcdf" | "metadata_only";
    readStatus: "complete" | "truncated" | "unreadable" | "indeterminate";
    observedContentDigest: string | null;
    atomCount: number | null;
    frameCount: number | null;
    hasPeriodicBox: boolean | null;
  }> = {},
): TrajectoryInspector {
  return {
    async inspect(request: TrajectoryInspectionRequest) {
      const inspectionLevel = overrides.inspectionLevel ?? "decoded_netcdf";
      const readStatus = overrides.readStatus ?? "complete";
      const atomCount =
        overrides.atomCount === undefined ? request.expectedAtomCount : overrides.atomCount;
      const frameCount =
        overrides.frameCount === undefined ? request.expectedFrameCount : overrides.frameCount;
      const hasPeriodicBox =
        overrides.hasPeriodicBox === undefined
          ? request.periodicBoxRequired
          : overrides.hasPeriodicBox;
      return {
        schemaVersion: TrajectoryInspectionSchemaVersion,
        artifactId: request.artifact.artifactId,
        evidenceRef: request.artifact.evidenceRef,
        expectedContentDigest: request.artifact.contentDigest,
        observedContentDigest:
          overrides.observedContentDigest === undefined
            ? request.artifact.contentDigest
            : overrides.observedContentDigest,
        inspectorId: "synthetic-netcdf-inspector",
        inspectorVersion: "1.0.0",
        operationReceiptRef: `inspection-receipt-${request.artifact.artifactId}`,
        inspectionLevel,
        readStatus,
        convention: "AMBER NetCDF trajectory",
        atomCount,
        frameCount,
        hasPeriodicBox,
        byteLength: 4096,
        ...(inspectionLevel === "decoded_netcdf" && frameCount !== null
          ? {
              byteEvidence: {
                finiteValues: true,
                time: {
                  status: frameCount === 1 ? "single_frame" : "strictly_increasing",
                  cadenceStatus: frameCount === 1 ? "single_frame" : "uniform",
                  count: frameCount,
                  firstPs: 0,
                  lastPs: Math.max(0, frameCount - 1) * 0.002,
                  minDeltaPs: frameCount === 1 ? null : 0.002,
                  maxDeltaPs: frameCount === 1 ? null : 0.002,
                  precisionPs: 1e-9,
                },
                cell: hasPeriodicBox
                  ? { status: "complete", frameCount, variableAcrossFrames: false }
                  : { status: "not_present", frameCount: null, variableAcrossFrames: null },
              },
            }
          : {}),
        diagnostics: [],
      };
    },
  };
}
