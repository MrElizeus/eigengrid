import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  appendDecision,
  createActionReservation,
  createActionTerminal,
  createDecisionRecord,
  deriveActionHistory,
  distinctReservations,
  readDecisions,
  readLedgerWithIntegrity,
  reconstructRecoveryBudget,
} from "@eigengrid/worker-agent";
import { ensureWorkerLayout, getFailedDir, writeStatusFile } from "@eigengrid/worker";
import type { WorkerAgentConfig } from "@eigengrid/core";
import { runRecoveryCycle } from "@eigengrid/worker-agent";
import { formatDecisionHistoryEntry } from "../../apps/cli/src/commands/worker-agent";

function temp(): string {
  return mkdtempSync(join(tmpdir(), "worker-agent-ledger-"));
}
function decision(id: string, jobId = "job") {
  const record = createDecisionRecord("node", "mark-draining", "low disk", "high", "p", { jobId });
  record.id = id;
  return record;
}
const config: WorkerAgentConfig = {
  mode: "recover-only",
  maxRecoveryActionsPerJob: 1,
  maxRecoveryActionsPerHour: 10,
  allowParserRetry: true,
  allowArtifactSyncRetry: true,
  allowSameCommandRetry: false,
  allowNodeDrain: true,
  allowPidReattach: true,
};

describe("worker-agent recovery ledger", () => {
  test("reserves durably before a successful cycle dispatches", async () => {
    const dir = temp();
    try {
      ensureWorkerLayout(dir);
      const bundle = join(getFailedDir(dir), "job");
      mkdirSync(bundle);
      writeStatusFile(bundle, {
        schemaVersion: 1,
        jobId: "job",
        attemptId: "attempt",
        state: "failed",
        command: "x",
        exitCode: 1,
      });
      const result = await runRecoveryCycle(dir, config, "node", 500);
      expect(readLedgerWithIntegrity(dir).records.map((record) => record.type)).toEqual([
        "decision.evaluated",
        "action.reserved",
        "action.completed",
      ]);
      const [evaluated, started, completed] = result.events;
      expect((evaluated.payload as any).decisionId).toBe(
        readLedgerWithIntegrity(dir).records[0].id,
      );
      expect(started.payload as any).toMatchObject({
        decisionId: (evaluated.payload as any).decisionId,
        reservationId: readLedgerWithIntegrity(dir).records[1].id,
      });
      expect(completed.payload as any).toMatchObject({
        reservationId: (started.payload as any).reservationId,
        terminalId: readLedgerWithIntegrity(dir).records[2].id,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("retains evaluation, reservation, and completed outcome in append order", () => {
    const dir = temp();
    try {
      const evaluated = decision("evaluation");
      const reserved = createActionReservation(evaluated);
      appendDecision(dir, evaluated);
      appendDecision(dir, reserved);
      appendDecision(dir, createActionTerminal(reserved.id, true, "drained"));
      const records = readLedgerWithIntegrity(dir).records;
      expect(records.map((record) => record.type)).toEqual([
        "decision.evaluated",
        "action.reserved",
        "action.completed",
      ]);
      expect(deriveActionHistory(records)[0]).toMatchObject({
        outcome: "completed",
        message: "drained",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("derives failed and interrupted reservations while counting each ID once", () => {
    const failed = decision("failed", "one");
    const failedReservation = createActionReservation(failed);
    const interrupted = decision("interrupted", "two");
    const interruptedReservation = createActionReservation(interrupted);
    const records = [
      failed,
      failedReservation,
      createActionTerminal(failedReservation.id, false, "action error"),
      failedReservation,
      interrupted,
      interruptedReservation,
    ];
    expect(deriveActionHistory(records)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ evaluation: failed, outcome: "failed", message: "action error" }),
        expect.objectContaining({ evaluation: interrupted, outcome: "interrupted" }),
      ]),
    );
    expect(distinctReservations(records)).toHaveLength(2);
    expect(reconstructRecoveryBudget(records, "one")).toMatchObject({
      actionsThisJob: 1,
      actionsThisHour: 2,
    });
  });

  test("keeps legacy and non-reserved evaluations compatible without consuming reservations", () => {
    const dir = temp();
    try {
      const legacy = decision("legacy");
      delete legacy.type;
      appendDecision(dir, legacy);
      appendDecision(dir, decision("evaluated"));
      expect(readDecisions(dir)).toHaveLength(2);
      expect(distinctReservations(readLedgerWithIntegrity(dir).records)).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("CLI formatter distinguishes completed, failed, and interrupted reservations", () => {
    const evaluated = decision("cli");
    const reserved = createActionReservation(evaluated);
    reserved.reservedAt = 1;
    for (const [outcome, message] of [
      ["completed", "done"],
      ["failed", "error"],
      ["interrupted", undefined],
    ] as const) {
      const lines = formatDecisionHistoryEntry({
        evaluation: evaluated,
        reservation: reserved,
        outcome,
        message,
      });
      expect(lines).toContain("  Reserved:  1970-01-01T00:00:00.001Z");
      expect(lines).toContain(`  Outcome:   ${outcome}${message ? ` (${message})` : ""}`);
      expect(lines.some((line) => line.includes("Executed:"))).toBe(false);
    }
  });
});
