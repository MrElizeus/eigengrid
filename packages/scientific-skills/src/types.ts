import type {
  ResolvedSkillGraph,
  SkillFragmentReference,
  SkillVersionReference,
} from "@eigengrid/scientific-schema";
import type { ScientificSkillManifest, SkillMarkdownFrontmatter } from "./schema";

export type SkillIssueSeverity = "error" | "warning";

export interface ScientificSkillValidationIssue {
  code: string;
  severity: SkillIssueSeverity;
  message: string;
  path?: string;
}

export interface ScientificSkillValidationReport {
  valid: boolean;
  directory: string;
  skillId?: string;
  version?: string;
  contentDigest?: string;
  issues: ScientificSkillValidationIssue[];
}

export interface ScientificSkillCorpusValidationReport {
  schemaVersion: "eigengrid.scientific-skill-corpus-report/v1";
  valid: boolean;
  corpusRoot: string;
  corpusDigest?: string;
  skillCount: number;
  reports: ScientificSkillValidationReport[];
  issues: ScientificSkillValidationIssue[];
}

export interface LoadedScientificSkill {
  directory: string;
  manifest: ScientificSkillManifest;
  frontmatter: SkillMarkdownFrontmatter;
  markdownBody: string;
  contentDigest: string;
  files: readonly string[];
  searchableText: string;
}

export interface ScientificSkillFragment {
  reference: SkillFragmentReference;
  assetKind: string;
  mediaType:
    | "text/markdown"
    | "application/yaml"
    | "application/json"
    | "application/jsonl"
    | "text/plain";
  content: string;
}

export interface ResolvedScientificSkillGraph {
  graph: ResolvedSkillGraph;
  skills: LoadedScientificSkill[];
  reasons: Record<string, string[]>;
  skippedOptional: Array<{ id: string; reason: string }>;
}

export interface SkillSearchHit {
  skill: SkillVersionReference;
  title: string;
  description: string;
  score: number;
  matchedTerms: string[];
}

export interface SkillSearchResult {
  query: string;
  hits: SkillSearchHit[];
  ambiguous: boolean;
}

export interface SelectedSkillContext {
  fragments: ScientificSkillFragment[];
  references: SkillFragmentReference[];
  totalCharacters: number;
  selectionDigest: string;
  reason: string;
}

export interface SkillEvaluationCaseResult {
  id: string;
  kind: string;
  source: string;
  passed: boolean;
  details: string;
}

export interface SkillEvaluationReport {
  schemaVersion: "eigengrid.scientific-skill-eval-report/v1";
  corpusDigest: string;
  total: number;
  passed: number;
  failed: number;
  cases: SkillEvaluationCaseResult[];
}
