import {
  canonicalJson,
  digestCanonical,
  type EvidenceReference,
  type MissionBudget,
  type ScientificMission,
  type ScientificPlan,
  type SkillFragmentReference,
  type WorkUnit,
} from "@eigengrid/scientific-schema";
import {
  redactScientificContextSecrets,
  type RedactionReportEntry,
} from "@eigengrid/model-gateway";

// Preserve the scientific-agent surface while keeping redaction implemented once
// at the shared provider boundary.
export { redactScientificContextSecrets } from "@eigengrid/model-gateway";
export type { RedactionReportEntry } from "@eigengrid/model-gateway";

export const ScientificContextVersion = "eigengrid.scientific-context/v1" as const;

export interface SkillFragmentContent {
  reference: SkillFragmentReference;
  content: string;
}

export interface ContextEvidenceSummary {
  reference: EvidenceReference;
  summary: string;
}

export interface ValidatedInstallationKnowledge {
  id: string;
  scope: string;
  contentDigest: string;
  content: unknown;
  validated: boolean;
}

export interface EpisodicContextCandidate {
  id: string;
  content: unknown;
  confidence: "low" | "medium" | "high";
  evidenceRefs: string[];
}

export interface ContextContradiction {
  id: string;
  statement: string;
  evidenceRefs: string[];
}

export interface ContextUnresolvedQuestion {
  id: string;
  question: string;
  evidenceRefs: string[];
}

export interface ContextAssemblerInput {
  mission: ScientificMission;
  plan?: ScientificPlan;
  workUnit?: WorkUnit;
  policyProfile: unknown;
  budget: MissionBudget;
  scope: string;
  skillFragments: SkillFragmentContent[];
  evidence: ContextEvidenceSummary[];
  installationKnowledge?: ValidatedInstallationKnowledge[];
  episodicCandidates?: EpisodicContextCandidate[];
  contradictions?: ContextContradiction[];
  unresolvedQuestions?: ContextUnresolvedQuestion[];
  maximumBytes: number;
}

export type ScientificContextSectionKind =
  | "objective_and_mission"
  | "plan_and_work_unit"
  | "policy_and_budget"
  | "skill_fragments"
  | "authoritative_evidence"
  | "installation_knowledge"
  | "episodic_candidates"
  | "contradictions_and_questions";

export interface ScientificContextItem {
  id: string;
  payload: unknown;
}

export interface ScientificContextSection {
  kind: ScientificContextSectionKind;
  authorityRank: number;
  items: ScientificContextItem[];
}

export interface OmittedContextEntry {
  section: ScientificContextSectionKind;
  itemId: string;
  reason: "budget" | "unvalidated" | "scope_mismatch";
  sizeBytes?: number;
}

export interface AssembledScientificContext {
  schemaVersion: typeof ScientificContextVersion;
  sections: ScientificContextSection[];
}

export interface ContextAssemblySuccess {
  status: "assembled";
  context: AssembledScientificContext;
  selectedFragmentIds: string[];
  selectedEvidenceIds: string[];
  contextDigest: string;
  accounting: {
    maximumBytes: number;
    candidateBytes: number;
    usedBytes: number;
    sectionBytes: Record<ScientificContextSectionKind, number>;
  };
  redactions: RedactionReportEntry[];
  omissions: OmittedContextEntry[];
}

export interface ContextAssemblyBudgetFailure {
  status: "insufficient_budget";
  code: "MANDATORY_CONTEXT_EXCEEDS_BUDGET";
  requiredBytes: number;
  maximumBytes: number;
  redactions: RedactionReportEntry[];
  omissions: OmittedContextEntry[];
}

export type ContextAssemblyResult = ContextAssemblySuccess | ContextAssemblyBudgetFailure;

const sectionRanks: Record<ScientificContextSectionKind, number> = {
  objective_and_mission: 1,
  plan_and_work_unit: 2,
  policy_and_budget: 3,
  skill_fragments: 4,
  authoritative_evidence: 5,
  installation_knowledge: 6,
  episodic_candidates: 7,
  contradictions_and_questions: 8,
};

function bytes(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value), "utf8");
}

function emptySection(kind: ScientificContextSectionKind): ScientificContextSection {
  return { kind, authorityRank: sectionRanks[kind], items: [] };
}

function sortById<T extends { id: string }>(values: readonly T[]): T[] {
  return [...values].sort((left, right) => left.id.localeCompare(right.id));
}

function withReferenceId<T extends { reference: { id: string } }>(values: readonly T[]): T[] {
  return [...values].sort((left, right) => left.reference.id.localeCompare(right.reference.id));
}

function contextWithNonEmptySections(
  sections: readonly ScientificContextSection[],
): AssembledScientificContext {
  return {
    schemaVersion: ScientificContextVersion,
    sections: sections.filter((section) => section.items.length > 0),
  };
}

/**
 * Builds a reproducible context from durable records. It performs no retrieval and has no clock,
 * model, persistence, or process dependency, so a restarted mission can rebuild the exact digest.
 */
export function assembleScientificContext(input: ContextAssemblerInput): ContextAssemblyResult {
  if (!Number.isSafeInteger(input.maximumBytes) || input.maximumBytes <= 0) {
    throw new RangeError("maximumBytes must be a positive safe integer");
  }

  const rawSections: ScientificContextSection[] = [
    {
      kind: "objective_and_mission",
      authorityRank: sectionRanks.objective_and_mission,
      items: [
        {
          id: input.mission.objective.id,
          payload: { objective: input.mission.objective, mission: input.mission },
        },
      ],
    },
    {
      kind: "plan_and_work_unit",
      authorityRank: sectionRanks.plan_and_work_unit,
      items: [
        {
          id: input.plan?.id ?? `mission:${input.mission.id}:no-plan`,
          payload: { plan: input.plan ?? null, workUnit: input.workUnit ?? null },
        },
      ],
    },
    {
      kind: "policy_and_budget",
      authorityRank: sectionRanks.policy_and_budget,
      items: [
        {
          id: input.mission.policyProfile,
          payload: { policyProfile: input.policyProfile, budget: input.budget },
        },
      ],
    },
    {
      kind: "skill_fragments",
      authorityRank: sectionRanks.skill_fragments,
      items: [...input.skillFragments]
        .sort((left, right) => left.reference.fragmentId.localeCompare(right.reference.fragmentId))
        .map((fragment) => ({
          id: fragment.reference.fragmentId,
          payload: fragment,
        })),
    },
    {
      kind: "authoritative_evidence",
      authorityRank: sectionRanks.authoritative_evidence,
      items: withReferenceId(input.evidence).map((evidence) => ({
        id: evidence.reference.id,
        payload: evidence,
      })),
    },
    {
      kind: "installation_knowledge",
      authorityRank: sectionRanks.installation_knowledge,
      items: sortById(input.installationKnowledge ?? [])
        .filter((knowledge) => knowledge.validated && knowledge.scope === input.scope)
        .map((knowledge) => ({ id: knowledge.id, payload: knowledge })),
    },
    {
      kind: "episodic_candidates",
      authorityRank: sectionRanks.episodic_candidates,
      items: sortById(input.episodicCandidates ?? []).map((candidate) => ({
        id: candidate.id,
        payload: { ...candidate, authority: "low" },
      })),
    },
    {
      kind: "contradictions_and_questions",
      authorityRank: sectionRanks.contradictions_and_questions,
      items: [
        ...sortById(input.contradictions ?? []).map((contradiction) => ({
          id: contradiction.id,
          payload: { kind: "contradiction", ...contradiction },
        })),
        ...sortById(input.unresolvedQuestions ?? []).map((question) => ({
          id: question.id,
          payload: { kind: "unresolved_question", ...question },
        })),
      ],
    },
  ];

  const redacted = redactScientificContextSecrets(rawSections);
  const sections = redacted.value as ScientificContextSection[];
  const omissions: OmittedContextEntry[] = [];

  for (const knowledge of sortById(input.installationKnowledge ?? [])) {
    if (!knowledge.validated) {
      omissions.push({
        section: "installation_knowledge",
        itemId: knowledge.id,
        reason: "unvalidated",
      });
    } else if (knowledge.scope !== input.scope) {
      omissions.push({
        section: "installation_knowledge",
        itemId: knowledge.id,
        reason: "scope_mismatch",
      });
    }
  }

  const selectedSections = sections.slice(0, 3).map((section) => ({
    ...section,
    items: [...section.items],
  }));
  const mandatoryContext = contextWithNonEmptySections(selectedSections);
  const mandatoryBytes = bytes(mandatoryContext);
  if (mandatoryBytes > input.maximumBytes) {
    return {
      status: "insufficient_budget",
      code: "MANDATORY_CONTEXT_EXCEEDS_BUDGET",
      requiredBytes: mandatoryBytes,
      maximumBytes: input.maximumBytes,
      redactions: redacted.report,
      omissions,
    };
  }

  for (const section of sections.slice(3)) {
    const selectedSection = emptySection(section.kind);
    selectedSections.push(selectedSection);
    for (const item of section.items) {
      const candidateItemBytes = bytes(item);
      selectedSection.items.push(item);
      const candidate = contextWithNonEmptySections(selectedSections);
      if (bytes(candidate) > input.maximumBytes) {
        selectedSection.items.pop();
        omissions.push({
          section: section.kind,
          itemId: item.id,
          reason: "budget",
          sizeBytes: candidateItemBytes,
        });
      }
    }
  }

  const context = contextWithNonEmptySections(selectedSections);
  const allCandidateContext = contextWithNonEmptySections(sections);
  const sectionBytes = Object.fromEntries(
    (Object.keys(sectionRanks) as ScientificContextSectionKind[]).map((kind) => {
      const section = context.sections.find((candidate) => candidate.kind === kind);
      return [kind, section ? bytes(section) : 0];
    }),
  ) as Record<ScientificContextSectionKind, number>;

  const selectedFragmentIds =
    context.sections
      .find((section) => section.kind === "skill_fragments")
      ?.items.map((item) => item.id) ?? [];
  const selectedEvidenceIds =
    context.sections
      .find((section) => section.kind === "authoritative_evidence")
      ?.items.map((item) => item.id) ?? [];

  return {
    status: "assembled",
    context,
    selectedFragmentIds,
    selectedEvidenceIds,
    contextDigest: digestCanonical(context),
    accounting: {
      maximumBytes: input.maximumBytes,
      candidateBytes: bytes(allCandidateContext),
      usedBytes: bytes(context),
      sectionBytes,
    },
    redactions: redacted.report,
    omissions,
  };
}
