import { describe, expect, test } from "bun:test";
import { computeSkillGraphDigest } from "@eigengrid/mission-runtime";
import {
  ScientificSkillRegistry,
  computeResolvedScientificSkillGraphDigest,
  graphWithSelectedFragments,
  loadScientificSkillCorpus,
  repositoryScientificSkillsRoot,
  resolveScientificSkillGraph,
  selectProgressiveSkillContext,
} from "@eigengrid/scientific-skills";

describe("resolved scientific skill graph digest contract", () => {
  test("repository fragments and durable persistence use the same authoritative digest", () => {
    const registry = new ScientificSkillRegistry(
      loadScientificSkillCorpus(repositoryScientificSkillsRoot()),
    );
    const resolved = resolveScientificSkillGraph(registry, {
      requested: [
        "workflows.geometry-optimization",
        "workflows.frequencies-and-thermochemistry",
        "validation.minimum-validation",
      ],
      missionId: "mission-digest-contract",
      engine: { id: "orca", version: "6.0.0" },
      domains: ["molecular-electronic-structure"],
      // The repository corpus is explicitly model-authored and unreviewed.
      // Digest integration must not promote that evidence to reference_curated
      // merely to make the release fixture resolvable.
      minimumKnowledgeMaturity: "draft",
      requiredCapability: "plannable",
      resolvedAt: "2026-08-06T12:00:00.000Z",
    });
    const context = selectProgressiveSkillContext(resolved, {
      query: "molecular geometry optimization frequencies minimum validation convergence",
      reason: "compile the exact molecular minimum protocol",
      assetKinds: ["summary", "protocols", "decision_rules", "validation"],
      maxFragments: 24,
      maxCharacters: 24_000,
    });
    const attributed = graphWithSelectedFragments(resolved.graph, context);

    expect(attributed.selectedFragments.length).toBeGreaterThan(0);
    expect(attributed.graphDigest).toBe(computeResolvedScientificSkillGraphDigest(attributed));
    expect(attributed.graphDigest).toBe(computeSkillGraphDigest(attributed));

    const [first, ...remaining] = attributed.selectedFragments;
    if (!first) throw new Error("Expected at least one selected skill fragment");
    const substituted = {
      ...attributed,
      selectedFragments: [{ ...first, fragmentDigest: "0".repeat(64) }, ...remaining],
    };
    expect(computeResolvedScientificSkillGraphDigest(substituted)).not.toBe(attributed.graphDigest);
  });
});
