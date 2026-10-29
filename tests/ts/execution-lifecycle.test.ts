import { describe, expect, test } from "bun:test";
import {
  ExecutionIntentJournal,
  canTransitionExecution,
  type ExecutionIntent,
} from "@eigengrid/core";

const intent: ExecutionIntent = {
  operationId: "op-1",
  requestId: "req-1",
  idempotencyKey: "idem-1",
  jobId: "job-1",
  attemptId: "attempt-1",
  backend: "slurm",
  state: "intent_persisted",
  requestDigest: `sha256:${"a".repeat(64)}`,
  createdAt: new Date().toISOString(),
};

describe("backend-neutral intent lifecycle", () => {
  test("requires intent before effect and supports ambiguous reconciliation", () => {
    expect(canTransitionExecution("created", "staged")).toBe(false);
    expect(canTransitionExecution("intent_persisted", "submitted")).toBe(true);
    expect(canTransitionExecution("submitted", "ambiguous")).toBe(true);
    const journal = new ExecutionIntentJournal();
    journal.persist(intent);
    journal.transition(intent.operationId, "submitted");
    journal.transition(intent.operationId, "ambiguous");
    expect(journal.get(intent.operationId).intent?.state).toBe("ambiguous");
  });

  test("duplicate intent with same digest is idempotent; conflicting replay is denied", () => {
    const journal = new ExecutionIntentJournal();
    expect(journal.persist(intent)).toEqual(intent);
    expect(journal.persist(intent)).toEqual(intent);
    expect(() => journal.persist({ ...intent, requestDigest: `sha256:${"b".repeat(64)}` })).toThrow(
      /digest conflict/,
    );
  });
});
