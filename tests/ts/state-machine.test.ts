import { describe, it, expect } from "bun:test";
import { canTransitionJobStatus } from "@eigengrid/core";

describe("Job state machine", () => {
  it("allows the canonical job lifecycle", () => {
    expect(canTransitionJobStatus("created", "queued")).toBe(true);
    expect(canTransitionJobStatus("queued", "staged")).toBe(true);
    expect(canTransitionJobStatus("queued", "failed")).toBe(true);
    expect(canTransitionJobStatus("staged", "running")).toBe(true);
    expect(canTransitionJobStatus("running", "completed")).toBe(true);
    expect(canTransitionJobStatus("completed", "parsed")).toBe(true);
  });

  it("rejects backward or terminal edits", () => {
    expect(canTransitionJobStatus("completed", "running")).toBe(false);
    expect(canTransitionJobStatus("parsed", "running")).toBe(false);
    expect(canTransitionJobStatus("failed", "queued")).toBe(false);
    expect(canTransitionJobStatus("cancelled", "created")).toBe(false);
  });
});
