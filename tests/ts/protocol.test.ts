import { describe, it, expect } from "bun:test";
import {
  ArtifactSchema,
  JobAttemptSchema,
  JobStatusSchema,
  PythonParseResponseSchema,
  SoftwareSchema,
  createEmptyParseResultData,
} from "@eigengrid/protocol";

describe("Protocol schemas", () => {
  it("accepts the canonical job status vocabulary", () => {
    expect(JobStatusSchema.parse("completed")).toBe("completed");
    expect(JobStatusSchema.parse("parsed")).toBe("parsed");
    expect(JobStatusSchema.safeParse("finished").success).toBe(false);
  });

  it("recognizes AMBER as an engine without adding it to the QC parser contract", () => {
    expect(SoftwareSchema.parse("amber")).toBe("amber");
    expect(
      PythonParseResponseSchema.safeParse({ ok: true, parser: "amber", status: "completed" })
        .success,
    ).toBe(false);
  });

  it("validates successful Python parse response", () => {
    const input = {
      ok: true as const,
      parser: "gaussian",
      status: "completed" as const,
      data: {
        ...createEmptyParseResultData(),
        normal_termination: true,
        energy_hartree: -1156.78,
      },
    };
    const result = PythonParseResponseSchema.parse(input);
    expect(result.ok).toBe(true);
    expect(result.parser).toBe("gaussian");
  });

  it("validates error Python parse response", () => {
    const input = {
      ok: false as const,
      parser: "gaussian",
      status: "failed" as const,
      error: { code: "PARSE_ERROR", message: "Could not find SCF energy" },
    };
    const result = PythonParseResponseSchema.parse(input);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("PARSE_ERROR");
  });

  it("validates a job attempt payload", () => {
    const result = JobAttemptSchema.parse({
      id: "attempt-1",
      jobId: "job-1",
      runner: "local",
      status: "created",
      command: "g16 water.in",
      cwd: "/tmp/eigengrid",
      createdAt: 1,
      updatedAt: 1,
    });

    expect(result.status).toBe("created");
    expect(result.runner).toBe("local");
  });

  it("validates an artifact payload", () => {
    const result = ArtifactSchema.parse({
      id: "artifact-1",
      jobId: "job-1",
      attemptId: "attempt-1",
      kind: "input",
      path: "water.in",
      createdAt: 1,
    });

    expect(result.kind).toBe("input");
    expect(result.attemptId).toBe("attempt-1");
  });
});
