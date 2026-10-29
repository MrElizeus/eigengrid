import {
  CriticFindingSchema,
  digestCanonical,
  type CriticFinding,
  type ModelInvocationRecord,
  type ScientificMission,
  type SkillFragmentReference,
} from "@eigengrid/scientific-schema";
import { z } from "zod";
import { type AssembledScientificContext } from "./context-assembler";
import {
  ModelGateway,
  type ModelInvocationJournal,
  type ModelGatewayOutcome,
  type ModelInvocationBudget,
  type ModelProviderIdentity,
} from "./model-gateway";
import { type ScientificPlannerOutput } from "./planner";
import {
  type EnvironmentCapabilityProfile,
  computeScientificProtocolDigest,
} from "./protocol-compiler";

export const ScientificCriticOutputVersion = "eigengrid.scientific-critic-output/v1" as const;

export interface CriticEvidenceAssertion {
  id: string;
  statement: string;
  contradictsAssumptionIds: string[];
  kinds: string[];
}

export interface ScientificCriticRequirements {
  electronicStateAlternativesRequired: boolean;
  conformationalTreatmentRequired: boolean;
  numericalConvergenceRequired: boolean;
  allowedMethods: string[];
  requiredValidationKinds: string[];
  requiredProvenanceKinds: string[];
  maximumCpuCoreHours?: number;
  minimumKnowledgeMaturity: EnvironmentCapabilityProfile["skillCompatibility"][number]["knowledgeMaturity"];
  minimumCapabilityMaturity: EnvironmentCapabilityProfile["skillCompatibility"][number]["capabilityMaturity"];
}

export interface ScientificCriticRequest {
  mission: ScientificMission;
  planningClaimId?: string;
  planId: string;
  candidate: ScientificPlannerOutput;
  environment: EnvironmentCapabilityProfile;
  requirements: ScientificCriticRequirements;
  evidence: CriticEvidenceAssertion[];
  context: AssembledScientificContext;
  contextDigest: string;
  gatewayBudget?: ModelInvocationBudget;
  timeoutMilliseconds?: number;
  maximumRepairAttempts?: number;
  preferredIdentities?: ModelProviderIdentity[];
  signal?: AbortSignal;
  invocationJournal?: ModelInvocationJournal;
}

const modelFindingSchema = z
  .object({
    severity: CriticFindingSchema.shape.severity,
    code: CriticFindingSchema.shape.code,
    summary: z.string().min(1),
    evidenceRefs: z.array(z.string().min(1)),
    skillRefs: z.array(CriticFindingSchema.shape.skillRefs.element),
  })
  .strict();

const ScientificCriticModelOutputSchema = z
  .object({
    schemaVersion: z.literal(ScientificCriticOutputVersion),
    findings: z.array(modelFindingSchema),
    limitations: z.array(z.string().min(1)),
  })
  .strict();
type ScientificCriticModelOutput = z.infer<typeof ScientificCriticModelOutputSchema>;

export interface ScientificCriticReview {
  readonly status: "reviewed";
  readonly verdict: "acceptable" | "revise";
  readonly findings: readonly CriticFinding[];
  readonly requiresNewPlanRevision: boolean;
  readonly modelStatus:
    | "not_requested"
    | ModelGatewayOutcome<ScientificCriticModelOutput>["status"];
  readonly modelInvocations: readonly ModelInvocationRecord[];
}

const knowledgeMaturityOrder = [
  "draft",
  "reference_curated",
  "expert_reviewed",
  "benchmark_backed",
  "production_certified",
] as const;
const capabilityMaturityOrder = [
  "reference",
  "advisory",
  "plannable",
  "renderable",
  "executable",
  "validated",
] as const;

function atLeast(current: string, required: string, order: readonly string[]): boolean {
  return order.indexOf(current) >= order.indexOf(required);
}

function skillIdentity(reference: SkillFragmentReference): string {
  return digestCanonical(reference);
}

function includesParameterKey(value: unknown, keys: readonly string[]): boolean {
  if (Array.isArray(value)) return value.some((item) => includesParameterKey(item, keys));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(
    ([key, child]) => keys.includes(key) || includesParameterKey(child, keys),
  );
}

function deterministicFinding(
  request: ScientificCriticRequest,
  code: CriticFinding["code"],
  severity: CriticFinding["severity"],
  summary: string,
  evidenceRefs: string[] = [],
  skillRefs: SkillFragmentReference[] = [],
): CriticFinding {
  return CriticFindingSchema.parse({
    id: `finding-${digestCanonical({
      missionId: request.mission.id,
      planId: request.planId,
      code,
      summary,
      evidenceRefs: [...evidenceRefs].sort(),
      skillRefs: [...skillRefs].map(skillIdentity).sort(),
    }).slice(0, 24)}`,
    missionId: request.mission.id,
    planId: request.planId,
    severity,
    code,
    summary,
    evidenceRefs: [...new Set(evidenceRefs)].sort(),
    skillRefs: [...skillRefs].sort((left, right) =>
      skillIdentity(left).localeCompare(skillIdentity(right)),
    ),
  });
}

function deterministicReview(request: ScientificCriticRequest): CriticFinding[] {
  const output = request.candidate;
  const protocol = output.candidateProtocol;
  const findings: CriticFinding[] = [];
  const decisions = new Map(
    output.scientificDecisions.map((decision) => [decision.category, decision]),
  );
  const chargeDecision = decisions.get("charge");
  const multiplicityDecision = decisions.get("multiplicity");

  if (
    request.mission.objective.system.charge === undefined &&
    (!chargeDecision || chargeDecision.selectedOption === null)
  ) {
    findings.push(
      deterministicFinding(
        request,
        "missing_charge",
        "blocking",
        "Molecular charge is neither authoritative input nor an explicit resolved decision.",
      ),
    );
  }
  if (
    request.mission.objective.system.multiplicity === undefined &&
    (!multiplicityDecision || multiplicityDecision.selectedOption === null)
  ) {
    findings.push(
      deterministicFinding(
        request,
        "missing_multiplicity",
        "blocking",
        "Spin multiplicity is neither authoritative input nor an explicit resolved decision.",
      ),
    );
  }
  if (
    request.requirements.electronicStateAlternativesRequired &&
    (!multiplicityDecision || multiplicityDecision.alternatives.length === 0)
  ) {
    findings.push(
      deterministicFinding(
        request,
        "missing_electronic_state_alternative",
        "error",
        "The plan selects an electronic state without recording a plausible alternative.",
        multiplicityDecision?.evidenceRefs ?? [],
        multiplicityDecision?.skillRefs ?? [],
      ),
    );
  }

  if (protocol && !request.requirements.allowedMethods.includes(protocol.method)) {
    findings.push(
      deterministicFinding(
        request,
        "inappropriate_method",
        "blocking",
        `Method ${protocol.method} is outside the reviewed applicability set.`,
        [],
        output.skillReferences,
      ),
    );
  }
  if (
    request.requirements.conformationalTreatmentRequired &&
    !protocol?.engineAgnosticSteps.some((step) =>
      includesParameterKey(step.parameters, ["conformationalTreatment", "conformerStrategy"]),
    )
  ) {
    findings.push(
      deterministicFinding(
        request,
        "missing_conformational_treatment",
        "error",
        "The objective requires conformational treatment, but the protocol declares none.",
        [],
        output.skillReferences,
      ),
    );
  }
  if (
    request.requirements.numericalConvergenceRequired &&
    !protocol?.engineAgnosticSteps.some((step) =>
      includesParameterKey(step.parameters, [
        "numericalConvergence",
        "scfConvergence",
        "integrationGrid",
        "convergenceThreshold",
      ]),
    )
  ) {
    findings.push(
      deterministicFinding(
        request,
        "missing_numerical_convergence",
        "error",
        "The protocol omits an explicit numerical-convergence policy.",
        [],
        output.skillReferences,
      ),
    );
  }

  const declaredValidationKinds = new Set(
    output.validationGates.flatMap((gate) => gate.requiredEvidenceKinds),
  );
  const hasValidationStep = protocol?.engineAgnosticSteps.some(
    (step) => step.kind === "validation",
  );
  const missingValidationKinds = request.requirements.requiredValidationKinds.filter(
    (kind) => !declaredValidationKinds.has(kind),
  );
  if (!hasValidationStep || missingValidationKinds.length > 0) {
    findings.push(
      deterministicFinding(
        request,
        "insufficient_validation",
        "blocking",
        `Validation is incomplete${
          missingValidationKinds.length > 0
            ? `; missing evidence kinds: ${missingValidationKinds.join(", ")}`
            : ""
        }.`,
        [],
        output.skillReferences,
      ),
    );
  }

  const engine = request.environment.selectedEngine;
  if (
    !request.mission.constraints.allowedEngines.includes(engine.id) ||
    request.mission.constraints.deniedEngines.includes(engine.id) ||
    request.environment.skillCompatibility.some(
      (entry) =>
        !entry.engineNeutral &&
        !entry.compatibleEngines.some(
          (candidate) =>
            candidate.id === engine.id &&
            candidate.versions.includes(engine.version) &&
            candidate.adapterVersions.includes(engine.adapterVersion),
        ),
    )
  ) {
    findings.push(
      deterministicFinding(
        request,
        "unsupported_engine",
        "blocking",
        `Engine ${engine.id}@${engine.version} with adapter ${engine.adapterVersion} is unsupported by the exact plan context.`,
        [],
        output.skillReferences,
      ),
    );
  }

  const exactCompatibility = new Map(
    request.environment.skillCompatibility.map((entry) => [
      `${entry.skillId}\u0000${entry.version}\u0000${entry.contentDigest}`,
      entry,
    ]),
  );
  const immature = output.skillReferences.filter((reference) => {
    const entry = exactCompatibility.get(
      `${reference.skillId}\u0000${reference.version}\u0000${reference.contentDigest}`,
    );
    return (
      !entry ||
      !entry.compatible ||
      !atLeast(
        entry.knowledgeMaturity,
        request.requirements.minimumKnowledgeMaturity,
        knowledgeMaturityOrder,
      ) ||
      !atLeast(
        entry.capabilityMaturity,
        request.requirements.minimumCapabilityMaturity,
        capabilityMaturityOrder,
      )
    );
  });
  if (immature.length > 0) {
    findings.push(
      deterministicFinding(
        request,
        "unsupported_maturity",
        "blocking",
        `The plan overclaims maturity for: ${immature
          .map((reference) => `${reference.skillId}@${reference.version}`)
          .join(", ")}.`,
        [],
        immature,
      ),
    );
  }

  const costReasons: string[] = [];
  if (
    request.mission.constraints.maximumWallTimeSeconds !== undefined &&
    output.resourceEstimate.wallTimeSeconds > request.mission.constraints.maximumWallTimeSeconds
  ) {
    costReasons.push("wall-time ceiling");
  }
  if (
    request.mission.constraints.maximumCost !== undefined &&
    output.resourceEstimate.cost > request.mission.constraints.maximumCost
  ) {
    costReasons.push("cost ceiling");
  }
  if (
    request.requirements.maximumCpuCoreHours !== undefined &&
    output.resourceEstimate.cpuCoreHours > request.requirements.maximumCpuCoreHours
  ) {
    costReasons.push("CPU core-hour ceiling");
  }
  if (costReasons.length > 0) {
    findings.push(
      deterministicFinding(
        request,
        "excessive_cost",
        "blocking",
        `The resource estimate exceeds the ${costReasons.join(", ")}.`,
      ),
    );
  }

  if (
    protocol &&
    (protocol.objectiveId !== request.mission.objective.id ||
      protocol.system.evidenceId !== request.mission.objective.system.evidenceId ||
      protocol.system.contentDigest !== request.mission.objective.system.contentDigest ||
      (request.mission.objective.system.charge !== undefined &&
        protocol.charge !== request.mission.objective.system.charge) ||
      (request.mission.objective.system.multiplicity !== undefined &&
        protocol.multiplicity !== request.mission.objective.system.multiplicity))
  ) {
    findings.push(
      deterministicFinding(
        request,
        "silent_objective_change",
        "blocking",
        "The candidate changes an immutable objective or molecular-system field.",
      ),
    );
  }

  const contradictedAssumptions = new Set(
    request.evidence.flatMap((item) => item.contradictsAssumptionIds),
  );
  const contradictions = output.assumptions.filter((assumption) =>
    contradictedAssumptions.has(assumption.id),
  );
  if (contradictions.length > 0) {
    const evidenceRefs = request.evidence
      .filter((item) =>
        item.contradictsAssumptionIds.some((id) => contradictions.some((item) => item.id === id)),
      )
      .map((item) => item.id);
    findings.push(
      deterministicFinding(
        request,
        "contradictory_evidence",
        "blocking",
        `Evidence contradicts assumptions: ${contradictions.map((item) => item.id).join(", ")}.`,
        evidenceRefs,
      ),
    );
  }

  const unsafeDecisions = output.scientificDecisions.filter(
    (decision) =>
      (decision.riskClass >= 3 ||
        ["charge", "multiplicity", "method", "basis", "physical_model", "objective"].includes(
          decision.category,
        )) &&
      !decision.requiresApproval,
  );
  if (unsafeDecisions.length > 0) {
    findings.push(
      deterministicFinding(
        request,
        "unsafe_remediation",
        "blocking",
        `Material changes lack approval gates: ${unsafeDecisions
          .map((decision) => decision.id)
          .join(", ")}.`,
        unsafeDecisions.flatMap((decision) => decision.evidenceRefs),
        unsafeDecisions.flatMap((decision) => decision.skillRefs),
      ),
    );
  }

  const availableEvidenceKinds = new Set(request.evidence.flatMap((item) => item.kinds));
  const missingProvenanceKinds = request.requirements.requiredProvenanceKinds.filter(
    (kind) => !availableEvidenceKinds.has(kind),
  );
  const selectedSkillIds = new Set(output.skillReferences.map(skillIdentity));
  const protocolSkillRefs =
    protocol?.engineAgnosticSteps.flatMap((step) => step.sourceFragments).map(skillIdentity) ?? [];
  const provenanceInvalid =
    !protocol ||
    computeScientificProtocolDigest(protocol) !== protocol.protocolDigest ||
    protocolSkillRefs.some((identity) => !selectedSkillIds.has(identity));
  if (missingProvenanceKinds.length > 0 || provenanceInvalid) {
    findings.push(
      deterministicFinding(
        request,
        "missing_provenance",
        "blocking",
        `The plan cannot prove complete provenance${
          missingProvenanceKinds.length > 0
            ? `; missing kinds: ${missingProvenanceKinds.join(", ")}`
            : ""
        }.`,
        request.evidence.map((item) => item.id),
        output.skillReferences,
      ),
    );
  }

  return findings.sort((left, right) => left.code.localeCompare(right.code));
}

function criticModelSchema(
  request: ScientificCriticRequest,
): z.ZodType<ScientificCriticModelOutput> {
  const evidenceIds = new Set(request.evidence.map((item) => item.id));
  const skillIds = new Set(request.candidate.skillReferences.map(skillIdentity));
  return ScientificCriticModelOutputSchema.superRefine((output, context) => {
    for (const finding of output.findings) {
      if (finding.evidenceRefs.some((id) => !evidenceIds.has(id))) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["findings", finding.code, "evidenceRefs"],
          message: "Critic cited evidence outside the supplied review set",
        });
      }
      if (finding.skillRefs.some((reference) => !skillIds.has(skillIdentity(reference)))) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["findings", finding.code, "skillRefs"],
          message: "Critic cited a skill fragment outside the candidate plan",
        });
      }
    }
  }) as z.ZodType<ScientificCriticModelOutput>;
}

const criticInstruction = [
  "Act only as an independent scientific critic.",
  "Find defects and cite supplied evidence and exact skill fragments.",
  "You cannot edit the proposal, approve it, execute it, or hide a remediation in prose.",
  "Check charge, multiplicity, electronic-state alternatives, method applicability, conformers, numerical convergence, validation, engine/version, maturity, cost, objective preservation, contradictions, remediation safety, and provenance.",
  "Return concise structured findings only; never return hidden reasoning or credentials.",
].join(" ");

/**
 * The critic is structurally independent: it receives an immutable candidate snapshot and can
 * only emit findings. Deterministic checks remain available when no model is configured.
 */
export class ScientificCritic {
  constructor(private readonly gateway?: ModelGateway) {}

  async review(request: ScientificCriticRequest): Promise<ScientificCriticReview> {
    const findings = deterministicReview(request);
    let modelStatus: ScientificCriticReview["modelStatus"] = "not_requested";
    let modelInvocations: ModelInvocationRecord[] = [];

    if (this.gateway && request.gatewayBudget && request.timeoutMilliseconds) {
      const modelOutcome = await this.gateway.invoke({
        missionId: request.mission.id,
        planId: request.planId,
        ...(request.planningClaimId ? { planningClaimId: request.planningClaimId } : {}),
        role: "critic",
        task: "Independently review a scientific plan candidate",
        instruction: criticInstruction,
        context: request.context,
        contextDigest: request.contextDigest,
        input: {
          objective: request.mission.objective,
          constraints: request.mission.constraints,
          candidate: request.candidate,
          environment: request.environment,
          requirements: request.requirements,
          evidence: request.evidence,
        },
        outputSchemaName: "ScientificCriticModelOutput",
        outputSchemaVersion: ScientificCriticOutputVersion,
        outputSchema: criticModelSchema(request),
        budget: request.gatewayBudget,
        timeoutMilliseconds: request.timeoutMilliseconds,
        maximumRepairAttempts: request.maximumRepairAttempts,
        preferredIdentities: request.preferredIdentities,
        signal: request.signal,
        invocationJournal: request.invocationJournal,
      });
      modelStatus = modelOutcome.status;
      modelInvocations = modelOutcome.records;
      if (modelOutcome.status === "succeeded") {
        const existingCodes = new Set(findings.map((finding) => finding.code));
        for (const modelFinding of modelOutcome.output.findings) {
          if (existingCodes.has(modelFinding.code)) continue;
          findings.push(
            deterministicFinding(
              request,
              modelFinding.code,
              modelFinding.severity,
              modelFinding.summary,
              modelFinding.evidenceRefs,
              modelFinding.skillRefs,
            ),
          );
          existingCodes.add(modelFinding.code);
        }
        findings.sort((left, right) => left.code.localeCompare(right.code));
      }
    }

    const requiresNewPlanRevision = findings.some(
      (finding) => finding.severity === "error" || finding.severity === "blocking",
    );
    const review: ScientificCriticReview = {
      status: "reviewed",
      verdict: requiresNewPlanRevision ? "revise" : "acceptable",
      findings: Object.freeze([...findings]),
      requiresNewPlanRevision,
      modelStatus,
      modelInvocations: Object.freeze([...modelInvocations]),
    };
    return Object.freeze(review);
  }
}
