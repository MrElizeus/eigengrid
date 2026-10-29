import type { DatabaseLike, ProposalRow as DbProposalRow } from "@eigengrid/db";
import type { EigenGridEventBase } from "@eigengrid/events";
import { randomUUID } from "node:crypto";

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

export type ProposalStatus = "pending" | "approved" | "rejected" | "executed";

export interface Proposal {
  id: string;
  jobId: string;
  action: string;
  reason: string;
  proposedChanges: string;
  status: ProposalStatus;
  diagnosis?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface CreateProposalInput {
  jobId: string;
  action: string;
  reason: string;
  proposedChanges: string;
  diagnosis?: Record<string, unknown>;
}

// ────────────────────────────────────────────────────────────
// Store interface (abstracts DB queries for testability)
// ────────────────────────────────────────────────────────────

export interface ProposalStore {
  create(input: CreateProposalInput): Promise<string>;
  get(id: string): Promise<Proposal | null>;
  list(filters?: { jobId?: string; status?: ProposalStatus }): Promise<Proposal[]>;
  updateStatus(id: string, status: ProposalStatus): Promise<void>;
}

// ────────────────────────────────────────────────────────────
// SQLite-backed ProposalStore
// ────────────────────────────────────────────────────────────

export class SqliteProposalStore implements ProposalStore {
  private db: DatabaseLike;

  constructor(db: DatabaseLike) {
    this.db = db;
  }

  async create(input: CreateProposalInput): Promise<string> {
    // Use dynamic import to avoid circular deps
    const { createProposal: dbCreate } = await import("@eigengrid/db");
    return dbCreate(this.db, input);
  }

  async get(id: string): Promise<Proposal | null> {
    const { getProposal: dbGet } = await import("@eigengrid/db");
    const row = await dbGet(this.db, id);
    if (!row) return null;
    return this.mapRow(row);
  }

  async list(filters?: { jobId?: string; status?: ProposalStatus }): Promise<Proposal[]> {
    const { listProposals: dbList } = await import("@eigengrid/db");
    const rows = await dbList(this.db, filters);
    return rows.map((r) => this.mapRow(r));
  }

  async updateStatus(id: string, status: ProposalStatus): Promise<void> {
    const { updateProposalStatus: dbUpdate } = await import("@eigengrid/db");
    await dbUpdate(this.db, id, status);
  }

  private mapRow(row: DbProposalRow): Proposal {
    return {
      id: row.id,
      jobId: row.jobId,
      action: row.action,
      reason: row.reason,
      proposedChanges: row.proposedChanges,
      status: row.status,
      diagnosis: row.diagnosisJson ? (tryParseJson(row.diagnosisJson) ?? undefined) : undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

// ────────────────────────────────────────────────────────────
// Event helpers
// ────────────────────────────────────────────────────────────

export function makeDiagnosisStartedEvent(
  jobId: string,
  extra?: Record<string, unknown>,
): EigenGridEventBase {
  return {
    id: randomUUID(),
    type: "agent.diagnosis.started",
    at: Date.now(),
    source: "cli",
    jobId,
    payload: extra,
  };
}

export function makeDiagnosisCompletedEvent(
  jobId: string,
  extra?: Record<string, unknown>,
): EigenGridEventBase {
  return {
    id: randomUUID(),
    type: "agent.diagnosis.completed",
    at: Date.now(),
    source: "cli",
    jobId,
    payload: extra,
  };
}

export function makeDecisionProposedEvent(
  jobId: string,
  proposalId: string,
  extra?: Record<string, unknown>,
): EigenGridEventBase {
  return {
    id: randomUUID(),
    type: "agent.decision.proposed",
    at: Date.now(),
    source: "cli",
    jobId,
    payload: { proposalId, ...extra },
  };
}

export function makeDecisionApprovedEvent(
  jobId: string,
  proposalId: string,
  extra?: Record<string, unknown>,
): EigenGridEventBase {
  return {
    id: randomUUID(),
    type: "agent.decision.approved",
    at: Date.now(),
    source: "cli",
    jobId,
    payload: { proposalId, ...extra },
  };
}

export function makeActionExecutedEvent(
  jobId: string,
  proposalId: string,
  extra?: Record<string, unknown>,
): EigenGridEventBase {
  return {
    id: randomUUID(),
    type: "agent.action.executed",
    at: Date.now(),
    source: "cli",
    jobId,
    payload: { proposalId, ...extra },
  };
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

function tryParseJson(json: string): Record<string, unknown> | null {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
