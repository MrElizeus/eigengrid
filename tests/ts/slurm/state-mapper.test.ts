import { describe, expect, test } from "bun:test";
import {
  isSlurmTerminal,
  mapSlurmState,
  parseSbatchOutput,
  parseSqueueState,
} from "@eigengrid/slurm";
import type { SlurmJobState } from "@eigengrid/slurm";

const stateCases: Array<[SlurmJobState, string]> = [
  ["PENDING", "queued"],
  ["RUNNING", "running"],
  ["COMPLETING", "running"],
  ["COMPLETED", "completed"],
  ["CANCELLED", "cancelled"],
  ["FAILED", "failed"],
  ["TIMEOUT", "failed"],
  ["NODE_FAIL", "failed"],
  ["PREEMPTED", "preempted"],
  ["BOOT_FAIL", "failed"],
  ["OUT_OF_MEMORY", "failed"],
  ["SUSPENDED", "suspended"],
  ["REQUEUED", "requeued"],
  ["RESIZING", "running"],
  ["CONFIGURING", "queued"],
  ["SIGNALING", "running"],
  ["STAGE_OUT", "running"],
  ["STOPPED", "suspended"],
  ["SPECIAL_EXIT", "failed"],
  ["REVOKED", "revoked"],
  ["DEADLINE", "failed"],
  ["RESV_DEL_HOLD", "held"],
  ["REQUEUE_HOLD", "held"],
  ["REQUEUE_FED", "requeued"],
  ["UNKNOWN", "unknown"],
];

const terminalStates: SlurmJobState[] = [
  "COMPLETED",
  "CANCELLED",
  "FAILED",
  "TIMEOUT",
  "NODE_FAIL",
  "BOOT_FAIL",
  "OUT_OF_MEMORY",
  "PREEMPTED",
  "DEADLINE",
  "SPECIAL_EXIT",
  "REVOKED",
];

const nonTerminalStates: SlurmJobState[] = [
  "PENDING",
  "RUNNING",
  "COMPLETING",
  "SUSPENDED",
  "REQUEUED",
  "RESIZING",
  "CONFIGURING",
  "SIGNALING",
  "STAGE_OUT",
  "STOPPED",
  "RESV_DEL_HOLD",
  "REQUEUE_HOLD",
  "REQUEUE_FED",
  "UNKNOWN",
];

describe("mapSlurmState", () => {
  test("maps every Slurm state to a generic state", () => {
    for (const [slurmState, expected] of stateCases) {
      expect(mapSlurmState(slurmState)).toBe(expected);
    }
  });
});

describe("isSlurmTerminal", () => {
  test("returns true for terminal states", () => {
    for (const state of terminalStates) {
      expect(isSlurmTerminal(state)).toBe(true);
    }
  });

  test("returns false for non-terminal states", () => {
    for (const state of nonTerminalStates) {
      expect(isSlurmTerminal(state)).toBe(false);
    }
  });
});

describe("parseSbatchOutput", () => {
  test("parses parsable output", () => {
    expect(parseSbatchOutput("12345\n")).toEqual({ slurmJobId: "12345", success: true });
  });

  test("parses legacy output", () => {
    expect(parseSbatchOutput("Submitted batch job 12345")).toEqual({
      slurmJobId: "12345",
      success: true,
    });
  });

  test("returns error for unexpected output", () => {
    const result = parseSbatchOutput("no job id here");
    expect(result.success).toBe(false);
    expect("error" in result ? result.error : "").toContain("Unable to parse sbatch output");
  });
});

describe("parseSqueueState", () => {
  test("parses running state", () => {
    expect(parseSqueueState("R")).toBe("RUNNING");
  });

  test("parses pending state", () => {
    expect(parseSqueueState("PD")).toBe("PENDING");
  });

  test("parses completed state", () => {
    expect(parseSqueueState("CD")).toBe("COMPLETED");
  });

  test("parses failed state", () => {
    expect(parseSqueueState("F")).toBe("FAILED");
  });

  test("returns unknown for unhandled state", () => {
    expect(parseSqueueState("ZZ")).toBe("UNKNOWN");
  });
});
