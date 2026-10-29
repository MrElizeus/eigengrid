import { describe, expect, test } from "bun:test";
import { digestCanonical } from "@eigengrid/scientific-schema";
import { assembleScientificContext, type ContextAssemblerInput } from "./context-assembler";
import {
  budget,
  makePlan,
  mission,
  skillFragment,
  structureEvidence,
  validationSkillFragment,
} from "./test-fixtures";

function contextInput(overrides: Partial<ContextAssemblerInput> = {}): ContextAssemblerInput {
  return {
    mission,
    plan: makePlan(),
    policyProfile: {
      id: "policy-safe-local",
      databaseUrl: "postgres://operator:super-secret@localhost/eigengrid",
      modelTokens: 20_000,
    },
    budget,
    scope: "installation-local",
    skillFragments: [
      {
        reference: validationSkillFragment,
        content: "Validate normal termination and frequencies.",
      },
      { reference: skillFragment, content: "Optimize with explicit numerical convergence." },
    ],
    evidence: [
      { reference: structureEvidence, summary: "Immutable water XYZ fixture." },
      {
        reference: {
          ...structureEvidence,
          id: "evidence-environment",
          kind: "environment",
          uri: "fixture://environment.json",
          contentDigest: "9".repeat(64),
        },
        summary: "Validated fixture engine environment.",
      },
    ],
    installationKnowledge: [
      {
        id: "installation-valid",
        scope: "installation-local",
        contentDigest: "7".repeat(64),
        content: { enginePath: "/opt/fixture/bin" },
        validated: true,
      },
      {
        id: "installation-unvalidated",
        scope: "installation-local",
        contentDigest: "6".repeat(64),
        content: { claim: "not authoritative" },
        validated: false,
      },
      {
        id: "installation-other-scope",
        scope: "different-host",
        contentDigest: "5".repeat(64),
        content: { claim: "wrong host" },
        validated: true,
      },
    ],
    episodicCandidates: [
      {
        id: "episode-1",
        content: { note: "Bearer abcdefghijklmnop", apiKey: "sk-secretvalue123" },
        confidence: "low",
        evidenceRefs: [],
      },
    ],
    contradictions: [
      { id: "contradiction-1", statement: "Prior run did not converge", evidenceRefs: [] },
    ],
    unresolvedQuestions: [
      { id: "question-1", question: "Is a second conformer material?", evidenceRefs: [] },
    ],
    maximumBytes: 1_000_000,
    ...overrides,
  };
}

describe("authority-ordered context assembler", () => {
  test("rebuilds an identical context and digest after restart or reordered retrieval", () => {
    const original = contextInput();
    const reordered = contextInput({
      skillFragments: [...original.skillFragments].reverse(),
      evidence: [...original.evidence].reverse(),
      installationKnowledge: [...(original.installationKnowledge ?? [])].reverse(),
    });
    const first = assembleScientificContext(original);
    const second = assembleScientificContext(structuredClone(reordered));

    expect(first.status).toBe("assembled");
    expect(second.status).toBe("assembled");
    if (first.status !== "assembled" || second.status !== "assembled") return;
    expect(first.context).toEqual(second.context);
    expect(first.contextDigest).toBe(second.contextDigest);
    expect(first.contextDigest).toBe(digestCanonical(first.context));
    expect(first.context.sections.map((section) => section.authorityRank)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(first.selectedFragmentIds).toEqual([
      "geometry-optimization.protocol",
      "minimum-validation.protocol",
    ]);
    expect(first.selectedEvidenceIds).toEqual(["evidence-environment", "evidence-water-xyz"]);
  });

  test("redacts secret keys and secret-shaped strings before digesting or model use", () => {
    const first = assembleScientificContext(contextInput());
    const second = assembleScientificContext(
      contextInput({
        policyProfile: {
          id: "policy-safe-local",
          databaseUrl: "postgres://different:credential@localhost/eigengrid",
          modelTokens: 20_000,
        },
        episodicCandidates: [
          {
            id: "episode-1",
            content: { note: "Bearer completelyDifferentToken", apiKey: "sk-anotherSecret999" },
            confidence: "low",
            evidenceRefs: [],
          },
        ],
      }),
    );
    expect(first.status).toBe("assembled");
    expect(second.status).toBe("assembled");
    if (first.status !== "assembled" || second.status !== "assembled") return;
    const serialized = JSON.stringify(first.context);
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("abcdefghijklmnop");
    expect(serialized).not.toContain("sk-secretvalue123");
    expect(serialized).toContain("[REDACTED]");
    expect(first.redactions.length).toBeGreaterThanOrEqual(3);
    expect(first.redactions.every((entry) => !JSON.stringify(entry).includes("secretvalue"))).toBe(
      true,
    );
    expect(first.contextDigest).toBe(second.contextDigest);
  });

  test("excludes unvalidated and wrong-scope installation knowledge", () => {
    const result = assembleScientificContext(contextInput());
    expect(result.status).toBe("assembled");
    if (result.status !== "assembled") return;
    const serialized = JSON.stringify(result.context);
    expect(serialized).toContain("installation-valid");
    expect(serialized).not.toContain("installation-unvalidated");
    expect(serialized).not.toContain("installation-other-scope");
    expect(result.omissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ itemId: "installation-unvalidated", reason: "unvalidated" }),
        expect.objectContaining({ itemId: "installation-other-scope", reason: "scope_mismatch" }),
      ]),
    );
  });

  test("reports deterministic optional omissions without dropping mandatory authority", () => {
    const mandatory = assembleScientificContext(
      contextInput({
        skillFragments: [],
        evidence: [],
        installationKnowledge: [],
        episodicCandidates: [],
        contradictions: [],
        unresolvedQuestions: [],
      }),
    );
    expect(mandatory.status).toBe("assembled");
    if (mandatory.status !== "assembled") return;

    const constrained = assembleScientificContext(
      contextInput({
        skillFragments: [{ reference: skillFragment, content: "large".repeat(5_000) }],
        evidence: [],
        installationKnowledge: [],
        episodicCandidates: [],
        contradictions: [],
        unresolvedQuestions: [],
        maximumBytes: mandatory.accounting.usedBytes + 100,
      }),
    );
    expect(constrained.status).toBe("assembled");
    if (constrained.status !== "assembled") return;
    expect(constrained.context.sections.slice(0, 3).map((section) => section.kind)).toEqual([
      "objective_and_mission",
      "plan_and_work_unit",
      "policy_and_budget",
    ]);
    expect(constrained.selectedFragmentIds).toEqual([]);
    expect(constrained.omissions).toContainEqual(
      expect.objectContaining({
        section: "skill_fragments",
        itemId: skillFragment.fragmentId,
        reason: "budget",
      }),
    );
  });

  test("fails explicitly rather than truncating authoritative mission state", () => {
    const result = assembleScientificContext(contextInput({ maximumBytes: 64 }));
    expect(result).toEqual(
      expect.objectContaining({
        status: "insufficient_budget",
        code: "MANDATORY_CONTEXT_EXCEEDS_BUDGET",
        maximumBytes: 64,
      }),
    );
  });
});
