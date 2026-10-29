import { describe, expect, test } from "bun:test";
import { SYNTHETIC_MDOUT_COMPLETE, SYNTHETIC_MDOUT_SHAKE_FATAL } from "../fixtures/synthetic";
import {
  TrajectoryQcSchemaVersion,
  assessTrajectoryQc,
  diagnoseMdAnalysis,
  parseAmberMdTelemetry,
} from "../src/index";
import {
  artifact,
  decodedInspector,
  telemetryRequest,
  trajectoryQcBindings,
  trajectorySegment,
} from "./helpers";

async function qc(inspector = decodedInspector()) {
  const parent = artifact("restart", "a");
  const segment = trajectorySegment({
    id: "segment-0",
    index: 0,
    parent,
    restart: artifact("restart", "b"),
    trajectory: artifact("trajectory", "c"),
    startStep: 0,
    endStep: 100,
    startTimePs: 0,
    endTimePs: 0.2,
  });
  const topology = artifact("topology", "d");
  return assessTrajectoryQc(
    {
      schemaVersion: TrajectoryQcSchemaVersion,
      id: "qc-1",
      revision: 1,
      missionId: "mission-1",
      replicaId: "replica-1",
      ...trajectoryQcBindings([segment], topology),
      topology,
      topologyAtomCount: 100,
      periodicBoxRequired: true,
      segments: [segment],
      timeTolerancePs: 1e-9,
    },
    inspector,
  );
}

describe("conservative MD diagnostics", () => {
  test("reports no operational issue only when supplied evidence passes", async () => {
    const telemetry = parseAmberMdTelemetry(
      SYNTHETIC_MDOUT_COMPLETE,
      telemetryRequest(SYNTHETIC_MDOUT_COMPLETE),
    );
    const diagnosis = diagnoseMdAnalysis({
      id: "diagnosis-1",
      missionId: "mission-1",
      telemetry,
      trajectoryQc: await qc(),
    });
    expect(diagnosis.classification).toBe("no_issue_detected");
    expect(diagnosis.proposals).toEqual([]);
    expect(diagnosis.limitations.join(" ")).toContain("does not establish equilibration");

    const report = await qc();
    expect(() =>
      diagnoseMdAnalysis({
        id: "diagnosis-tampered",
        missionId: "mission-1",
        trajectoryQc: { ...report, status: "failed" },
      }),
    ).toThrow(/report digest mismatch/u);
  });

  test("classifies SHAKE as an engine failure but never applies remediation", () => {
    const telemetry = parseAmberMdTelemetry(
      SYNTHETIC_MDOUT_SHAKE_FATAL,
      telemetryRequest(SYNTHETIC_MDOUT_SHAKE_FATAL),
    );
    const diagnosis = diagnoseMdAnalysis({
      id: "diagnosis-shake",
      missionId: "mission-1",
      telemetry,
    });
    expect(diagnosis.classification).toBe("engine_failure");
    expect(diagnosis.proposals).toContainEqual(
      expect.objectContaining({
        kind: "review_shake_instability",
        automatic: false,
        approvalRequired: true,
      }),
    );
  });

  test("quarantines integrity failures as a proposal and keeps missing inspection indeterminate", async () => {
    const failed = diagnoseMdAnalysis({
      id: "diagnosis-integrity",
      missionId: "mission-1",
      trajectoryQc: await qc(decodedInspector({ frameCount: 1 })),
    });
    expect(failed.classification).toBe("artifact_integrity_failure");
    expect(failed.proposals).toContainEqual(
      expect.objectContaining({ kind: "quarantine_artifact", automatic: false }),
    );

    const indeterminate = diagnoseMdAnalysis({
      id: "diagnosis-indeterminate",
      missionId: "mission-1",
      trajectoryQc: await qc(decodedInspector({ inspectionLevel: "metadata_only" })),
    });
    expect(indeterminate.classification).toBe("indeterminate");
    expect(indeterminate.proposals).toContainEqual(
      expect.objectContaining({ kind: "rerun_typed_analysis", automatic: false }),
    );
  });

  test("partial telemetry requests durable reconciliation before retry", () => {
    const telemetry = parseAmberMdTelemetry(
      SYNTHETIC_MDOUT_COMPLETE,
      telemetryRequest(SYNTHETIC_MDOUT_COMPLETE, {
        executionCompletion: "unconfirmed",
        exitCode: null,
      }),
    );
    const diagnosis = diagnoseMdAnalysis({
      id: "diagnosis-partial",
      missionId: "mission-1",
      telemetry,
    });
    expect(diagnosis.classification).toBe("indeterminate");
    expect(diagnosis.proposals).toContainEqual(
      expect.objectContaining({
        kind: "reconcile_operation",
        automatic: false,
        approvalRequired: false,
      }),
    );
  });
});
