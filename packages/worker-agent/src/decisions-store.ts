import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import type {
  AgentDecisionRecord,
  AgentLedgerRecord,
  RecoveryActionKind,
  Confidence,
  ActionReservationRecord,
  ActionTerminalRecord,
  DerivedActionHistory,
} from "./types";
import { appendJsonLineSync, readJsonLinesWithIntegrity } from "@eigengrid/worker";

// ────────────────────────────────────────────────────────────
// Agent Decisions Store
// ────────────────────────────────────────────────────────────
// Persists decisions to a JSONL file in the daemon directory.
// This is used by CLI commands to audit decisions.

const DECISIONS_FILE = "agent-decisions.jsonl";

function getDecisionsPath(scratchDir: string): string {
  return join(scratchDir, "daemon", DECISIONS_FILE);
}

export function appendDecision(scratchDir: string, record: AgentLedgerRecord): void {
  const path = getDecisionsPath(scratchDir);
  const dir = join(scratchDir, "daemon");

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  appendJsonLineSync(path, record);
}

export function readDecisions(scratchDir: string): AgentDecisionRecord[] {
  return readLedgerWithIntegrity(scratchDir).records.filter(isDecisionRecord);
}

export function readDecisionsWithIntegrity(scratchDir: string) {
  const ledger = readLedgerWithIntegrity(scratchDir);
  return { ...ledger, records: ledger.records.filter(isDecisionRecord) };
}

export function readLedgerWithIntegrity(scratchDir: string) {
  return readJsonLinesWithIntegrity<AgentLedgerRecord>(getDecisionsPath(scratchDir));
}

export function deriveActionHistory(records: AgentLedgerRecord[]): DerivedActionHistory[] {
  const reservations = new Map<string, ActionReservationRecord>();
  const terminals = new Map<string, ActionTerminalRecord>();
  for (const record of records) {
    if (record.type === "action.reserved" && !reservations.has(record.id))
      reservations.set(record.id, record);
    if (
      (record.type === "action.completed" || record.type === "action.failed") &&
      !terminals.has(record.reservationId)
    )
      terminals.set(record.reservationId, record);
  }
  return records.filter(isDecisionRecord).map((evaluation) => {
    const reservation = [...reservations.values()].find(
      (item) => item.decisionId === evaluation.id,
    );
    const terminal = reservation && terminals.get(reservation.id);
    return {
      evaluation,
      reservation,
      outcome: reservation
        ? terminal?.type === "action.completed"
          ? "completed"
          : terminal?.type === "action.failed"
            ? "failed"
            : "interrupted"
        : undefined,
      message: terminal?.message,
    };
  });
}

export function distinctReservations(records: AgentLedgerRecord[]): ActionReservationRecord[] {
  const seen = new Set<string>();
  return records.filter(
    (record): record is ActionReservationRecord =>
      record.type === "action.reserved" && !seen.has(record.id) && (seen.add(record.id), true),
  );
}

export function reconstructRecoveryBudget(
  records: AgentLedgerRecord[],
  jobId: string,
  now = Date.now(),
) {
  const reservations = distinctReservations(records);
  return {
    actionsThisJob: reservations.filter((record) => record.jobId === jobId).length,
    actionsThisHour: reservations.filter((record) => record.reservedAt > now - 3600_000).length,
  };
}

function isDecisionRecord(record: AgentLedgerRecord): record is AgentDecisionRecord {
  return record.type === undefined || record.type === "decision.evaluated";
}

export function createDecisionRecord(
  nodeId: string,
  decision: RecoveryActionKind,
  reason: string,
  confidence: Confidence,
  policy: string,
  extra?: { jobId?: string; attemptId?: string },
): AgentDecisionRecord {
  const id = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return {
    type: "decision.evaluated",
    id,
    nodeId,
    jobId: extra?.jobId,
    attemptId: extra?.attemptId,
    decision,
    reason,
    confidence,
    mode: "recover-only",
    policy,
    createdAt: Date.now(),
  };
}

export function createActionReservation(record: AgentDecisionRecord): ActionReservationRecord {
  return {
    type: "action.reserved",
    id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
    decisionId: record.id,
    nodeId: record.nodeId,
    jobId: record.jobId ?? "",
    attemptId: record.attemptId,
    decision: record.decision,
    reservedAt: Date.now(),
  };
}

export function createActionTerminal(
  reservationId: string,
  ok: boolean,
  message?: string,
): ActionTerminalRecord {
  return {
    type: ok ? "action.completed" : "action.failed",
    id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
    reservationId,
    occurredAt: Date.now(),
    message,
  };
}
