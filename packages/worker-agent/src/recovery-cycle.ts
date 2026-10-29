import { existsSync, readdirSync, readFileSync, statfsSync } from "fs";
import { join } from "path";
import type { WorkerAgentConfig } from "@eigengrid/core";
import {
  getRunningDir,
  getFailedDir,
  getDoneDir,
  getOrphanedDir,
  readStatusFile,
} from "@eigengrid/worker";
import { evaluateRecovery, isDecisionAutoExecutable } from "./recovery-policy";
import {
  retryArtifactSync,
  retryParserIfOutputExists,
  markNodeDraining,
  reattachKnownPid,
  markZombieFailed,
  retrySameCommandOnce,
} from "./recovery-actions";
import {
  createDecisionRecord,
  appendDecision,
  readLedgerWithIntegrity,
  distinctReservations,
  reconstructRecoveryBudget,
  createActionReservation,
  createActionTerminal,
} from "./decisions-store";
import {
  makeRecoveryStartedEvent,
  makeRecoveryCompletedEvent,
  makeRecoveryFailedEvent,
  makeDecisionEvaluatedEvent,
  makeDecisionSkippedEvent,
  makeDecisionBlockedEvent,
} from "./event-helpers";
import type { RecoveryInput, RecoveryActionKind, BudgetState } from "./types";
import type { EigenGridEventBase } from "@eigengrid/events";
import { acquireRecoveryLock } from "./recovery-lock";

// ────────────────────────────────────────────────────────────
// Recovery Cycle — The main loop function called by the daemon
// ────────────────────────────────────────────────────────────

export interface RecoveryCycleResult {
  events: EigenGridEventBase[];
  decisions: Array<{ decision: RecoveryActionKind; executed: boolean }>;
  ok: boolean;
  skippedReason?: "recovery-lock-contended" | "recovery-lock-error";
}

/**
 * Run one recovery cycle for the given scratch directory.
 * Scans all bundles in running/, failed/, done/, orphaned/ and
 * evaluates recovery policy for each.
 *
 * Pure-like: takes config + scratchDir, produces events + filesystem effects.
 */
export async function runRecoveryCycle(
  scratchDir: string,
  config: WorkerAgentConfig,
  nodeId: string,
  diskAvailableMb?: number,
): Promise<RecoveryCycleResult> {
  const events: EigenGridEventBase[] = [];
  const decisions: RecoveryCycleResult["decisions"] = [];

  if (config.mode === "off") {
    return { events, decisions, ok: true };
  }

  const admission = acquireRecoveryLock(scratchDir, nodeId);
  if (admission.kind === "contended")
    return { events, decisions, ok: true, skippedReason: "recovery-lock-contended" };
  if (admission.kind === "error")
    return { events, decisions, ok: false, skippedReason: "recovery-lock-error" };
  try {
    return await runLockedRecoveryCycle(
      scratchDir,
      config,
      nodeId,
      diskAvailableMb,
      events,
      decisions,
    );
  } finally {
    admission.release();
  }
}

async function runLockedRecoveryCycle(
  scratchDir: string,
  config: WorkerAgentConfig,
  nodeId: string,
  diskAvailableMb: number | undefined,
  events: EigenGridEventBase[],
  decisions: RecoveryCycleResult["decisions"],
): Promise<RecoveryCycleResult> {
  // Gather previous decisions for budget tracking
  const ledger = readLedgerWithIntegrity(scratchDir).records;
  const previousDecisions = ledger.filter(
    (record): record is import("./types").AgentDecisionRecord =>
      record.type === undefined || record.type === "decision.evaluated",
  );
  const reservations = distinctReservations(ledger);

  // Count recent actions (within last hour)
  const oneHourAgo = Date.now() - 3600_000;
  const actionsThisHour = reconstructRecoveryBudget(ledger, "", Date.now()).actionsThisHour;

  const budget: BudgetState = {
    actionsThisJob: 0,
    actionsThisHour,
    hourWindowStart: oneHourAgo,
  };

  // ── 1. Check node disk ──────────────────────────────────
  const nodeDiskMb = diskAvailableMb ?? getDiskAvailableMb(scratchDir);

  // ── 2. Scan bundles ─────────────────────────────────────
  const bundleDirs = scanBundles(scratchDir);

  for (const { jobId, bundlePath } of bundleDirs) {
    // Read status and manifest
    const statusFile = readStatusFile(bundlePath);
    if (!statusFile) continue;

    const manifestPath = join(bundlePath, "manifest.json");
    let manifest: Record<string, unknown> = {};
    try {
      if (existsSync(manifestPath)) {
        manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      }
    } catch {
      // best-effort
    }

    // Build input
    const input: RecoveryInput = {
      nodeState: {
        diskAvailableMb: nodeDiskMb,
        temperature: undefined,
      },
      job: {
        status: statusFile.state,
        exitCode: statusFile.exitCode,
      },
      attempt: {
        status: statusFile.state,
        pid: statusFile.pid,
        exitCode: statusFile.exitCode,
      },
      artifacts: scanArtifacts(bundlePath),
      logs: scanLogs(bundlePath),
      daemonState: {
        orphans: listOrphans(scratchDir),
      },
      previousRecoveryEvents: previousDecisions.map((d) => ({
        decision: d.decision,
        jobId: d.jobId ?? "",
      })),
    };

    // Reset per-job budget
    const jobActionCount = reconstructRecoveryBudget(reservations, jobId).actionsThisJob;
    budget.actionsThisJob = jobActionCount;

    // Evaluate policy
    const decision = evaluateRecovery(input, { config, budget });

    // Record the decision
    const record = createDecisionRecord(
      nodeId,
      decision.decision,
      decision.reason,
      decision.confidence,
      `mode=${config.mode},maxPerJob=${config.maxRecoveryActionsPerJob}`,
      { jobId, attemptId: statusFile.attemptId },
    );
    if (decision.decision !== "none" && decision.requiresHeadApproval)
      record.blockedAt = Date.now();
    appendDecision(scratchDir, record);
    events.push(
      makeDecisionEvaluatedEvent(nodeId, {
        jobId,
        attemptId: statusFile.attemptId,
        decision: decision.decision,
        reason: decision.reason,
        confidence: decision.confidence,
        allowedByPolicy: decision.allowedByPolicy,
        decisionId: record.id,
      }),
    );

    // Execute if safe
    if (decision.decision !== "none" && isDecisionAutoExecutable(decision)) {
      const reservation = createActionReservation(record);
      appendDecision(scratchDir, reservation);
      reservations.push(reservation);
      budget.actionsThisHour++;
      events.push(
        makeRecoveryStartedEvent(nodeId, {
          jobId,
          attemptId: statusFile.attemptId,
          decision: decision.decision,
          reason: decision.reason,
          decisionId: record.id,
          reservationId: reservation.id,
        }),
      );

      let result: { ok: boolean; message?: string };
      try {
        result = await executeSafeAction(
          scratchDir,
          decision.decision,
          jobId,
          statusFile.attemptId,
          bundlePath,
          manifest,
        );
      } catch (error) {
        appendDecision(
          scratchDir,
          createActionTerminal(
            reservation.id,
            false,
            error instanceof Error ? error.message : String(error),
          ),
        );
        throw error;
      }
      const terminal = createActionTerminal(reservation.id, result.ok, result.message);
      appendDecision(scratchDir, terminal);

      if (result.ok) {
        events.push(
          makeRecoveryCompletedEvent(nodeId, {
            jobId,
            attemptId: statusFile.attemptId,
            decision: decision.decision,
            reason: result.message ?? decision.reason,
            decisionId: record.id,
            reservationId: reservation.id,
            terminalId: terminal.id,
          }),
        );
      } else {
        events.push(
          makeRecoveryFailedEvent(nodeId, {
            jobId,
            attemptId: statusFile.attemptId,
            decision: decision.decision,
            reason: result.message ?? decision.reason,
            error: result.message,
            decisionId: record.id,
            reservationId: reservation.id,
            terminalId: terminal.id,
          }),
        );
      }

      decisions.push({ decision: decision.decision, executed: result.ok });
    } else if (decision.decision !== "none" && decision.requiresHeadApproval) {
      // Decision blocked — needs head approval
      events.push(
        makeDecisionBlockedEvent(nodeId, {
          jobId,
          attemptId: statusFile.attemptId,
          decision: decision.decision,
          reason: decision.reason,
          blockReason: "requires head approval",
          decisionId: record.id,
        }),
      );
      decisions.push({ decision: decision.decision, executed: false });
    } else if (decision.decision === "none") {
      decisions.push({ decision: "none", executed: false });
    } else {
      // Not allowed by policy
      events.push(
        makeDecisionSkippedEvent(nodeId, {
          jobId,
          attemptId: statusFile.attemptId,
          decision: decision.decision,
          reason: `Blocked by policy: ${decision.reason}`,
          decisionId: record.id,
        }),
      );
      decisions.push({ decision: decision.decision, executed: false });
    }
  }

  return { events, decisions, ok: true };
}

// ── Action dispatch ─────────────────────────────────────

async function executeSafeAction(
  scratchDir: string,
  decision: RecoveryActionKind,
  jobId: string,
  attemptId: string,
  bundlePath: string,
  manifest: Record<string, unknown>,
): Promise<{ ok: boolean; message?: string }> {
  switch (decision) {
    case "retry-artifact-sync":
      return retryArtifactSync(scratchDir, jobId, attemptId);

    case "retry-parser": {
      // Find output path from manifest or scan artifacts
      const outputName = (manifest as any).outputName;
      const outputPath = outputName
        ? join(bundlePath, "artifacts", outputName)
        : join(bundlePath, "artifacts");
      return retryParserIfOutputExists(scratchDir, jobId, outputPath);
    }

    case "mark-draining":
      return markNodeDraining(scratchDir, jobId, "Low disk space detected by recovery policy");

    case "reattach-pid": {
      const pid = (manifest as any).pid;
      if (typeof pid === "number") {
        return reattachKnownPid(scratchDir, jobId, pid);
      }
      return { ok: false, message: `No PID found for job ${jobId}` };
    }

    case "mark-zombie-failed":
      return markZombieFailed(scratchDir, jobId, attemptId);

    case "retry-same-command-once":
      return retrySameCommandOnce(scratchDir, jobId);

    default:
      return { ok: false, message: `Unknown decision: ${decision}` };
  }
}

// ── Scanning helpers ───────────────────────────────────

interface BundleInfo {
  jobId: string;
  bundlePath: string;
  dirKind: "running" | "failed" | "done" | "orphaned";
}

function scanBundles(scratchDir: string): BundleInfo[] {
  const results: BundleInfo[] = [];

  const dirs: Array<{ dir: string; kind: BundleInfo["dirKind"] }> = [
    { dir: getRunningDir(scratchDir), kind: "running" },
    { dir: getFailedDir(scratchDir), kind: "failed" },
    { dir: getDoneDir(scratchDir), kind: "done" },
    { dir: getOrphanedDir(scratchDir), kind: "orphaned" },
  ];

  for (const { dir, kind } of dirs) {
    if (!existsSync(dir)) continue;
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        results.push({
          jobId: entry.name,
          bundlePath: join(dir, entry.name),
          dirKind: kind,
        });
      }
    }
  }

  return results;
}

function scanArtifacts(bundlePath: string): Array<{ kind: string; path: string; exists: boolean }> {
  const artifactsDir = join(bundlePath, "artifacts");
  if (!existsSync(artifactsDir)) return [];

  const results: Array<{ kind: string; path: string; exists: boolean }> = [];
  const entries = readdirSync(artifactsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isFile()) {
      results.push({
        kind: classifyArtifact(entry.name),
        path: join(artifactsDir, entry.name),
        exists: true,
      });
    }
  }

  return results;
}

function scanLogs(bundlePath: string): Array<{ path: string; exists: boolean }> {
  const logDir = join(bundlePath, "logs");
  if (!existsSync(logDir)) return [];

  return readdirSync(logDir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => ({ path: join(logDir, e.name), exists: true }));
}

function classifyArtifact(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.startsWith("input")) return "input";
  if (lower.startsWith("output")) return "output";
  if (lower.endsWith(".out") || lower.endsWith(".log")) return "output";
  if (lower.endsWith(".chk") || lower.endsWith(". checkpoint")) return "checkpoint";
  return "other";
}

function listOrphans(scratchDir: string): string[] {
  const orphanedDir = getOrphanedDir(scratchDir);
  if (!existsSync(orphanedDir)) return [];

  return readdirSync(orphanedDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

function getDiskAvailableMb(scratchDir: string): number {
  try {
    const stat = statfsSync(scratchDir);
    const mb = Math.floor((stat.bavail * stat.bsize) / (1024 * 1024));
    return mb >= 0 ? mb : 100000;
  } catch {
    return 100000;
  }
}
