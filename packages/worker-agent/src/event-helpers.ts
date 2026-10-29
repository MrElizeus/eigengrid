import type { EigenGridEventBase } from "@eigengrid/events";
import type { RecoveryActionKind, Confidence } from "./types";

// ────────────────────────────────────────────────────────────
// Worker Agent Event Helpers
// ────────────────────────────────────────────────────────────

function makeId(): string {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function makeRecoveryStartedEvent(
  nodeId: string,
  extra?: {
    jobId?: string;
    attemptId?: string;
    decision?: RecoveryActionKind;
    reason?: string;
    decisionId?: string;
    reservationId?: string;
  },
): EigenGridEventBase {
  return {
    id: makeId(),
    type: "worker.recovery.started",
    at: Date.now(),
    source: "system",
    jobId: extra?.jobId,
    attemptId: extra?.attemptId,
    payload: {
      nodeId,
      mode: "recover-only",
      decision: extra?.decision,
      reason: extra?.reason,
      ...extra,
    },
  };
}

export function makeRecoveryCompletedEvent(
  nodeId: string,
  extra?: {
    jobId?: string;
    attemptId?: string;
    decision?: RecoveryActionKind;
    reason?: string;
    decisionId?: string;
    reservationId?: string;
    terminalId?: string;
  },
): EigenGridEventBase {
  return {
    id: makeId(),
    type: "worker.recovery.completed",
    at: Date.now(),
    source: "system",
    jobId: extra?.jobId,
    attemptId: extra?.attemptId,
    payload: {
      nodeId,
      mode: "recover-only",
      decision: extra?.decision,
      reason: extra?.reason,
      ...extra,
    },
  };
}

export function makeRecoveryFailedEvent(
  nodeId: string,
  extra?: {
    jobId?: string;
    attemptId?: string;
    decision?: RecoveryActionKind;
    reason?: string;
    error?: string;
    decisionId?: string;
    reservationId?: string;
    terminalId?: string;
  },
): EigenGridEventBase {
  return {
    id: makeId(),
    type: "worker.recovery.failed",
    at: Date.now(),
    source: "system",
    jobId: extra?.jobId,
    attemptId: extra?.attemptId,
    payload: {
      nodeId,
      mode: "recover-only",
      decision: extra?.decision,
      reason: extra?.reason,
      error: extra?.error,
      ...extra,
    },
  };
}

export function makeDecisionEvaluatedEvent(
  nodeId: string,
  extra?: {
    jobId?: string;
    attemptId?: string;
    decision?: RecoveryActionKind;
    reason?: string;
    confidence?: Confidence;
    allowedByPolicy?: boolean;
    decisionId?: string;
  },
): EigenGridEventBase {
  return {
    id: makeId(),
    type: "agent.decision.evaluated",
    at: Date.now(),
    source: "system",
    jobId: extra?.jobId,
    attemptId: extra?.attemptId,
    payload: {
      nodeId,
      mode: "recover-only",
      decision: extra?.decision,
      reason: extra?.reason,
      confidence: extra?.confidence,
      allowedByPolicy: extra?.allowedByPolicy,
      ...extra,
    },
  };
}

export function makeDecisionSkippedEvent(
  nodeId: string,
  extra?: {
    jobId?: string;
    attemptId?: string;
    decision?: RecoveryActionKind;
    reason?: string;
    decisionId?: string;
  },
): EigenGridEventBase {
  return {
    id: makeId(),
    type: "agent.decision.skipped",
    at: Date.now(),
    source: "system",
    jobId: extra?.jobId,
    attemptId: extra?.attemptId,
    payload: {
      nodeId,
      mode: "recover-only",
      decision: extra?.decision,
      reason: extra?.reason,
      ...extra,
    },
  };
}

export function makeDecisionBlockedEvent(
  nodeId: string,
  extra?: {
    jobId?: string;
    attemptId?: string;
    decision?: RecoveryActionKind;
    reason?: string;
    blockReason?: string;
    decisionId?: string;
  },
): EigenGridEventBase {
  return {
    id: makeId(),
    type: "agent.decision.blocked",
    at: Date.now(),
    source: "system",
    jobId: extra?.jobId,
    attemptId: extra?.attemptId,
    payload: {
      nodeId,
      mode: "recover-only",
      decision: extra?.decision,
      reason: extra?.reason,
      blockReason: extra?.blockReason,
      ...extra,
    },
  };
}
