import { describe, it, expect } from "bun:test";
import type { DiagnosisFacts } from "../../apps/cli/src/commands/diagnose";
import { buildInterpretation, buildRecommendations } from "../../apps/cli/src/commands/diagnose";

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

function makeFacts(overrides: Partial<DiagnosisFacts> = {}): DiagnosisFacts {
  return {
    jobId: "test-job-001",
    jobStatus: "failed",
    exitCode: null,
    parserStatus: null,
    parserErrors: [],
    parserWarnings: [],
    energyHartree: null,
    scfConverged: null,
    normalTermination: null,
    imaginaryFrequencies: null,
    hasLogs: true,
    hasArtifacts: true,
    hasResult: false,
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────
// buildInterpretation
// ────────────────────────────────────────────────────────────

describe("buildInterpretation", () => {
  it("returns insufficient evidence when jobStatus is null", () => {
    const facts = makeFacts({ jobStatus: null });
    const result = buildInterpretation(facts);
    expect(result.likelyCause).toBe("insufficient evidence");
    expect(result.confidence).toBe("low");
  });

  it("detects job not yet executed when status is created", () => {
    const facts = makeFacts({ jobStatus: "created" });
    const result = buildInterpretation(facts);
    expect(result.likelyCause).toContain("not yet executed");
    expect(result.confidence).toBe("high");
  });

  it("detects job not yet executed when status is queued", () => {
    const facts = makeFacts({ jobStatus: "queued" });
    const result = buildInterpretation(facts);
    expect(result.likelyCause).toContain("not yet executed");
  });

  it("detects cancelled job", () => {
    const facts = makeFacts({ jobStatus: "cancelled" });
    const result = buildInterpretation(facts);
    expect(result.likelyCause).toContain("cancelled");
    expect(result.confidence).toBe("high");
  });

  it("detects SIGABRT from exit code 134", () => {
    const facts = makeFacts({ exitCode: 134 });
    const result = buildInterpretation(facts);
    expect(result.likelyCause).toContain("SIGABRT");
    expect(result.confidence).toBe("high");
  });

  it("detects SIGSEGV from exit code 139", () => {
    const facts = makeFacts({ exitCode: 139 });
    const result = buildInterpretation(facts);
    expect(result.likelyCause).toContain("segmentation fault");
    expect(result.confidence).toBe("high");
  });

  it("detects OOM from exit code 137", () => {
    const facts = makeFacts({ exitCode: 137 });
    const result = buildInterpretation(facts);
    expect(result.likelyCause).toContain("SIGKILL");
    expect(result.confidence).toBe("high");
  });

  it("handles generic nonzero exit code", () => {
    const facts = makeFacts({ exitCode: 2 });
    const result = buildInterpretation(facts);
    expect(result.likelyCause).toContain("code 2");
    expect(result.confidence).toBe("medium");
  });

  it("handles exit code -1 (signal)", () => {
    const facts = makeFacts({ exitCode: -1 });
    const result = buildInterpretation(facts);
    expect(result.likelyCause).toContain("terminated by signal");
    expect(result.confidence).toBe("medium");
  });

  it("detects parser failure when parser status is failed", () => {
    const facts = makeFacts({
      exitCode: 0,
      hasResult: true,
      parserStatus: "failed",
      parserErrors: ["SCF not converged"],
    });
    const result = buildInterpretation(facts);
    expect(result.likelyCause).toBe("parser reported failure");
    expect(result.confidence).toBe("medium");
  });

  it("detects SCF non-convergence", () => {
    const facts = makeFacts({
      exitCode: 0,
      hasResult: true,
      scfConverged: false,
      parserStatus: "completed",
    });
    const result = buildInterpretation(facts);
    expect(result.likelyCause).toContain("SCF did not converge");
    expect(result.confidence).toBe("high");
  });

  it("detects imaginary frequencies", () => {
    const facts = makeFacts({
      exitCode: 0,
      hasResult: true,
      imaginaryFrequencies: 1,
      parserStatus: "completed",
    });
    const result = buildInterpretation(facts);
    expect(result.likelyCause).toContain("imaginary");
    expect(result.confidence).toBe("high");
  });

  it("detects successful completion", () => {
    const facts = makeFacts({
      jobStatus: "completed",
      exitCode: 0,
      hasResult: true,
      parserStatus: "completed",
      parserErrors: [],
    });
    const result = buildInterpretation(facts);
    expect(result.likelyCause).toBe("no issues detected");
    expect(result.confidence).toBe("high");
  });

  it("detects in-progress job", () => {
    const facts = makeFacts({ jobStatus: "running", exitCode: null });
    const result = buildInterpretation(facts);
    expect(result.likelyCause).toContain("still in progress");
    expect(result.confidence).toBe("high");
  });

  it("returns insufficient evidence for unknown status", () => {
    const facts = makeFacts({
      jobStatus: "weird-status",
      exitCode: null,
      hasLogs: false,
      hasResult: false,
    });
    const result = buildInterpretation(facts);
    expect(result.likelyCause).toBe("insufficient evidence");
    expect(result.confidence).toBe("low");
    expect(result.reasoning).toContain("No logs available");
    expect(result.reasoning).toContain("No parser result saved");
  });
});

// ────────────────────────────────────────────────────────────
// buildRecommendations
// ────────────────────────────────────────────────────────────

describe("buildRecommendations", () => {
  it("returns empty recommendations for missing job", () => {
    const facts = makeFacts({ jobStatus: null });
    expect(buildRecommendations(facts, false)).toHaveLength(0);
  });

  it("recommends no-action for cancelled jobs", () => {
    const facts = makeFacts({ jobStatus: "cancelled" });
    const recs = buildRecommendations(facts, false);
    expect(recs[0].action).toBe("no-action");
    expect(recs[0].requiresApproval).toBe(false);
  });

  it("recommends wait for running jobs", () => {
    const facts = makeFacts({ jobStatus: "running" });
    const recs = buildRecommendations(facts, false);
    expect(recs[0].action).toBe("wait");
  });

  it("recommends wait for queued jobs", () => {
    const facts = makeFacts({ jobStatus: "queued" });
    const recs = buildRecommendations(facts, false);
    expect(recs[0].action).toBe("wait");
  });

  it("recommends wait for staged jobs", () => {
    const facts = makeFacts({ jobStatus: "staged" });
    const recs = buildRecommendations(facts, false);
    expect(recs[0].action).toBe("wait");
  });

  it("recommends no-action for successful completed jobs", () => {
    const facts = makeFacts({
      jobStatus: "completed",
      exitCode: 0,
      parserErrors: [],
      scfConverged: true,
    });
    const recs = buildRecommendations(facts, false);
    expect(recs[0].action).toBe("no-action");
  });

  it("blocks mutations in dry-run mode", () => {
    const facts = makeFacts({
      jobStatus: "failed",
      exitCode: 1,
    });
    const recs = buildRecommendations(facts, true);
    expect(recs[0].action).toBe("blocked-by-dry-run");
    expect(recs[0].requiresApproval).toBe(false);
  });

  it("recommends retry for SCF failure", () => {
    const facts = makeFacts({
      jobStatus: "completed",
      exitCode: 0,
      hasResult: true,
      scfConverged: false,
    });
    const recs = buildRecommendations(facts, false);
    expect(recs.some((r) => r.action === "retry-with-tighter-scf")).toBe(true);
    expect(recs.find((r) => r.action === "retry-with-tighter-scf")?.requiresApproval).toBe(true);
  });

  it("recommends retry-job for nonzero exit code", () => {
    const facts = makeFacts({
      jobStatus: "failed",
      exitCode: 1,
    });
    const recs = buildRecommendations(facts, false);
    expect(recs.some((r) => r.action === "retry-job")).toBe(true);
  });

  it("recommends reparse for parser failure", () => {
    const facts = makeFacts({
      jobStatus: "completed",
      exitCode: 0,
      hasResult: true,
      parserStatus: "failed",
    });
    const recs = buildRecommendations(facts, false);
    expect(recs.some((r) => r.action === "reparse-job")).toBe(true);
  });

  it("adds informational inspect-structure for imaginary frequencies", () => {
    const facts = makeFacts({
      jobStatus: "completed",
      exitCode: 0,
      hasResult: true,
      parserStatus: "completed",
      imaginaryFrequencies: 2,
    });
    const recs = buildRecommendations(facts, false);
    expect(recs.some((r) => r.action === "inspect-structure")).toBe(true);
    const inspect = recs.find((r) => r.action === "inspect-structure");
    expect(inspect?.requiresApproval).toBe(false);
  });

  it("recommends retry-job for generic failed status", () => {
    const facts = makeFacts({
      jobStatus: "failed",
      exitCode: null,
    });
    const recs = buildRecommendations(facts, false);
    expect(recs.some((r) => r.action === "retry-job")).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────
// Output structure: must have 3 sections
// ────────────────────────────────────────────────────────────

describe("Diagnosis output structure", () => {
  it("produces diagnosis with facts, interpretation, and recommendations", () => {
    const facts = makeFacts();
    const interpretation = buildInterpretation(facts);
    const recommendations = buildRecommendations(facts, false);

    expect(facts).toHaveProperty("jobStatus");
    expect(facts).toHaveProperty("exitCode");
    expect(facts).toHaveProperty("parserErrors");
    expect(facts).toHaveProperty("scfConverged");
    expect(facts).toHaveProperty("hasLogs");
    expect(facts).toHaveProperty("hasResult");
    expect(facts.parserErrors).toBeInstanceOf(Array);

    expect(interpretation).toHaveProperty("likelyCause");
    expect(interpretation).toHaveProperty("confidence");
    expect(interpretation).toHaveProperty("reasoning");
    expect(["low", "medium", "high"]).toContain(interpretation.confidence);

    for (const rec of recommendations) {
      expect(rec).toHaveProperty("action");
      expect(rec).toHaveProperty("requiresApproval");
      expect(rec).toHaveProperty("reason");
      expect(rec).toHaveProperty("proposedChanges");
    }
  });
});
