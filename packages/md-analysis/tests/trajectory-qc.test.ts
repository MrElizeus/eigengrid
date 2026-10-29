import { describe, expect, test } from "bun:test";
import {
  TrajectorySegmentSchema,
  computeTrajectorySegmentDigest,
  type TrajectorySegment,
} from "@eigengrid/scientific-schema";
import {
  AmberByteInspectionSchemaVersion,
  TrajectoryQcSchemaVersion,
  assessTrajectoryQc,
  bindAmberTrajectoryInspection,
  type TrajectoryInspector,
  type TrajectoryQcRequest,
} from "../src/index";
import { artifact, decodedInspector, trajectoryQcBindings, trajectorySegment } from "./helpers";

function segments(): [TrajectorySegment, TrajectorySegment] {
  const initial = artifact("restart", "a");
  const restart0 = artifact("restart", "b");
  const restart1 = artifact("restart", "c");
  const first = trajectorySegment({
    id: "segment-0",
    index: 0,
    parent: initial,
    restart: restart0,
    trajectory: artifact("trajectory", "d"),
    startStep: 0,
    endStep: 100,
    startTimePs: 0,
    endTimePs: 0.2,
  });
  const second = trajectorySegment({
    id: "segment-1",
    index: 1,
    parent: restart0,
    restart: restart1,
    trajectory: artifact("trajectory", "e"),
    startStep: 100,
    endStep: 200,
    startTimePs: 0.2,
    endTimePs: 0.4,
  });
  return [first, second];
}

function request(overrides: Partial<TrajectoryQcRequest> = {}): TrajectoryQcRequest {
  const selectedSegments = overrides.segments ?? segments();
  const topology = overrides.topology ?? artifact("topology", "f");
  return {
    schemaVersion: TrajectoryQcSchemaVersion,
    id: "trajectory-qc-1",
    revision: 1,
    missionId: "mission-1",
    replicaId: "replica-1",
    ...trajectoryQcBindings(selectedSegments, topology),
    topology,
    topologyAtomCount: 100,
    periodicBoxRequired: true,
    segments: selectedSegments,
    timeTolerancePs: 1e-9,
    ...overrides,
  };
}

function resign(
  segment: TrajectorySegment,
  changes: Partial<TrajectorySegment>,
): TrajectorySegment {
  const { segmentDigest: _segmentDigest, ...base } = { ...segment, ...changes };
  return TrajectorySegmentSchema.parse({
    ...base,
    segmentDigest: computeTrajectorySegmentDigest(base),
  });
}

function legacyDecodedInspectorWithoutByteEvidence(): TrajectoryInspector {
  return {
    async inspect(inspectionRequest) {
      return {
        schemaVersion: "eigengrid.trajectory-inspection/v1",
        artifactId: inspectionRequest.artifact.artifactId,
        evidenceRef: inspectionRequest.artifact.evidenceRef,
        expectedContentDigest: inspectionRequest.artifact.contentDigest,
        observedContentDigest: inspectionRequest.artifact.contentDigest,
        inspectorId: "legacy-fixture-inspector",
        inspectorVersion: "1.0.0",
        operationReceiptRef: `inspection-receipt-${inspectionRequest.artifact.artifactId}`,
        inspectionLevel: "decoded_netcdf",
        readStatus: "complete",
        convention: "AMBER NetCDF trajectory",
        atomCount: inspectionRequest.expectedAtomCount,
        frameCount: inspectionRequest.expectedFrameCount,
        hasPeriodicBox: inspectionRequest.periodicBoxRequired,
        byteLength: 4096,
        diagnostics: [],
      };
    },
  };
}

function invalidAmberByteInspector(): TrajectoryInspector {
  return {
    async inspect(inspectionRequest) {
      const frameCount = inspectionRequest.expectedFrameCount;
      return bindAmberTrajectoryInspection(
        {
          schemaVersion: AmberByteInspectionSchemaVersion,
          decoder: { id: "fixture.amber-byte-inspector", version: "0.1.0" },
          artifactKind: "trajectory",
          observedContentDigest: inspectionRequest.artifact.contentDigest,
          byteLength: 4096,
          format: "amber_netcdf",
          inspectionLevel: "decoded",
          readStatus: "complete",
          convention: "AMBER NetCDF trajectory",
          atomCount: inspectionRequest.expectedAtomCount,
          frameCount,
          hasPeriodicBox: inspectionRequest.periodicBoxRequired,
          finiteValues: false,
          dimensions: { frame: frameCount, atom: inspectionRequest.expectedAtomCount, spatial: 3 },
          time: {
            status: "duplicate",
            cadenceStatus: "irregular",
            count: frameCount,
            firstPs: 0,
            lastPs: Math.max(0, frameCount - 1) * 0.002,
            minDeltaPs: 0,
            maxDeltaPs: 0.002,
            precisionPs: 1e-9,
          },
          cell: inspectionRequest.periodicBoxRequired
            ? { status: "complete", frameCount, variableAcrossFrames: false }
            : { status: "not_present", frameCount: null, variableAcrossFrames: null },
          atomIdentityDigest: null,
          diagnostics: [
            {
              code: "fixture_invalid_trajectory",
              severity: "error",
              message: "Fixture intentionally contains non-finite values and duplicate time",
            },
          ],
        },
        {
          artifactId: inspectionRequest.artifact.artifactId,
          evidenceRef: inspectionRequest.artifact.evidenceRef,
          expectedContentDigest: inspectionRequest.artifact.contentDigest,
          operationReceiptRef: `inspection-receipt-${inspectionRequest.artifact.artifactId}`,
        },
      );
    },
  };
}

describe("trajectory QC with an injected NetCDF inspector", () => {
  test("passes exact checksums, decoded metadata, frame counts, atom counts, box, and continuity", async () => {
    const report = await assessTrajectoryQc(request(), decodedInspector());

    expect(report.status).toBe("passed");
    expect(report.inspections).toHaveLength(2);
    expect(report.checks.filter((item) => item.status !== "passed")).toEqual([]);
    expect(report.checks.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "segment_digest",
        "restart_parent_continuity",
        "step_continuity",
        "time_continuity",
        "trajectory_checksum",
        "netcdf_decoding",
        "trajectory_atom_count",
        "trajectory_frame_count",
        "trajectory_periodic_box",
      ]),
    );
  });

  test("metadata-only inspection remains indeterminate and makes no NetCDF validation claim", async () => {
    const report = await assessTrajectoryQc(
      request(),
      decodedInspector({ inspectionLevel: "metadata_only" }),
    );
    expect(report.status).toBe("indeterminate");
    expect(report.checks.find((item) => item.code === "netcdf_decoding")?.status).toBe(
      "indeterminate",
    );
  });

  test("cannot promote legacy metadata or invalid Amber byte evidence to QC PASS", async () => {
    const legacyReport = await assessTrajectoryQc(
      request(),
      legacyDecodedInspectorWithoutByteEvidence(),
    );
    expect(legacyReport.status).toBe("indeterminate");
    expect(legacyReport.checks).toContainEqual(
      expect.objectContaining({ code: "trajectory_finite_values", status: "indeterminate" }),
    );

    const invalidReport = await assessTrajectoryQc(request(), invalidAmberByteInspector());
    expect(invalidReport.status).toBe("failed");
    expect(invalidReport.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "trajectory_finite_values", status: "failed" }),
        expect.objectContaining({ code: "trajectory_time_order", status: "failed" }),
      ]),
    );
  });

  test("fails closed for truncation metadata, frame mismatch, atom mismatch, box loss, and checksum mismatch", async () => {
    const cases = [
      decodedInspector({ readStatus: "truncated", frameCount: 4 }),
      decodedInspector({ frameCount: 9 }),
      decodedInspector({ atomCount: 99 }),
      decodedInspector({ hasPeriodicBox: false }),
      decodedInspector({ observedContentDigest: "0".repeat(64) }),
    ];
    const expectedCodes = [
      "netcdf_decoding",
      "trajectory_frame_count",
      "trajectory_atom_count",
      "trajectory_periodic_box",
      "trajectory_checksum",
    ];
    for (const [index, inspector] of cases.entries()) {
      const report = await assessTrajectoryQc(request(), inspector!);
      expect(report.status).toBe("failed");
      expect(report.checks).toContainEqual(
        expect.objectContaining({ code: expectedCodes[index], status: "failed" }),
      );
    }
  });

  test("detects segment discontinuity independently of each signed segment projection", async () => {
    const [first, second] = segments();
    const discontinuous = resign(second, {
      startStep: 101,
      startTimePs: 0.21,
      continuity: {
        ...second.continuity,
        expectedStartStep: 101,
        observedStartStep: 101,
        expectedStartTimePs: 0.21,
        observedStartTimePs: 0.21,
      },
    });
    const report = await assessTrajectoryQc(
      request({ segments: [first, discontinuous] }),
      decodedInspector(),
    );
    expect(report.status).toBe("failed");
    expect(report.checks).toContainEqual(
      expect.objectContaining({ code: "step_continuity", status: "failed" }),
    );
    expect(report.checks).toContainEqual(
      expect.objectContaining({ code: "time_continuity", status: "failed" }),
    );
  });

  test("does not trust malformed or failed inspector responses", async () => {
    const invalid: TrajectoryInspector = {
      async inspect() {
        return { status: "fine" };
      },
    };
    const invalidReport = await assessTrajectoryQc(request(), invalid);
    expect(invalidReport.status).toBe("indeterminate");
    expect(invalidReport.inspections[0]?.status).toBe("invalid_response");

    const failing: TrajectoryInspector = {
      async inspect() {
        throw new Error("fixture failure");
      },
    };
    const failureReport = await assessTrajectoryQc(request(), failing);
    expect(failureReport.status).toBe("indeterminate");
    expect(failureReport.inspections[0]?.status).toBe("inspector_failure");
  });

  test("detects a tampered signed segment even when its shape remains valid", async () => {
    const [first, second] = segments();
    const tampered = { ...second, endStep: 201 };
    expect(
      assessTrajectoryQc(request({ segments: [first, tampered] }), decodedInspector()),
    ).rejects.toThrow(/digest mismatch/u);
  });

  test("rejects mission relabeling before an inspector can make a claim", async () => {
    expect(
      assessTrajectoryQc(request({ missionId: "mission-relabeled" }), decodedInspector()),
    ).rejects.toThrow(/requested mission/u);
  });
});
