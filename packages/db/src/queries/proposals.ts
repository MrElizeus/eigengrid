import type { DatabaseLike } from "../client";
import { generateId } from "@eigengrid/core";
import { DbNotFoundError, DbInvalidTransitionError } from "../errors";

interface SqliteConn {
  query(sql: string): {
    run(params?: Record<string, unknown>): unknown;
    get(params?: Record<string, unknown>): Record<string, unknown> | undefined;
    all(params?: Record<string, unknown>): Record<string, unknown>[];
  };
}

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

export type ProposalStatus = "pending" | "approved" | "rejected" | "executed";

export interface ProposalRow {
  id: string;
  jobId: string;
  action: string;
  reason: string;
  proposedChanges: string;
  status: ProposalStatus;
  diagnosisJson: string | null;
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
// CRUD
// ────────────────────────────────────────────────────────────

/**
 * Valid proposal status transitions.
 */
const VALID_PROPOSAL_TRANSITIONS: Record<ProposalStatus, readonly ProposalStatus[]> = {
  pending: ["approved", "rejected"],
  approved: ["executed"],
  rejected: [],
  executed: [],
};

/**
 * Create a new retry proposal in the database.
 * Returns the generated proposal ID.
 */
export async function createProposal(
  db: DatabaseLike,
  input: CreateProposalInput,
): Promise<string> {
  if (db._provider === "sqlite") {
    const sqlite = db as unknown as { ensureDb(): SqliteConn };
    const dbConn = sqlite.ensureDb();
    const id = generateId("prop");
    const now = Date.now();

    dbConn
      .query(
        `INSERT INTO proposals (id, job_id, action, reason, proposed_changes, status, diagnosis_json, created_at, updated_at)
         VALUES ($id, $jobId, $action, $reason, $proposedChanges, $status, $diagnosisJson, $createdAt, $updatedAt)`,
      )
      .run({
        $id: id,
        $jobId: input.jobId,
        $action: input.action,
        $reason: input.reason,
        $proposedChanges: input.proposedChanges,
        $status: "pending",
        $diagnosisJson: input.diagnosis ? JSON.stringify(input.diagnosis) : null,
        $createdAt: now,
        $updatedAt: now,
      });

    return id;
  }

  return db.createProposal(input);
}

/**
 * Get a proposal by ID.
 */
export async function getProposal(
  db: DatabaseLike,
  proposalId: string,
): Promise<ProposalRow | null> {
  if (db._provider === "sqlite") {
    const sqlite = db as unknown as { ensureDb(): SqliteConn };
    const dbConn = sqlite.ensureDb();
    const row = dbConn.query("SELECT * FROM proposals WHERE id = $id").get({ $id: proposalId }) as
      | Record<string, unknown>
      | undefined;

    if (!row) return null;
    return mapRow(row);
  }

  return db.getProposal(proposalId);
}

/**
 * List proposals, optionally filtered by job ID or status.
 */
export async function listProposals(
  db: DatabaseLike,
  filters?: { jobId?: string; status?: ProposalStatus },
): Promise<ProposalRow[]> {
  if (db._provider === "sqlite") {
    const sqlite = db as unknown as { ensureDb(): SqliteConn };
    const dbConn = sqlite.ensureDb();
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (filters?.jobId) {
      conditions.push("job_id = $jobId");
      params.$jobId = filters.jobId;
    }
    if (filters?.status) {
      conditions.push("status = $status");
      params.$status = filters.status;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const rows = dbConn
      .query(`SELECT * FROM proposals ${whereClause} ORDER BY created_at DESC`)
      .all(params) as Record<string, unknown>[];

    return rows.map(mapRow);
  }

  return db.listProposals(filters);
}

/**
 * Update proposal status with transition validation.
 * Throws if the transition is invalid.
 */
export async function updateProposalStatus(
  db: DatabaseLike,
  proposalId: string,
  status: ProposalStatus,
): Promise<void> {
  if (db._provider === "sqlite") {
    const sqlite = db as unknown as { ensureDb(): SqliteConn };
    const dbConn = sqlite.ensureDb();

    // Get current status
    const current = dbConn
      .query("SELECT status FROM proposals WHERE id = $id")
      .get({ $id: proposalId }) as { status: string } | undefined;

    if (!current) {
      throw new DbNotFoundError("Proposal", proposalId);
    }

    const currentStatus = current.status as ProposalStatus;
    const allowed = VALID_PROPOSAL_TRANSITIONS[currentStatus];

    if (!allowed || !allowed.includes(status)) {
      throw new DbInvalidTransitionError("proposal", currentStatus, status, [...(allowed ?? [])]);
    }

    dbConn
      .query("UPDATE proposals SET status = $status, updated_at = $updatedAt WHERE id = $id")
      .run({
        $status: status,
        $updatedAt: Date.now(),
        $id: proposalId,
      });

    return;
  }

  // PostgreSQL path: delegate to DatabaseLike.updateProposalStatus
  return db.updateProposalStatus(proposalId, status);
}

// ────────────────────────────────────────────────────────────
// Mapping
// ────────────────────────────────────────────────────────────

function mapRow(row: Record<string, unknown>): ProposalRow {
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    action: String(row.action),
    reason: String(row.reason),
    proposedChanges: String(row.proposed_changes),
    status: String(row.status) as ProposalStatus,
    diagnosisJson: row.diagnosis_json != null ? String(row.diagnosis_json) : null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}
