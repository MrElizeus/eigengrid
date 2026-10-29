import { describe, expect, test } from "bun:test";
import {
  assessAmberStageEvidence,
  verifyAmberQualificationResult,
  verifyAmberQualificationResultForEvidence,
} from "./qualification";

const digest = (letter: string) => letter.repeat(64);

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "amber-stage-evidence/v1",
    missionId: "mission-1",
    planId: "plan-1",
    planDigest: digest("a"),
    stageId: "stage-1",
    stageKind: "production",
    executable: "sander",
    environmentDigest: digest("b"),
    binarySha256: digest("c"),
    engineVersion: "AmberTools24",
    operationReceiptId: "receipt-1",
    exitCode: 0,
    terminalReason: "completed",
    expectedSteps: 100,
    observedSteps: 100,
    expectedFrameCount: 10,
    observedFrameCount: 10,
    artifacts: [
      { role: "restart", digest: digest("d"), bytes: 100, readable: true },
      { role: "mdout", digest: digest("e"), bytes: 100, readable: true },
      { role: "mdinfo", digest: digest("f"), bytes: 100, readable: true },
      { role: "trajectory", digest: digest("0"), bytes: 100, readable: true },
    ],
    requiredArtifactRoles: ["restart", "mdout", "mdinfo", "trajectory"],
    restart: {
      parentDigest: null,
      outputDigest: digest("d"),
      readable: true,
      startStep: 0,
      endStep: 100,
    },
    parser: { id: "amber-parser", version: "1.0.0", status: "complete" },
    fatalSignatures: [],
    telemetry: [{ step: 100, timePs: 0.2, temperatureK: 300, totalEnergyKcalMol: -10 }],
    ...overrides,
  };
}

describe("Amber evidence qualification", () => {
  test("requires more than exit code and produces an exact digest-bound result", () => {
    const result = assessAmberStageEvidence(evidence());
    expect(result.status).toBe("qualified");
    expect(result.checks.every((item) => item.status === "passed")).toBe(true);
    expect(result.validationDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(verifyAmberQualificationResult(result)).toEqual(result);
    expect(verifyAmberQualificationResultForEvidence(result, evidence())).toEqual(result);
    expect(() =>
      verifyAmberQualificationResultForEvidence(result, evidence({ observedSteps: 99 })),
    ).toThrow(/different stage evidence/);
  });

  test("fails closed on fatal output, missing artifacts, and incomplete progress", () => {
    const result = assessAmberStageEvidence(
      evidence({
        exitCode: 0,
        fatalSignatures: ["SANDER BOMB"],
        observedSteps: 2,
        observedFrameCount: 2,
        artifacts: [{ role: "mdout", digest: digest("e"), bytes: 0, readable: false }],
        restart: undefined,
      }),
    );
    expect(result.status).toBe("failed");
    expect(result.checks.filter((item) => item.status === "failed").map((item) => item.id)).toEqual(
      expect.arrayContaining([
        "required-artifacts",
        "artifact-integrity",
        "fatal-signature",
        "progress",
        "trajectory-continuity",
        "restart-lineage",
      ]),
    );
  });

  test("does not overclaim local preflight without a parser or restart lineage", () => {
    const result = assessAmberStageEvidence(
      evidence({
        stageKind: "input-preflight",
        expectedSteps: undefined,
        observedSteps: undefined,
        expectedFrameCount: undefined,
        observedFrameCount: undefined,
        requiredArtifactRoles: ["preflight-report"],
        artifacts: [{ role: "preflight-report", digest: digest("1"), bytes: 10, readable: true }],
        restart: undefined,
        parser: undefined,
        telemetry: undefined,
      }),
    );
    expect(result.status).toBe("inconclusive");
    expect(result.limitations.length).toBeGreaterThan(0);
  });
});
