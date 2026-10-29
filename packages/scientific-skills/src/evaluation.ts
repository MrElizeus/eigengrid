import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { digestBytes } from "@eigengrid/scientific-schema";
import {
  CompositionEvaluationCaseSchema,
  TriggerEvaluationCaseSchema,
  type CompositionEvaluationCase,
  type TriggerEvaluationCase,
} from "./schema";
import { resolveScientificSkillGraph } from "./resolver";
import { loadScientificSkillFragments } from "./fragments";
import type { ScientificSkillRegistry } from "./registry";
import { searchScientificSkills } from "./search";
import type { SkillEvaluationCaseResult, SkillEvaluationReport } from "./types";

function jsonLines(path: string): unknown[] {
  return readFileSync(path, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(
          `Invalid JSONL at ${path}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
}

function runTriggerCase(
  registry: ScientificSkillRegistry,
  evaluation: TriggerEvaluationCase,
  source: string,
): SkillEvaluationCaseResult {
  const result = searchScientificSkills(registry, evaluation.query, { limit: 8 });
  const ids = result.hits.map((hit) => hit.skill.skillId);
  const included = evaluation.expected_included.every((id) => ids.includes(id));
  const excluded = evaluation.expected_excluded.every((id) => !ids.slice(0, 3).includes(id));
  const top =
    evaluation.expected_top === undefined
      ? true
      : evaluation.expected_top === null
        ? result.ambiguous
        : ids[0] === evaluation.expected_top;
  let progressiveAsset = true;
  if (
    evaluation.kind === "planning" ||
    evaluation.kind === "rendering" ||
    evaluation.kind === "diagnostic"
  ) {
    const assetKind =
      evaluation.kind === "planning"
        ? "protocols"
        : evaluation.kind === "rendering"
          ? "engine_mappings"
          : "diagnostics";
    progressiveAsset = evaluation.expected_included.every((id) => {
      const skill = registry.versions(id)[0];
      if (!skill) return false;
      const fragments = loadScientificSkillFragments(skill, { assetKinds: [assetKind] });
      return (
        fragments.length > 0 &&
        fragments.every(
          (fragment) => fragment.reference.fragmentDigest === digestBytes(fragment.content),
        )
      );
    });
  }
  const passed = included && excluded && top && progressiveAsset;
  return {
    id: evaluation.id,
    kind: evaluation.kind,
    source,
    passed,
    details: passed
      ? `matched ${ids.slice(0, 3).join(", ") || "no skills"}`
      : `expected included=${evaluation.expected_included.join(",")}; excluded=${evaluation.expected_excluded.join(",")}; top=${String(evaluation.expected_top)}; got=${ids.slice(0, 8).join(",")}; ambiguous=${result.ambiguous}; progressiveAsset=${progressiveAsset}`,
  };
}

function runCompositionCase(
  registry: ScientificSkillRegistry,
  evaluation: CompositionEvaluationCase,
  source: string,
): SkillEvaluationCaseResult {
  try {
    const result = resolveScientificSkillGraph(registry, {
      requested: evaluation.requested,
      includeOptional: evaluation.include_optional,
      engine: evaluation.engine,
      domains: evaluation.domains,
      resolvedAt: "1970-01-01T00:00:00.000Z",
    });
    const ids = result.graph.nodes.map((node) => node.skillId);
    const passed =
      evaluation.expected_nodes.every((id) => ids.includes(id)) &&
      evaluation.expected_absent.every((id) => !ids.includes(id));
    return {
      id: evaluation.id,
      kind: "composition",
      source,
      passed,
      details: passed
        ? `resolved ${ids.join(", ")}`
        : `expected nodes=${evaluation.expected_nodes.join(",")}; absent=${evaluation.expected_absent.join(",")}; got=${ids.join(",")}`,
    };
  } catch (error) {
    return {
      id: evaluation.id,
      kind: "composition",
      source,
      passed: false,
      details: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Run repository trigger, negative-trigger, planning, rendering, diagnostic, and composition cases. */
export function runScientificSkillEvaluations(
  registry: ScientificSkillRegistry,
): SkillEvaluationReport {
  const cases: SkillEvaluationCaseResult[] = [];
  for (const skill of registry.all()) {
    const evalDirectory = join(skill.directory, "evals");
    if (!existsSync(evalDirectory)) continue;
    for (const name of readdirSync(evalDirectory).sort()) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(evalDirectory, name);
      const source = `${skill.manifest.id}/evals/${name}`;
      for (const raw of jsonLines(path)) {
        if (name.includes("composition")) {
          cases.push(
            runCompositionCase(registry, CompositionEvaluationCaseSchema.parse(raw), source),
          );
        } else {
          cases.push(runTriggerCase(registry, TriggerEvaluationCaseSchema.parse(raw), source));
        }
      }
    }
  }
  cases.sort((left, right) =>
    `${left.source}\0${left.id}`.localeCompare(`${right.source}\0${right.id}`),
  );
  const passed = cases.filter((item) => item.passed).length;
  return {
    schemaVersion: "eigengrid.scientific-skill-eval-report/v1",
    corpusDigest: registry.corpusDigest,
    total: cases.length,
    passed,
    failed: cases.length - passed,
    cases,
  };
}
