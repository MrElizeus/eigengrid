import type { WorkerAgentConfig } from "@eigengrid/core";
import type { RecoveryInput, RecoveryDecision, BudgetState } from "./types";

// ────────────────────────────────────────────────────────────
// Recovery Policy — Pure Decision Engine
// ────────────────────────────────────────────────────────────

export interface PolicyContext {
  config: WorkerAgentConfig;
  budget: BudgetState;
}

/**
 * Evaluate the current state and return a recovery decision.
 * Pure function — no side effects, no I/O, fully testable.
 */
export function evaluateRecovery(input: RecoveryInput, ctx: PolicyContext): RecoveryDecision {
  // ── Budget Check ─────────────────────────────────────────
  if (ctx.budget.actionsThisJob >= ctx.config.maxRecoveryActionsPerJob) {
    return budgetExceededDecision(
      "maxRecoveryActionsPerJob",
      ctx.budget.actionsThisJob,
      ctx.config.maxRecoveryActionsPerJob,
    );
  }

  if (ctx.budget.actionsThisHour >= ctx.config.maxRecoveryActionsPerHour) {
    return budgetExceededDecision(
      "maxRecoveryActionsPerHour",
      ctx.budget.actionsThisHour,
      ctx.config.maxRecoveryActionsPerHour,
    );
  }

  // ── Previous recovery check ──────────────────────────────
  const previousSameCommandRetry = input.previousRecoveryEvents.filter(
    (e) => e.decision === "retry-same-command-once",
  );

  // ── Decision Logic ───────────────────────────────────────

  // 1. Node draining — low disk space
  if (input.nodeState.diskAvailableMb < 1024) {
    return {
      decision: "mark-draining",
      reason: `Node has only ${input.nodeState.diskAvailableMb} MB disk available; marking for drain`,
      confidence: "high",
      requiresHeadApproval: false,
      allowedByPolicy: ctx.config.allowNodeDrain,
    };
  }

  // 2. Zombie PID cleanup — job says running but PID is dead
  if (input.job.status === "running" || input.job.status === "orphaned") {
    if (!input.attempt.pid) {
      return {
        decision: "mark-zombie-failed",
        reason: `Job ${input.job.status} with no PID; marking as zombie failed`,
        confidence: "high",
        requiresHeadApproval: false,
        allowedByPolicy: true,
      };
    }

    // PID exists — we can try to reattach
    return {
      decision: "reattach-pid",
      reason: `Job state is "${input.job.status}" with PID ${input.attempt.pid}; attempting reattach`,
      confidence: "medium",
      requiresHeadApproval: true,
      allowedByPolicy: ctx.config.allowPidReattach,
    };
  }

  // 3. Artifact sync retry — output artifact missing/partial
  if (input.job.status === "failed" || input.job.status === "completed") {
    const outputArtifacts = input.artifacts.filter((a) => a.kind === "output");
    const allOutputsExist = outputArtifacts.every((a) => a.exists);

    if (outputArtifacts.length > 0 && !allOutputsExist) {
      return {
        decision: "retry-artifact-sync",
        reason: `${outputArtifacts.filter((a) => !a.exists).length} of ${outputArtifacts.length} output artifacts missing; retrying sync`,
        confidence: "medium",
        requiresHeadApproval: false,
        allowedByPolicy: ctx.config.allowArtifactSyncRetry,
      };
    }
  }

  // 4. Parser retry — output exists but not parsed
  if (input.job.status === "completed") {
    const outputExists = input.artifacts.some((a) => a.kind === "output" && a.exists);

    if (outputExists) {
      return {
        decision: "retry-parser",
        reason: "Output artifacts exist but may need re-parsing",
        confidence: "low",
        requiresHeadApproval: true,
        allowedByPolicy: ctx.config.allowParserRetry,
      };
    }
  }

  // 5. Same command retry — job failed, no artifacts missing
  if (
    input.job.status === "failed" &&
    input.job.exitCode !== 0 &&
    previousSameCommandRetry.length === 0
  ) {
    return {
      decision: "retry-same-command-once",
      reason: `Job failed with exit code ${input.job.exitCode ?? "unknown"}; one retry permitted`,
      confidence: "low",
      requiresHeadApproval: true,
      allowedByPolicy: ctx.config.allowSameCommandRetry,
    };
  }

  // 6. No recovery action needed
  return noActionNeeded();
}

// ── Helper Decisions ─────────────────────────────────────

function budgetExceededDecision(
  budgetKind: string,
  current: number,
  max: number,
): RecoveryDecision {
  return {
    decision: "none",
    reason: `${budgetKind} exceeded (${current}/${max})`,
    confidence: "high",
    requiresHeadApproval: false,
    allowedByPolicy: true,
  };
}

export function noActionNeeded(): RecoveryDecision {
  return {
    decision: "none",
    reason: "No recovery action required",
    confidence: "high",
    requiresHeadApproval: false,
    allowedByPolicy: true,
  };
}

/**
 * Check if a decision is safe to execute without head approval.
 */
export function isDecisionAutoExecutable(decision: RecoveryDecision): boolean {
  if (decision.decision === "none") return false;
  if (!decision.allowedByPolicy) return false;
  if (decision.requiresHeadApproval) return false;
  return true;
}
