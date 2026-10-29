// ────────────────────────────────────────────────────────────
// Recovery Input — the full context the policy evaluates
// ────────────────────────────────────────────────────────────

export interface NodeState {
  diskAvailableMb: number;
  temperature?: number;
}

export interface JobInfo {
  status: string;
  exitCode?: number;
}

export interface AttemptInfo {
  status: string;
  pid?: number;
  exitCode?: number;
}

export interface ArtifactInfo {
  kind: string;
  path: string;
  exists: boolean;
}

export interface LogInfo {
  path: string;
  exists: boolean;
}

export interface DaemonStateInfo {
  orphans: string[];
}

export interface PastRecoveryEvent {
  decision: string;
  jobId: string;
}

export interface RecoveryInput {
  nodeState: NodeState;
  job: JobInfo;
  attempt: AttemptInfo;
  artifacts: ArtifactInfo[];
  logs: LogInfo[];
  daemonState: DaemonStateInfo;
  previousRecoveryEvents: PastRecoveryEvent[];
}

// ────────────────────────────────────────────────────────────
// Recovery Decision — the policy's output
// ────────────────────────────────────────────────────────────

export type RecoveryActionKind =
  | "none"
  | "retry-artifact-sync"
  | "retry-parser"
  | "mark-draining"
  | "reattach-pid"
  | "mark-zombie-failed"
  | "retry-same-command-once";

export type Confidence = "low" | "medium" | "high";

export interface RecoveryDecision {
  decision: RecoveryActionKind;
  reason: string;
  confidence: Confidence;
  requiresHeadApproval: boolean;
  allowedByPolicy: boolean;
}

// ────────────────────────────────────────────────────────────
// Worker Agent Decisions Store
// ────────────────────────────────────────────────────────────

export interface AgentDecisionRecord {
  type?: "decision.evaluated";
  id: string;
  nodeId: string;
  jobId?: string;
  attemptId?: string;
  decision: RecoveryActionKind;
  reason: string;
  confidence: Confidence;
  mode: "recover-only";
  policy: string;
  createdAt: number;
  executedAt?: number;
  blockedAt?: number;
  completedAt?: number;
}

export interface ActionReservationRecord {
  type: "action.reserved";
  id: string;
  decisionId: string;
  nodeId: string;
  jobId: string;
  attemptId?: string;
  decision: RecoveryActionKind;
  reservedAt: number;
}

export interface ActionTerminalRecord {
  type: "action.completed" | "action.failed";
  id: string;
  reservationId: string;
  occurredAt: number;
  message?: string;
}

export type AgentLedgerRecord =
  | AgentDecisionRecord
  | ActionReservationRecord
  | ActionTerminalRecord;

export interface DerivedActionHistory {
  evaluation: AgentDecisionRecord;
  reservation?: ActionReservationRecord;
  outcome?: "completed" | "failed" | "interrupted";
  message?: string;
}

// ────────────────────────────────────────────────────────────
// Budget Tracker
// ────────────────────────────────────────────────────────────

export interface BudgetState {
  actionsThisJob: number;
  actionsThisHour: number;
  hourWindowStart: number;
}

// ────────────────────────────────────────────────────────────
// Async recovery result
// ────────────────────────────────────────────────────────────

export interface RecoveryActionResult {
  ok: boolean;
  decision: RecoveryActionKind;
  message?: string;
}
