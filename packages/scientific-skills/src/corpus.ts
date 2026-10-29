import { resolve } from "node:path";
import {
  ScientificSkillValidationError,
  findScientificSkillDirectories,
  loadScientificSkill,
  validateScientificSkillDirectory,
  type SkillLoadOptions,
} from "./loader";
import { ScientificSkillRegistry } from "./registry";
import { resolveScientificSkillGraph, ScientificSkillResolutionError } from "./resolver";
import { runScientificSkillEvaluations } from "./evaluation";
import type {
  ScientificSkillCorpusValidationReport,
  ScientificSkillValidationIssue,
} from "./types";

/** Validate local files, corpus identity, dependency closure, cycles, conflicts, and repository evaluations. */
export function validateScientificSkillCorpus(
  corpusRoot: string,
  options: SkillLoadOptions = {},
): ScientificSkillCorpusValidationReport {
  const absoluteRoot = resolve(corpusRoot);
  const directories = findScientificSkillDirectories(absoluteRoot);
  const reports = directories.map((directory) =>
    validateScientificSkillDirectory(directory, options),
  );
  const issues: ScientificSkillValidationIssue[] = [];
  if (directories.length === 0) {
    issues.push({
      code: "EMPTY_SKILL_CORPUS",
      severity: "error",
      message: "Repository scientific skill corpus contains no skill.yaml manifests",
    });
  }
  let registry: ScientificSkillRegistry | undefined;
  if (reports.every((report) => report.valid)) {
    try {
      registry = new ScientificSkillRegistry(
        directories.map((directory) => loadScientificSkill(directory, options)),
      );
    } catch (error) {
      issues.push({
        code:
          error instanceof ScientificSkillValidationError
            ? error.code
            : "DUPLICATE_OR_INVALID_SKILL",
        severity: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (registry) {
    for (const id of registry.ids()) {
      try {
        resolveScientificSkillGraph(registry, {
          requested: [id],
          resolvedAt: "1970-01-01T00:00:00.000Z",
        });
      } catch (error) {
        issues.push({
          code:
            error instanceof ScientificSkillResolutionError
              ? error.code
              : "SKILL_RESOLUTION_FAILED",
          severity: "error",
          message: `${id}: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    try {
      const evaluation = runScientificSkillEvaluations(registry);
      for (const failed of evaluation.cases.filter((item) => !item.passed)) {
        issues.push({
          code: "SKILL_EVALUATION_FAILED",
          severity: "error",
          message: `${failed.id}: ${failed.details}`,
          path: failed.source,
        });
      }
    } catch (error) {
      issues.push({
        code: "INVALID_EVALUATION_CORPUS",
        severity: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  issues.sort((left, right) =>
    `${left.code}\0${left.path ?? ""}\0${left.message}`.localeCompare(
      `${right.code}\0${right.path ?? ""}\0${right.message}`,
    ),
  );
  return {
    schemaVersion: "eigengrid.scientific-skill-corpus-report/v1",
    valid:
      reports.every((report) => report.valid) &&
      !issues.some((issue) => issue.severity === "error"),
    corpusRoot: absoluteRoot,
    ...(registry ? { corpusDigest: registry.corpusDigest } : {}),
    skillCount: reports.length,
    reports,
    issues,
  };
}
