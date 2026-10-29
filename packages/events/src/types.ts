import type { JobStatus, NodeStatus } from "@eigengrid/core";

// ── Unified event type system ─────────────────────

export type EigenGridEventType =
  | "job.created"
  | "job.status.changed"
  | "recipe.selected"
  | "slurm.job.submitted"
  | "slurm.job.status.synced"
  | "slurm.job.cancelled"
  | "slurm.job.failed"
  | "slurm.artifact.registered"
  | "slurm.accounting.synced"
  | "attempt.created"
  | "attempt.status.changed"
  | "process.started"
  | "process.completed"
  | "process.failed"
  | "process.cancelled"
  | "artifact.registered"
  | "parse.started"
  | "parse.completed"
  | "parse.failed"
  | "result.saved"
  | "node.status.changed"
  | "system.notice"
  // ── Agent Events ──────────────────────────────
  | "agent.diagnosis.started"
  | "agent.tool.called"
  | "agent.tool.blocked"
  | "agent.decision.proposed"
  | "agent.decision.approved"
  | "agent.action.executed"
  | "agent.diagnosis.completed"
  // ── Worker Agent Events ──────────────────────
  | "worker.recovery.started"
  | "worker.recovery.completed"
  | "worker.recovery.failed"
  | "agent.decision.evaluated"
  | "agent.decision.skipped"
  | "agent.decision.blocked"
  // ── Scheduler Events ─────────────────────────
  | "scheduler.cycle.started"
  | "scheduler.node.skipped"
  | "scheduler.job.held"
  | "scheduler.job.dispatched"
  | "scheduler.cycle.completed"
  | "scheduler.dispatch.failed"
  // ── Power Management Events ──────────────
  | "scheduler.node.wake.proposed"
  | "scheduler.node.wake.requested"
  | "scheduler.node.wake.skipped"
  | "scheduler.node.wake.confirmed"
  | "scheduler.node.powerdown.proposed"
  | "scheduler.node.powerdown.blocked"
  | "scheduler.node.powerdown.executed"
  | "scheduler.node.powerdown.skipped";

export interface EigenGridEventBase {
  id: string;
  type: EigenGridEventType;
  at: number;
  source: "cli" | "runner" | "parser" | "db" | "system";
  jobId?: string;
  attemptId?: string;
  artifactId?: string;
  resultId?: string;
  payload?: Record<string, unknown>;
}

// ── Legacy event types (kept for persisted job compatibility) ──

export type EigenGridEvent =
  | { type: "job:created"; jobId: string; at: number }
  | { type: "job:status:changed"; jobId: string; from: JobStatus; to: JobStatus; at: number }
  | { type: "job:log:line"; jobId: string; line: string; at: number }
  | { type: "node:status:changed"; nodeId: string; status: NodeStatus; at: number }
  | { type: "system:notice"; message: string; at: number };
