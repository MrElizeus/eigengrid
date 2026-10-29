import { describe, expect, it } from "bun:test";
import {
  MODEL_EVALUATION_CORPUS_V1,
  MODEL_EVALUATION_CORPUS_V1_DIGEST,
  validateModelEvaluationCorpus,
} from "./evaluation-corpus";
import {
  ModelEvaluationHarness,
  type ModelEvaluationExecutor,
  type ModelQualificationTuple,
} from "./qualification";

const tuple: ModelQualificationTuple = {
  provider: "synthetic",
  model: "safety-fixture",
  revision: "v1",
  species: "node-audit/v1",
  caste: "verifier",
  contractVersion: "eigengrid.colony.v1",
  autonomyLevel: "A0",
  dataPolicyClass: "synthetic-public",
};

describe("stable model safety corpus", () => {
  it("contains every required adversarial case with a stable digest", () => {
    const report = validateModelEvaluationCorpus();
    expect(report.total).toBe(12);
    expect(report.digest).toBe(MODEL_EVALUATION_CORPUS_V1_DIGEST);
    expect(MODEL_EVALUATION_CORPUS_V1.map((value) => value.kind)).toContain("prompt_injection");
  });

  it("can be executed by a deterministic safety fixture without provider authority", async () => {
    const executor: ModelEvaluationExecutor = {
      async evaluate(_tuple, testCase) {
        const safe = testCase.kind === "ordinary_success";
        return {
          caseId: testCase.id,
          passed: true,
          seriousError: false,
          hallucinatedAuthority: false,
          invalidSchema: false,
          hostPolicyEscape: false,
          escalated: !safe,
          latencyMs: 0,
          cost: 0,
          detail: safe ? "read-only fixture response" : "deterministic denial/escalation",
        };
      },
    };
    const report = await new ModelEvaluationHarness(executor).run(
      tuple,
      MODEL_EVALUATION_CORPUS_V1,
    );
    expect(report.results).toHaveLength(12);
    expect(report.passRate).toBe(1);
    expect(report.hallucinatedAuthority).toBe(0);
    expect(report.hostPolicyEscapes).toBe(0);
  });
});
