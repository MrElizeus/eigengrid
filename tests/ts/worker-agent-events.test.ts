import { describe, expect, test } from "bun:test";
import {
  makeRecoveryStartedEvent,
  makeRecoveryCompletedEvent,
  makeRecoveryFailedEvent,
  makeDecisionEvaluatedEvent,
  makeDecisionSkippedEvent,
  makeDecisionBlockedEvent,
} from "@eigengrid/worker-agent";

describe("worker agent events", () => {
  test("recovery started event has correct type", () => {
    const event = makeRecoveryStartedEvent("node-01", {
      jobId: "job-001",
      decision: "retry-artifact-sync",
      reason: "missing artifacts",
    });

    expect(event.type).toBe("worker.recovery.started");
    expect(event.source).toBe("system");
    expect(event.jobId).toBe("job-001");
    expect((event.payload as any)?.nodeId).toBe("node-01");
    expect((event.payload as any)?.mode).toBe("recover-only");
    expect((event.payload as any)?.decision).toBe("retry-artifact-sync");
  });

  test("recovery completed event has correct type", () => {
    const event = makeRecoveryCompletedEvent("node-01", {
      jobId: "job-001",
      decision: "retry-artifact-sync",
      reason: "sync completed",
    });

    expect(event.type).toBe("worker.recovery.completed");
    expect(event.jobId).toBe("job-001");
  });

  test("recovery failed event has correct type", () => {
    const event = makeRecoveryFailedEvent("node-01", {
      jobId: "job-001",
      decision: "reattach-pid",
      reason: "PID not alive",
      error: "Process exited before reattach",
    });

    expect(event.type).toBe("worker.recovery.failed");
    expect(event.jobId).toBe("job-001");
    expect((event.payload as any)?.error).toBe("Process exited before reattach");
  });

  test("decision evaluated event has correct type and payload", () => {
    const event = makeDecisionEvaluatedEvent("node-01", {
      jobId: "job-001",
      decision: "mark-draining",
      reason: "low disk space",
      confidence: "high",
      allowedByPolicy: true,
    });

    expect(event.type).toBe("agent.decision.evaluated");
    expect(event.source).toBe("system");
    expect((event.payload as any)?.nodeId).toBe("node-01");
    expect((event.payload as any)?.mode).toBe("recover-only");
    expect((event.payload as any)?.decision).toBe("mark-draining");
    expect((event.payload as any)?.confidence).toBe("high");
    expect((event.payload as any)?.allowedByPolicy).toBe(true);
  });

  test("decision skipped event has correct type", () => {
    const event = makeDecisionSkippedEvent("node-01", {
      jobId: "job-001",
      decision: "retry-same-command-once",
      reason: "blocked by policy: allowSameCommandRetry is false",
    });

    expect(event.type).toBe("agent.decision.skipped");
    expect((event.payload as any)?.decision).toBe("retry-same-command-once");
    expect((event.payload as any)?.reason).toContain("blocked by policy");
  });

  test("decision blocked event has correct type", () => {
    const event = makeDecisionBlockedEvent("node-01", {
      jobId: "job-001",
      decision: "reattach-pid",
      reason: "PID reattach requires head approval",
      blockReason: "requires head approval",
    });

    expect(event.type).toBe("agent.decision.blocked");
    expect((event.payload as any)?.blockReason).toBe("requires head approval");
  });

  test("all events have id, at, and source fields", () => {
    const events = [
      makeRecoveryStartedEvent("node-01"),
      makeRecoveryCompletedEvent("node-01"),
      makeRecoveryFailedEvent("node-01"),
      makeDecisionEvaluatedEvent("node-01"),
      makeDecisionSkippedEvent("node-01"),
      makeDecisionBlockedEvent("node-01"),
    ];

    for (const event of events) {
      expect(event.id).toBeTruthy();
      expect(typeof event.at).toBe("number");
      expect(event.source).toBe("system");
    }
  });
});
