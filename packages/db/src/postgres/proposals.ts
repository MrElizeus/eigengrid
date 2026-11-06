import { generateId } from "@eigengrid/core";
import type { CreateProposalInput, ProposalRow, ProposalStatus } from "../client";
import { DbInvalidTransitionError, DbNotFoundError } from "../errors";
import type { PostgresContext } from "./context";
import { VALID_PROPOSAL_TRANSITIONS, mapProposalRow } from "./row-helpers";

export async function createProposal(
  context: PostgresContext,
  input: CreateProposalInput,
): Promise<string> {
  const id = generateId("prop");
  const now = Date.now();

  await context.query(
    `INSERT INTO proposals (id, job_id, action, reason, proposed_changes, status, diagnosis_json, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      input.jobId,
      input.action,
      input.reason,
      input.proposedChanges,
      "pending",
      input.diagnosis ? JSON.stringify(input.diagnosis) : null,
      now,
      now,
    ],
  );

  return id;
}

export async function getProposal(
  context: PostgresContext,
  proposalId: string,
): Promise<ProposalRow | null> {
  const row = await context.queryOne("SELECT * FROM proposals WHERE id = $1", [proposalId]);
  return row ? mapProposalRow(row) : null;
}

export async function listProposals(
  context: PostgresContext,
  filters?: {
    jobId?: string;
    status?: ProposalStatus;
  },
): Promise<ProposalRow[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (filters?.jobId) {
    conditions.push(`job_id = $${paramIdx++}`);
    params.push(filters.jobId);
  }
  if (filters?.status) {
    conditions.push(`status = $${paramIdx++}`);
    params.push(filters.status);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const { rows } = await context.query(
    `SELECT * FROM proposals ${whereClause} ORDER BY created_at DESC`,
    params,
  );
  return rows.map(mapProposalRow);
}

export async function updateProposalStatus(
  context: PostgresContext,
  proposalId: string,
  status: ProposalStatus,
): Promise<void> {
  const current = await context.queryOne("SELECT status FROM proposals WHERE id = $1", [
    proposalId,
  ]);
  if (!current) {
    throw new DbNotFoundError("Proposal", proposalId);
  }

  const currentStatus = current.status as ProposalStatus;
  const allowed = VALID_PROPOSAL_TRANSITIONS[currentStatus];

  if (!allowed || !allowed.includes(status)) {
    throw new DbInvalidTransitionError("proposal", currentStatus, status, [...(allowed ?? [])]);
  }

  await context.query("UPDATE proposals SET status = $1, updated_at = $2 WHERE id = $3", [
    status,
    Date.now(),
    proposalId,
  ]);
}
