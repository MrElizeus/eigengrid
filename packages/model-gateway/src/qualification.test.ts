import { afterEach, describe, expect, test } from "bun:test";
import { digestCanonical } from "@eigengrid/scientific-schema";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  DurableModelQualificationJournal,
  DurableModelQualificationRegistry,
  ModelEvaluationHarness,
  ModelQualificationEvidenceError,
  ModelQualificationRegistry,
  ModelQualificationTransitionError,
  QualifiedModelRouter,
  compareModelEvaluationEvidence,
  createModelEvaluationEvidence,
  createModelOperationalEvidence,
  createModelPromotionDecision,
  type ModelEvaluationCase,
  type ModelEvaluationEvidence,
  type ModelEvaluationReport,
  type ModelEvaluationSuite,
  type ModelEvidenceActor,
  type ModelQualificationStatus,
  type ModelQualificationTuple,
} from "./qualification";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const NOW = "2026-08-30T12:00:00.000Z";
const LATER = "2026-08-30T12:01:00.000Z";

const baselineTuple: ModelQualificationTuple = {
  provider: "fixture",
  model: "small-model",
  revision: "2026-08-01",
  species: "scientific-plan/v1",
  caste: "planner",
  contractVersion: "eigengrid.agent.v1",
  autonomyLevel: "A1",
  dataPolicyClass: "synthetic",
};

const candidateTuple: ModelQualificationTuple = {
  ...baselineTuple,
  revision: "2026-08-30",
};

const referenceTuple: ModelQualificationTuple = {
  ...baselineTuple,
  revision: "2026-07-01",
};

const cases: ModelEvaluationCase[] = [
  { id: "success", kind: "ordinary_success", input: {}, expected: {} },
  { id: "injection", kind: "prompt_injection", input: {}, expected: { deny: true } },
];

function digest(label: string): `sha256:${string}` {
  return `sha256:${digestCanonical(label)}`;
}

function actor(principalId: string, role: ModelEvidenceActor["role"]): ModelEvidenceActor {
  return { principalId, role, attestationDigest: digest(`${principalId}:${role}`) };
}

function registry(): ModelQualificationRegistry {
  let id = 0;
  return new ModelQualificationRegistry({
    now: () => new Date(NOW),
    idFactory: () => `qualification-${++id}`,
  });
}

async function report(
  tuple: ModelQualificationTuple,
  overrides: {
    failCase?: string;
    seriousError?: boolean;
    hallucinatedAuthority?: boolean;
    invalidSchema?: boolean;
    hostPolicyEscape?: boolean;
    latencyMs?: number;
    cost?: number;
  } = {},
): Promise<ModelEvaluationReport> {
  return new ModelEvaluationHarness({
    evaluate: async (_tuple, testCase) => {
      const failed = testCase.id === overrides.failCase;
      return {
        caseId: testCase.id,
        passed: !failed,
        seriousError: failed && (overrides.seriousError ?? false),
        hallucinatedAuthority: failed && (overrides.hallucinatedAuthority ?? false),
        invalidSchema: failed && (overrides.invalidSchema ?? false),
        hostPolicyEscape: failed && (overrides.hostPolicyEscape ?? false),
        escalated: testCase.kind === "prompt_injection",
        latencyMs: overrides.latencyMs ?? 10,
        cost: overrides.cost ?? 0.001,
        detail: failed ? "bounded failure fixture" : "bounded success fixture",
      };
    },
  }).run(tuple, cases);
}

async function evidence(
  tuple: ModelQualificationTuple,
  options: {
    evidenceId?: string;
    evaluatorId?: string;
    datasetClasses?: ModelEvaluationSuite["datasetClasses"];
    tier?: ModelEvaluationSuite["tier"];
    reportOverrides?: Parameters<typeof report>[1];
    artifact?: string;
  } = {},
): Promise<ModelEvaluationEvidence> {
  const evaluationReport = await report(tuple, options.reportOverrides);
  return createModelEvaluationEvidence({
    evidenceId: options.evidenceId,
    report: evaluationReport,
    suite: {
      suiteId: "model-safety-v1",
      version: "1.0.0",
      tier: options.tier ?? "T2",
      datasetClasses: options.datasetClasses ?? ["sealed_regression", "adversarial"],
      corpusDigest: evaluationReport.corpusDigest,
      caseCount: evaluationReport.caseCount,
    },
    evaluator: actor(options.evaluatorId ?? "eval-runner", "evaluation_runner"),
    environmentDigest: digest("environment"),
    artifactDigests: [digest(options.artifact ?? "evaluation-artifact")],
    evaluatedAt: NOW,
  });
}

function promotion(
  value: ModelEvaluationEvidence,
  fromStatus: ModelQualificationStatus,
  toStatus: "shadow" | "canary" | "qualified" | "preferred",
  options: {
    decisionId?: string;
    reviewerId?: string;
    comparisonEvidenceDigest?: string;
    at?: string;
  } = {},
) {
  return createModelPromotionDecision({
    decisionId: options.decisionId ?? `decision:${value.tuple.revision}:${fromStatus}:${toStatus}`,
    tuple: value.tuple,
    fromStatus,
    toStatus,
    evaluationEvidenceDigest: value.evidenceDigest,
    comparisonEvidenceDigest: options.comparisonEvidenceDigest,
    reviewer: actor(options.reviewerId ?? "promotion-reviewer", "independent_reviewer"),
    decidedAt: options.at ?? LATER,
    rationale: `independently reviewed ${fromStatus} -> ${toStatus}`,
  });
}

function promoteToQualified(
  qualificationRegistry: ModelQualificationRegistry,
  value: ModelEvaluationEvidence,
): void {
  qualificationRegistry.promote(promotion(value, "unqualified", "shadow"));
  qualificationRegistry.promote(promotion(value, "shadow", "canary"));
  qualificationRegistry.promote(promotion(value, "canary", "qualified"));
}

const budget = {
  maximumCalls: 1,
  maximumInputTokens: 100,
  maximumOutputTokens: 100,
  maximumTotalTokens: 200,
  maximumCost: 1,
};

describe("evidence-backed model qualification", () => {
  test("raw reports and self-review cannot qualify a tuple", async () => {
    const evaluationReport = await report(candidateTuple);
    const qualificationRegistry = registry();
    expect(() => qualificationRegistry.register(evaluationReport)).toThrow(
      ModelQualificationEvidenceError,
    );

    const value = await evidence(candidateTuple);
    expect(qualificationRegistry.recordEvaluation(value).status).toBe("unqualified");
    expect(() =>
      new QualifiedModelRouter(qualificationRegistry).route(candidateTuple, budget),
    ).toThrow(/not qualified/);

    expect(() =>
      qualificationRegistry.promote(
        promotion(value, "unqualified", "shadow", { reviewerId: "eval-runner" }),
      ),
    ).toThrow(/independent of evaluator/);
  });

  test("admits shadow and canary explicitly before normal qualified routing", async () => {
    const value = await evidence(candidateTuple);
    const qualificationRegistry = registry();
    qualificationRegistry.recordEvaluation(value);
    expect(qualificationRegistry.promote(promotion(value, "unqualified", "shadow")).status).toBe(
      "shadow",
    );

    const router = new QualifiedModelRouter(qualificationRegistry);
    expect(() => router.route(candidateTuple, budget)).toThrow(/not qualified/);
    expect(() => router.routeCanary(candidateTuple, budget)).toThrow(/not admitted/);

    expect(qualificationRegistry.promote(promotion(value, "shadow", "canary")).status).toBe(
      "canary",
    );
    expect(router.routeCanary(candidateTuple, budget).qualification.status).toBe("canary");
    expect(() => router.route(candidateTuple, budget)).toThrow(/not qualified/);

    expect(qualificationRegistry.promote(promotion(value, "canary", "qualified")).status).toBe(
      "qualified",
    );
    expect(router.route(candidateTuple, budget).qualification.status).toBe("qualified");
    expect(qualificationRegistry.history(candidateTuple).map((item) => item.toStatus)).toEqual([
      "unqualified",
      "shadow",
      "canary",
      "qualified",
    ]);
  });

  test("requires sealed and adversarial evidence, plus protected evidence for T3/T4", async () => {
    const openOnly = await evidence(candidateTuple, { datasetClasses: ["development"] });
    const openRegistry = registry();
    openRegistry.recordEvaluation(openOnly);
    openRegistry.promote(promotion(openOnly, "unqualified", "shadow"));
    expect(() => openRegistry.promote(promotion(openOnly, "shadow", "canary"))).toThrow(
      /sealed_regression/,
    );

    const specialist = await evidence(candidateTuple, { tier: "T3" });
    const specialistRegistry = registry();
    specialistRegistry.recordEvaluation(specialist);
    specialistRegistry.promote(promotion(specialist, "unqualified", "shadow"));
    specialistRegistry.promote(promotion(specialist, "shadow", "canary"));
    expect(() => specialistRegistry.promote(promotion(specialist, "canary", "qualified"))).toThrow(
      /protected_scientific/,
    );
  });

  test("rejects mismatched case ids, tampered evidence, and duplicate evidence ids", async () => {
    await expect(
      new ModelEvaluationHarness({
        evaluate: async () => ({
          caseId: "wrong-case",
          passed: true,
          seriousError: false,
          hallucinatedAuthority: false,
          invalidSchema: false,
          hostPolicyEscape: false,
          escalated: false,
          latencyMs: 1,
          cost: 0,
          detail: "mismatch",
        }),
      }).run(candidateTuple, cases),
    ).rejects.toThrow(/does not match case/);

    const value = await evidence(candidateTuple, { evidenceId: "evidence-1" });
    const qualificationRegistry = registry();
    expect(() => qualificationRegistry.recordEvaluation({ ...value, evaluatedAt: LATER })).toThrow(
      /digest mismatch/,
    );
    qualificationRegistry.recordEvaluation(value);
    const conflicting = await evidence(candidateTuple, {
      evidenceId: "evidence-1",
      artifact: "different-artifact",
    });
    expect(() => qualificationRegistry.recordEvaluation(conflicting)).toThrow(
      /id reused with new bytes/,
    );
  });

  test("quarantines host-policy escape evidence with no route", async () => {
    const unsafe = await evidence(candidateTuple, {
      reportOverrides: { failCase: "injection", hostPolicyEscape: true },
    });
    const qualificationRegistry = registry();
    const record = qualificationRegistry.recordEvaluation(unsafe);
    expect(record.status).toBe("quarantined");
    expect(record.hostPolicyEscapes).toBe(1);
    expect(qualificationRegistry.history(candidateTuple).at(-1)?.reason).toBe(
      "automatic_quarantine",
    );
    expect(() =>
      new QualifiedModelRouter(qualificationRegistry).route(candidateTuple, budget),
    ).toThrow(/not qualified/);
  });

  test("automatically degrades then quarantines on independent operational evidence", async () => {
    const value = await evidence(candidateTuple);
    const qualificationRegistry = registry();
    qualificationRegistry.recordEvaluation(value);
    promoteToQualified(qualificationRegistry, value);

    expect(() =>
      qualificationRegistry.recordOperationalEvidence(
        createModelOperationalEvidence({
          evidenceId: "non-independent-monitor",
          tuple: candidateTuple,
          kind: "contract_failure",
          occurrences: 1,
          traceDigests: [digest("same-principal-trace")],
          monitor: actor("eval-runner", "runtime_monitor"),
          observedAt: LATER,
          detail: "must not self-monitor",
        }),
      ),
    ).toThrow(/independent of evaluation runner/);

    const first = createModelOperationalEvidence({
      evidenceId: "contract-failure-1",
      tuple: candidateTuple,
      kind: "contract_failure",
      occurrences: 3,
      errorRate: 0.2,
      traceDigests: [digest("trace-1")],
      monitor: actor("runtime-monitor", "runtime_monitor"),
      observedAt: LATER,
      detail: "three schema contract failures",
    });
    expect(qualificationRegistry.recordOperationalEvidence(first).status).toBe("degraded");
    expect(() =>
      new QualifiedModelRouter(qualificationRegistry).route(candidateTuple, budget),
    ).toThrow(/not qualified/);

    const second = createModelOperationalEvidence({
      evidenceId: "contract-failure-2",
      tuple: candidateTuple,
      kind: "contract_failure",
      occurrences: 1,
      errorRate: 0.1,
      traceDigests: [digest("trace-2")],
      monitor: actor("runtime-monitor", "runtime_monitor"),
      observedAt: "2026-08-30T12:02:00.000Z",
      detail: "failure repeated after degradation",
    });
    expect(qualificationRegistry.recordOperationalEvidence(second).status).toBe("quarantined");
    expect(
      qualificationRegistry
        .history(candidateTuple)
        .slice(-2)
        .map((item) => item.reason),
    ).toEqual(["automatic_demotion", "automatic_quarantine"]);
  });

  test("requires reproducible old/new comparison before preferred promotion", async () => {
    const reference = await evidence(referenceTuple, {
      evidenceId: "reference-eval",
      evaluatorId: "reference-runner",
    });
    const baseline = await evidence(baselineTuple, {
      evidenceId: "baseline-eval",
      evaluatorId: "baseline-runner",
    });
    const candidate = await evidence(candidateTuple, {
      evidenceId: "candidate-eval",
      evaluatorId: "candidate-runner",
    });
    const qualificationRegistry = registry();
    qualificationRegistry.recordEvaluation(reference);
    qualificationRegistry.recordEvaluation(baseline);
    qualificationRegistry.recordEvaluation(candidate);
    promoteToQualified(qualificationRegistry, reference);
    promoteToQualified(qualificationRegistry, baseline);
    promoteToQualified(qualificationRegistry, candidate);

    const baselineComparison = compareModelEvaluationEvidence({
      comparisonId: "old-new-baseline",
      baseline: reference,
      candidate: baseline,
      comparator: actor("baseline-comparison-reviewer", "independent_reviewer"),
      comparedAt: LATER,
    });
    qualificationRegistry.recordComparison(baselineComparison);
    expect(
      qualificationRegistry.promote(
        promotion(baseline, "qualified", "preferred", {
          reviewerId: "baseline-promotion-owner",
          comparisonEvidenceDigest: baselineComparison.comparisonDigest,
        }),
      ).status,
    ).toBe("preferred");

    expect(() =>
      qualificationRegistry.promote(promotion(candidate, "qualified", "preferred")),
    ).toThrow(/old\/new comparison/);

    const comparison = compareModelEvaluationEvidence({
      comparisonId: "old-new-1",
      baseline,
      candidate,
      comparator: actor("comparison-reviewer", "independent_reviewer"),
      comparedAt: LATER,
    });
    expect(comparison.verdict).toBe("non_regressive");
    qualificationRegistry.recordComparison(comparison);
    const preferred = qualificationRegistry.promote(
      promotion(candidate, "qualified", "preferred", {
        reviewerId: "promotion-owner",
        comparisonEvidenceDigest: comparison.comparisonDigest,
      }),
    );
    expect(preferred.status).toBe("preferred");
    expect(preferred.decisionDigest).toBeDefined();
    expect(qualificationRegistry.promotionDecision(preferred.decisionDigest!)).toBeDefined();
    expect(qualificationRegistry.get(baselineTuple)?.status).toBe("qualified");
    expect(qualificationRegistry.history(baselineTuple).at(-1)?.reason).toBe(
      "preferred_superseded",
    );
    expect(qualificationRegistry.comparisonEvidence(comparison.comparisonDigest)).toEqual(
      comparison,
    );
  });

  test("a cheaper candidate cannot conceal a safety or quality regression", async () => {
    const baseline = await evidence(baselineTuple, {
      evaluatorId: "baseline-runner",
      reportOverrides: { cost: 0.1 },
    });
    const candidate = await evidence(candidateTuple, {
      evaluatorId: "candidate-runner",
      reportOverrides: { failCase: "injection", seriousError: true, cost: 0.0001 },
    });
    const comparison = compareModelEvaluationEvidence({
      baseline,
      candidate,
      comparator: actor("comparison-reviewer", "independent_reviewer"),
      comparedAt: LATER,
      tolerance: { minimumPassRateDelta: -0.1 },
    });
    expect(comparison.verdict).toBe("regressed");
    expect(comparison.reasons).toContain("pass-rate regression");
    expect(comparison.reasons).toContain("serious-error regression");
    expect(comparison.deltas.costRatio).toBeLessThan(1);
  });

  test("rejects stale or skipped lifecycle transitions and invalid reservations", async () => {
    const value = await evidence(candidateTuple);
    const qualificationRegistry = registry();
    qualificationRegistry.recordEvaluation(value);
    expect(() =>
      qualificationRegistry.promote(promotion(value, "unqualified", "qualified")),
    ).toThrow(ModelQualificationTransitionError);
    const shadowDecision = promotion(value, "unqualified", "shadow");
    const shadow = qualificationRegistry.promote(shadowDecision);
    expect(qualificationRegistry.promote(shadowDecision)).toEqual(shadow);
    expect(() =>
      qualificationRegistry.promote(
        promotion(value, "unqualified", "shadow", { decisionId: "stale-shadow-decision" }),
      ),
    ).toThrow(/stale/);

    qualificationRegistry.promote(promotion(value, "shadow", "canary"));

    const router = new QualifiedModelRouter(qualificationRegistry);
    expect(() =>
      router.routeCanary(candidateTuple, { ...budget, maximumTotalTokens: 199 }),
    ).toThrow(/reservation exceeds/);
  });
  test("persists independently qualified status across restart", async () => {
    const root = mkdtempSync(join("/tmp", "eigengrid-model-qualification-"));
    roots.push(root);
    const journal = new DurableModelQualificationJournal(join(root, "qualification.jsonl"));
    const value = await evidence(candidateTuple);
    const durable = new DurableModelQualificationRegistry(journal, {
      now: () => new Date(NOW),
      idFactory: () => "durable-qualification",
    });
    await durable.recordEvaluation(value);
    await durable.promote(promotion(value, "unqualified", "shadow"));
    await durable.promote(promotion(value, "shadow", "canary"));
    const qualified = await durable.promote(promotion(value, "canary", "qualified"));

    const reopened = new DurableModelQualificationRegistry(journal);
    await reopened.load();
    expect(reopened.resolve(candidateTuple)?.recordDigest).toBe(qualified.recordDigest);
    expect(reopened.all()).toHaveLength(1);
  });
});
