import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { digestBytes, digestCanonical } from "@eigengrid/scientific-schema";
import {
  CompositionEvaluationCaseSchema,
  ScientificSkillManifestSchema,
  SkillMarkdownFrontmatterSchema,
  TriggerEvaluationCaseSchema,
  type ScientificSkillManifest,
  type SkillMarkdownFrontmatter,
} from "./schema";
import { satisfiesSemver } from "./semver";
import type {
  LoadedScientificSkill,
  ScientificSkillValidationIssue,
  ScientificSkillValidationReport,
} from "./types";

export interface SkillLoadOptions {
  allowedHelperIds?: ReadonlySet<string>;
  now?: Date;
}

export class ScientificSkillValidationError extends Error {
  readonly code = "INVALID_SCIENTIFIC_SKILL";

  constructor(public readonly report: ScientificSkillValidationReport) {
    super(
      `Scientific skill validation failed for ${report.directory}: ${report.issues
        .filter((issue) => issue.severity === "error")
        .map((issue) => `${issue.code}: ${issue.message}`)
        .join("; ")}`,
    );
    this.name = "ScientificSkillValidationError";
  }
}

function parseYamlOrJson(text: string, source: string): unknown {
  try {
    if (text.trimStart().startsWith("{")) {
      try {
        return JSON.parse(text);
      } catch {
        // Prettier may retain flow braces while emitting valid YAML trailing commas.
        // Fall through to YAML instead of treating the extension as JSON.
      }
    }
    const runtime = globalThis as typeof globalThis & {
      Bun?: { YAML?: { parse(value: string): unknown } };
    };
    if (!runtime.Bun?.YAML) {
      throw new Error(
        "YAML parsing requires the Bun runtime; JSON-formatted YAML remains portable",
      );
    }
    return runtime.Bun.YAML.parse(text);
  } catch (error) {
    throw new Error(
      `Cannot parse ${source}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function parseSkillMarkdown(markdown: string): {
  frontmatter: SkillMarkdownFrontmatter;
  body: string;
} {
  if (!markdown.startsWith("---\n") && !markdown.startsWith("---\r\n")) {
    throw new Error("SKILL.md must begin with YAML frontmatter delimited by ---");
  }
  const normalized = markdown.replaceAll("\r\n", "\n");
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) throw new Error("SKILL.md frontmatter is missing its closing --- delimiter");
  const raw = parseYamlOrJson(normalized.slice(4, end), "SKILL.md frontmatter");
  return {
    frontmatter: SkillMarkdownFrontmatterSchema.parse(raw),
    body: normalized.slice(end + 5).trim(),
  };
}

function filesRecursively(directory: string): string[] {
  const output: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      output.push(path);
    } else if (entry.isDirectory()) {
      output.push(...filesRecursively(path));
    } else if (entry.isFile()) {
      output.push(path);
    }
  }
  return output;
}

function normalizedRelativePath(directory: string, path: string): string {
  return relative(directory, path).split(sep).join("/");
}

function contentDigest(directory: string, files: readonly string[], manifest: unknown): string {
  const normalizedManifest = structuredClone(manifest) as {
    provenance?: { content_digest?: string };
  };
  if (normalizedManifest.provenance) delete normalizedManifest.provenance.content_digest;
  return digestCanonical(
    files.map((path) => {
      const relativePath = normalizedRelativePath(directory, path);
      return {
        path: relativePath,
        digest: lstatSync(path).isSymbolicLink()
          ? digestCanonical({ rejected: "symbolic-link" })
          : relativePath === "skill.yaml"
            ? digestCanonical(normalizedManifest)
            : digestBytes(readFileSync(path)),
      };
    }),
  );
}

function addIssue(
  issues: ScientificSkillValidationIssue[],
  code: string,
  message: string,
  path?: string,
  severity: "error" | "warning" = "error",
): void {
  issues.push({ code, severity, message, ...(path ? { path } : {}) });
}

const REQUIRED_SECTIONS = [
  "Purpose",
  "Use when",
  "Do not use alone when",
  "Required inputs",
  "Missing-input behavior",
  "Scientific decisions",
  "Limitations and escalation",
] as const;

function validateSafety(
  directory: string,
  files: readonly string[],
  manifest: ScientificSkillManifest,
  issues: ScientificSkillValidationIssue[],
  options: SkillLoadOptions,
): void {
  const declaredHelpers = new Map(manifest.helpers.map((helper) => [helper.path, helper]));
  for (const path of files) {
    const relativePath = normalizedRelativePath(directory, path);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      addIssue(issues, "SYMLINK_REJECTED", "Skill files may not be symbolic links", relativePath);
      continue;
    }
    if ((stat.mode & 0o111) !== 0) {
      addIssue(
        issues,
        "EXECUTABLE_FILE_REJECTED",
        "Executable skill files are not loaded as scientific knowledge",
        relativePath,
      );
    }
    const isScript =
      relativePath.startsWith("scripts/") || /\.(?:sh|py|js|mjs|cjs)$/u.test(relativePath);
    if (isScript) {
      const helper = declaredHelpers.get(relativePath);
      if (!helper || !options.allowedHelperIds?.has(helper.id)) {
        addIssue(
          issues,
          "UNSAFE_HELPER_REJECTED",
          "Skill helpers require an exact manifest digest and an application-owned allowlist",
          relativePath,
        );
      } else if (digestBytes(readFileSync(path)) !== helper.digest) {
        addIssue(
          issues,
          "HELPER_DIGEST_MISMATCH",
          "Allowlisted helper bytes changed",
          relativePath,
        );
      }
    }
    const extension = extname(path).toLowerCase();
    if (![".md", ".yaml", ".yml", ".json", ".jsonl", ".txt", ".bib"].includes(extension)) {
      continue;
    }
    const text = readFileSync(path, "utf8");
    const actionable = text
      .split(/\r?\n/u)
      .filter((line) => !/^\s*(?:do not|never|must not|cannot|reject|refuse)\b/iu.test(line))
      .join("\n");
    const unsafePatterns: Array<[string, RegExp]> = [
      ["PROMPT_POLICY_OVERRIDE", /ignore\s+(?:all\s+)?(?:previous|system|policy)\s+instructions/iu],
      ["APPROVAL_BYPASS", /bypass\s+(?:human\s+)?(?:approval|authorization|policy)/iu],
      [
        "ARBITRARY_EFFECT_AUTHORITY",
        /(?:execute|run)\s+(?:an?\s+)?(?:arbitrary\s+)?(?:shell|sql|ssh|slurm)\b/iu,
      ],
      ["POLICY_OVERRIDE", /override\s+(?:safety|authorization|approval|policy)\b/iu],
      ["FALSE_AUTHORITY", /(?:you|skill|agent)\s+(?:are|is)\s+authorized\s+to/iu],
    ];
    for (const [code, pattern] of unsafePatterns) {
      if (pattern.test(actionable)) {
        addIssue(
          issues,
          code,
          "Skill content may inform decisions but may not grant authority or override policy",
          relativePath,
        );
      }
    }
  }
}

function validateMaturity(
  manifest: ScientificSkillManifest,
  issues: ScientificSkillValidationIssue[],
): void {
  const knowledgeRank = [
    "draft",
    "reference_curated",
    "expert_reviewed",
    "benchmark_backed",
    "production_certified",
  ];
  const rank = knowledgeRank.indexOf(manifest.knowledge_level);
  if (rank >= 2 && manifest.review.status !== "expert_reviewed") {
    addIssue(
      issues,
      "FALSE_MATURITY_CLAIM",
      `${manifest.knowledge_level} requires an explicit expert-reviewed record`,
      "skill.yaml",
    );
  }
  if (rank >= 2 && manifest.review.evidence_ids.length === 0) {
    addIssue(
      issues,
      "MISSING_MATURITY_EVIDENCE",
      `${manifest.knowledge_level} requires declared review or benchmark evidence`,
      "skill.yaml",
    );
  }
  if (rank >= 3 && !manifest.assets.benchmarks) {
    addIssue(
      issues,
      "MISSING_BENCHMARK_ASSET",
      `${manifest.knowledge_level} requires a benchmark asset`,
      "skill.yaml",
    );
  }
  if (manifest.knowledge_level === "production_certified") {
    const validated = Object.values(manifest.capability_levels.validated).some(Boolean);
    if (!validated) {
      addIssue(
        issues,
        "FALSE_PRODUCTION_CERTIFICATION",
        "Production certification requires at least one explicitly validated engine path",
        "skill.yaml",
      );
    }
  }
  for (const [engine, validated] of Object.entries(manifest.capability_levels.validated)) {
    if (validated && !manifest.capability_levels.executable[engine]) {
      addIssue(
        issues,
        "INVALID_CAPABILITY_LADDER",
        `Validated engine ${engine} is not declared executable`,
        "skill.yaml",
      );
    }
  }
}

function validateStructuredAssets(
  directory: string,
  files: readonly string[],
  manifest: ScientificSkillManifest,
  issues: ScientificSkillValidationIssue[],
): void {
  for (const path of files) {
    const relativePath = normalizedRelativePath(directory, path);
    if (relativePath === "skill.yaml") continue;
    if (relativePath.startsWith("evals/") && relativePath.endsWith(".jsonl")) {
      const lines = readFileSync(path, "utf8")
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean);
      for (let index = 0; index < lines.length; index += 1) {
        try {
          const raw = JSON.parse(lines[index]);
          const schema = relativePath.includes("composition")
            ? CompositionEvaluationCaseSchema
            : TriggerEvaluationCaseSchema;
          schema.parse(raw);
        } catch (error) {
          addIssue(
            issues,
            "INVALID_EVALUATION_CASE",
            `Line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
            relativePath,
          );
        }
      }
      continue;
    }
    if (!/\.(?:yaml|yml|json)$/u.test(relativePath)) continue;
    let raw: unknown;
    try {
      raw = parseYamlOrJson(readFileSync(path, "utf8"), relativePath);
    } catch (error) {
      addIssue(
        issues,
        "MALFORMED_STRUCTURED_ASSET",
        error instanceof Error ? error.message : String(error),
        relativePath,
      );
      continue;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      addIssue(
        issues,
        "INVALID_STRUCTURED_ASSET",
        "Structured scientific assets must be objects",
        relativePath,
      );
      continue;
    }
    const record = raw as Record<string, unknown>;
    if (typeof record.schema !== "string" || !record.schema.startsWith("eigengrid.")) {
      addIssue(
        issues,
        "MISSING_ASSET_SCHEMA",
        "Structured scientific assets require an eigengrid.* schema identifier",
        relativePath,
      );
    }
    if (relativePath.startsWith("decision-rules/")) {
      if (record.schema !== "eigengrid.decision-rule/v1") {
        addIssue(
          issues,
          "INVALID_DECISION_RULE_SCHEMA",
          "Decision rules must use eigengrid.decision-rule/v1",
          relativePath,
        );
      }
      if (["none", "automatic", "bypass"].includes(String(record.approval))) {
        addIssue(
          issues,
          "UNSAFE_DECISION_RULE_APPROVAL",
          "A decision rule may not waive approval or authorize automatic material change",
          relativePath,
        );
      }
    }
    if (relativePath.startsWith("protocols/")) {
      if (record.effect_authority !== "none") {
        addIssue(
          issues,
          "PROTOCOL_AUTHORITY_REJECTED",
          "Skill protocol fragments must explicitly declare effect_authority: none",
          relativePath,
        );
      }
      if (!Array.isArray(record.steps) || record.steps.length === 0) {
        addIssue(
          issues,
          "EMPTY_PROTOCOL_FRAGMENT",
          "A plannable protocol fragment requires at least one typed step",
          relativePath,
        );
      }
    }
    if (relativePath.startsWith("engine-mappings/")) {
      const engine = typeof record.engine === "string" ? record.engine : undefined;
      if (
        record.executable === true &&
        (!engine || !manifest.capability_levels.executable[engine])
      ) {
        addIssue(
          issues,
          "FALSE_ENGINE_EXECUTABILITY",
          "An engine mapping cannot claim execution beyond the manifest capability record",
          relativePath,
        );
      }
      if (
        record.validated === true &&
        (!engine || manifest.capability_levels.validated[engine] !== true)
      ) {
        addIssue(
          issues,
          "FALSE_ENGINE_VALIDATION",
          "An engine mapping cannot claim validation beyond the manifest capability record",
          relativePath,
        );
      }
    }
  }
}

function validateParsedSkill(
  directory: string,
  files: readonly string[],
  manifest: ScientificSkillManifest,
  rawManifest: unknown,
  frontmatter: SkillMarkdownFrontmatter,
  markdownBody: string,
  issues: ScientificSkillValidationIssue[],
  options: SkillLoadOptions,
): string {
  if (frontmatter.id !== manifest.id) {
    addIssue(issues, "FRONTMATTER_ID_MISMATCH", "SKILL.md and skill.yaml ids differ", "SKILL.md");
  }
  if (frontmatter.version !== manifest.version) {
    addIssue(
      issues,
      "FRONTMATTER_VERSION_MISMATCH",
      "SKILL.md and skill.yaml versions differ",
      "SKILL.md",
    );
  }
  for (const section of REQUIRED_SECTIONS) {
    if (!new RegExp(`^#{2,3}\\s+${section}\\s*$`, "imu").test(markdownBody)) {
      addIssue(
        issues,
        "MISSING_DISCLOSURE_SECTION",
        `SKILL.md is missing the progressive-disclosure section '${section}'`,
        "SKILL.md",
      );
    }
  }
  for (const [assetKind, assetPath] of Object.entries(manifest.assets)) {
    const absolute = resolve(directory, assetPath);
    if (!absolute.startsWith(`${resolve(directory)}${sep}`)) {
      addIssue(
        issues,
        "ASSET_PATH_TRAVERSAL",
        `Asset ${assetKind} escapes its skill`,
        "skill.yaml",
      );
    } else if (!existsSync(absolute)) {
      addIssue(issues, "MISSING_ASSET", `Declared ${assetKind} asset does not exist`, assetPath);
    } else if (statSync(absolute).isDirectory() && readdirSync(absolute).length === 0) {
      addIssue(issues, "EMPTY_ASSET", `Declared ${assetKind} asset directory is empty`, assetPath);
    }
  }
  if (manifest.capability_levels.plannable && !manifest.assets.protocols) {
    addIssue(
      issues,
      "PLANNABLE_WITHOUT_PROTOCOL",
      "A plannable skill must expose at least one engine-neutral protocol fragment",
      "skill.yaml",
    );
  }
  if (manifest.capability_levels.plannable && !manifest.assets.evals) {
    addIssue(
      issues,
      "PLANNABLE_WITHOUT_EVALS",
      "A plannable skill must include positive, negative, and composition evaluations",
      "skill.yaml",
    );
  }
  const dependencyIds = [...manifest.requires, ...manifest.recommends].map((item) => item.id);
  if (new Set(dependencyIds).size !== dependencyIds.length) {
    addIssue(
      issues,
      "DUPLICATE_DEPENDENCY",
      "A dependency may not be both hard and optional or declared twice",
      "skill.yaml",
    );
  }
  for (const dependency of [...manifest.requires, ...manifest.recommends]) {
    try {
      satisfiesSemver("1.0.0", dependency.range);
    } catch (error) {
      addIssue(
        issues,
        "INVALID_VERSION_RANGE",
        error instanceof Error ? error.message : String(error),
        "skill.yaml",
      );
    }
  }
  for (const [engine, range] of Object.entries(manifest.engine_compatibility)) {
    try {
      satisfiesSemver("1.0.0", range);
    } catch (error) {
      addIssue(
        issues,
        "INVALID_ENGINE_RANGE",
        `${engine}: ${error instanceof Error ? error.message : String(error)}`,
        "skill.yaml",
      );
    }
  }
  validateMaturity(manifest, issues);
  validateStructuredAssets(directory, files, manifest, issues);
  validateSafety(directory, files, manifest, issues, options);

  const digest = contentDigest(directory, files, rawManifest);
  if (manifest.provenance.content_digest && manifest.provenance.content_digest !== digest) {
    addIssue(
      issues,
      "CONTENT_DIGEST_MISMATCH",
      `Manifest expected ${manifest.provenance.content_digest}, computed ${digest}`,
      "skill.yaml",
    );
  }
  if (manifest.review.review_before && options.now) {
    const reviewBefore = new Date(`${manifest.review.review_before}T23:59:59.999Z`);
    if (reviewBefore < options.now) {
      addIssue(
        issues,
        "REVIEW_EXPIRED",
        `Scientific review expired on ${manifest.review.review_before}`,
        "skill.yaml",
        "warning",
      );
    }
  }
  return digest;
}

export function validateScientificSkillDirectory(
  directory: string,
  options: SkillLoadOptions = {},
): ScientificSkillValidationReport {
  const absoluteDirectory = resolve(directory);
  const issues: ScientificSkillValidationIssue[] = [];
  if (!existsSync(absoluteDirectory) || !statSync(absoluteDirectory).isDirectory()) {
    return {
      valid: false,
      directory: absoluteDirectory,
      issues: [
        {
          code: "SKILL_DIRECTORY_NOT_FOUND",
          severity: "error",
          message: "Scientific skill directory does not exist",
        },
      ],
    };
  }
  const manifestPath = join(absoluteDirectory, "skill.yaml");
  const markdownPath = join(absoluteDirectory, "SKILL.md");
  if (!existsSync(manifestPath)) addIssue(issues, "MISSING_MANIFEST", "skill.yaml is required");
  if (!existsSync(markdownPath)) addIssue(issues, "MISSING_SKILL_MD", "SKILL.md is required");
  if (issues.length > 0) return { valid: false, directory: absoluteDirectory, issues };

  let rawManifest: unknown;
  let manifest: ScientificSkillManifest | undefined;
  let parsedMarkdown: { frontmatter: SkillMarkdownFrontmatter; body: string } | undefined;
  try {
    rawManifest = parseYamlOrJson(readFileSync(manifestPath, "utf8"), manifestPath);
    const result = ScientificSkillManifestSchema.safeParse(rawManifest);
    if (!result.success) {
      for (const issue of result.error.issues) {
        addIssue(
          issues,
          "INVALID_MANIFEST",
          issue.message,
          `skill.yaml${issue.path.length ? `:${issue.path.join(".")}` : ""}`,
        );
      }
    } else {
      manifest = result.data;
    }
  } catch (error) {
    addIssue(
      issues,
      "INVALID_MANIFEST",
      error instanceof Error ? error.message : String(error),
      "skill.yaml",
    );
  }
  try {
    parsedMarkdown = parseSkillMarkdown(readFileSync(markdownPath, "utf8"));
  } catch (error) {
    addIssue(
      issues,
      "INVALID_FRONTMATTER",
      error instanceof Error ? error.message : String(error),
      "SKILL.md",
    );
  }
  const files = filesRecursively(absoluteDirectory);
  let digest: string | undefined;
  if (manifest && parsedMarkdown) {
    digest = validateParsedSkill(
      absoluteDirectory,
      files,
      manifest,
      rawManifest,
      parsedMarkdown.frontmatter,
      parsedMarkdown.body,
      issues,
      options,
    );
  }
  issues.sort((a, b) =>
    [a.severity, a.code, a.path ?? "", a.message]
      .join("\0")
      .localeCompare([b.severity, b.code, b.path ?? "", b.message].join("\0")),
  );
  return {
    valid: !issues.some((issue) => issue.severity === "error"),
    directory: absoluteDirectory,
    ...(manifest ? { skillId: manifest.id, version: manifest.version } : {}),
    ...(digest ? { contentDigest: digest } : {}),
    issues,
  };
}

export function loadScientificSkill(
  directory: string,
  options: SkillLoadOptions = {},
): LoadedScientificSkill {
  const report = validateScientificSkillDirectory(directory, options);
  if (!report.valid) throw new ScientificSkillValidationError(report);
  const manifest = ScientificSkillManifestSchema.parse(
    parseYamlOrJson(readFileSync(join(report.directory, "skill.yaml"), "utf8"), "skill.yaml"),
  );
  const parsed = parseSkillMarkdown(readFileSync(join(report.directory, "SKILL.md"), "utf8"));
  const files = filesRecursively(report.directory);
  const searchableParts = [
    manifest.id,
    manifest.title,
    manifest.summary,
    parsed.frontmatter.description,
    parsed.body,
  ];
  for (const path of files) {
    const relativePath = normalizedRelativePath(report.directory, path);
    if (relativePath === "skill.yaml" || relativePath.startsWith("evals/")) continue;
    const extension = extname(path).toLowerCase();
    if ([".md", ".yaml", ".yml", ".json", ".txt", ".bib"].includes(extension)) {
      searchableParts.push(readFileSync(path, "utf8"));
    }
  }
  return {
    directory: report.directory,
    manifest,
    frontmatter: parsed.frontmatter,
    markdownBody: parsed.body,
    contentDigest: report.contentDigest!,
    files: files.map((path) => normalizedRelativePath(report.directory, path)),
    searchableText: searchableParts.join("\n").toLowerCase(),
  };
}

export function findScientificSkillDirectories(corpusRoot: string): string[] {
  const absoluteRoot = resolve(corpusRoot);
  if (!existsSync(absoluteRoot)) return [];
  const directories = new Set<string>();
  for (const path of filesRecursively(absoluteRoot)) {
    if (normalizedRelativePath(absoluteRoot, path).endsWith("skill.yaml")) {
      directories.add(resolve(path, ".."));
    }
  }
  return [...directories].sort();
}

export function repositoryScientificSkillsRoot(repositoryRoot = process.cwd()): string {
  return join(resolve(repositoryRoot), "scientific-skills");
}

export function loadScientificSkillCorpus(
  corpusRoot: string,
  options: SkillLoadOptions = {},
): LoadedScientificSkill[] {
  return findScientificSkillDirectories(corpusRoot).map((directory) =>
    loadScientificSkill(directory, options),
  );
}
