import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  SqliteProposalStore,
  makeDiagnosisStartedEvent,
  makeDecisionProposedEvent,
} from "@eigengrid/agent";
import { createDatabase } from "@eigengrid/db";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ────────────────────────────────────────────────────────────
// Setup: create a database inside this run's private temporary directory
// ────────────────────────────────────────────────────────────

let db: ReturnType<typeof createDatabase>;
let store: SqliteProposalStore;
let workspace: string;

let jobCounter = 0;

async function createTestJob(): Promise<string> {
  jobCounter++;
  const jobId = `test-job-${Date.now()}-${jobCounter}`;
  await db.createJob({
    id: jobId,
    name: "test",
    software: "gaussian",
    inputPath: join(workspace, "test.inp"),
    workdir: workspace,
  });
  return jobId;
}

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), "eigengrid-proposals-"));
  db = createDatabase(join(workspace, "proposals.sqlite"));
  await db.init();
  store = new SqliteProposalStore(db as any);
});

afterAll(async () => {
  try {
    await db?.close();
  } finally {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────
// Proposal CRUD
// ────────────────────────────────────────────────────────────

describe("SqliteProposalStore", () => {
  it("creates a proposal and returns an ID", async () => {
    const jobId = await createTestJob();
    const id = await store.create({
      jobId,
      action: "retry-job",
      reason: "Exit code 1 indicates runtime failure",
      proposedChanges: "Re-submit job with same input",
    });
    expect(id).toBeTruthy();
    expect(typeof id).toBe("string");
    expect(id.startsWith("prop_")).toBe(true);
  });

  it("gets a proposal by ID", async () => {
    const jobId = await createTestJob();
    const id = await store.create({
      jobId,
      action: "retry-with-tighter-scf",
      reason: "SCF did not converge",
      proposedChanges: "Add SCF=tight to input file",
    });

    const proposal = await store.get(id);
    expect(proposal).not.toBeNull();
    expect(proposal!.id).toBe(id);
    expect(proposal!.jobId).toBe(jobId);
    expect(proposal!.action).toBe("retry-with-tighter-scf");
    expect(proposal!.reason).toContain("SCF");
    expect(proposal!.status).toBe("pending");
    expect(proposal!.createdAt).toBeGreaterThan(0);
  });

  it("returns null for unknown proposal", async () => {
    const proposal = await store.get("nonexistent");
    expect(proposal).toBeNull();
  });

  it("lists proposals by job ID", async () => {
    const jobId = await createTestJob();
    await store.create({ jobId, action: "retry-job", reason: "Failed", proposedChanges: "Retry" });
    await store.create({
      jobId,
      action: "reparse-job",
      reason: "Parse failed",
      proposedChanges: "Reparse",
    });

    const proposals = await store.list({ jobId });
    expect(proposals.length).toBeGreaterThanOrEqual(2);
    for (const p of proposals) {
      expect(p.jobId).toBe(jobId);
    }
  });

  it("lists proposals filtered by status", async () => {
    const jobId = await createTestJob();
    await store.create({ jobId, action: "retry-job", reason: "Failed", proposedChanges: "Retry" });
    const id2 = await store.create({
      jobId,
      action: "reparse-job",
      reason: "Parse failed",
      proposedChanges: "Reparse",
    });

    // Approve the second one
    await store.updateStatus(id2, "approved");

    const pending = await store.list({ jobId, status: "pending" });
    const approved = await store.list({ jobId, status: "approved" });

    expect(pending.length).toBeGreaterThanOrEqual(1);
    expect(pending.every((p) => p.status === "pending")).toBe(true);
    expect(approved.length).toBeGreaterThanOrEqual(1);
    expect(approved.every((p) => p.status === "approved")).toBe(true);
  });

  it("updates proposal status", async () => {
    const jobId = await createTestJob();
    const id = await store.create({
      jobId,
      action: "retry-job",
      reason: "Failed",
      proposedChanges: "Retry",
    });

    // Check initial status
    let proposal = await store.get(id);
    expect(proposal!.status).toBe("pending");

    // Approve
    await store.updateStatus(id, "approved");
    proposal = await store.get(id);
    expect(proposal!.status).toBe("approved");

    // Mark as executed
    await store.updateStatus(id, "executed");
    proposal = await store.get(id);
    expect(proposal!.status).toBe("executed");

    // Updated timestamp should be newer
    expect(proposal!.updatedAt).toBeGreaterThanOrEqual(proposal!.createdAt);
  });
});

// ────────────────────────────────────────────────────────────
// Full proposal lifecycle
// ────────────────────────────────────────────────────────────

describe("Proposal lifecycle", () => {
  it("completes the full create → approve → execute flow", async () => {
    const jobId = await createTestJob();

    // 1. Create
    const id = await store.create({
      jobId,
      action: "retry-job",
      reason: "Process exited with code 134 (SIGABRT)",
      proposedChanges: "Re-submit job with increased memory limit",
      diagnosis: { jobStatus: "failed", exitCode: 134 },
    });

    expect(id).toBeTruthy();

    // 2. Verify pending
    let proposal = await store.get(id);
    expect(proposal!.status).toBe("pending");
    expect(proposal!.diagnosis).toBeDefined();
    expect(proposal!.diagnosis!.jobStatus).toBe("failed");

    // 3. Approve
    await store.updateStatus(id, "approved");
    proposal = await store.get(id);
    expect(proposal!.status).toBe("approved");

    // 4. Execute
    await store.updateStatus(id, "executed");
    proposal = await store.get(id);
    expect(proposal!.status).toBe("executed");

    // 5. Cannot approve again
    await expect(store.updateStatus(id, "approved")).rejects.toThrow();
  });
});

// ────────────────────────────────────────────────────────────
// Event helpers
// ────────────────────────────────────────────────────────────

describe("Event helper functions", () => {
  it("makeDiagnosisStartedEvent creates a valid event", () => {
    const event = makeDiagnosisStartedEvent("job-123", { dryRun: true });
    expect(event.type).toBe("agent.diagnosis.started");
    expect(event.jobId).toBe("job-123");
    expect(event.source).toBe("cli");
    expect(event.payload?.dryRun).toBe(true);
  });

  it("makeDecisionProposedEvent creates a valid event", () => {
    const event = makeDecisionProposedEvent("job-123", "prop-abc", { action: "retry-job" });
    expect(event.type).toBe("agent.decision.proposed");
    expect(event.jobId).toBe("job-123");
    expect(event.payload?.proposalId).toBe("prop-abc");
    expect(event.payload?.action).toBe("retry-job");
  });
});
