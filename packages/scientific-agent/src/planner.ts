import {
  ScientificAssumptionSchema,
  ScientificDecisionSchema,
  ScientificProtocolSchema,
  ScientificRiskClassSchema,
  SkillFragmentReferenceSchema,
  digestCanonical,
  type ResolvedSkillGraph,
  type ScientificMission,
  type ScientificPlan,
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
import { computeScientificProtocolDigest } from "./protocol-compiler";

export const ScientificPlannerOutputVersion = "eigengrid.scientific-planner-output/v1" as const;

export const ScientificDecisionCandidateSchema = z
  .object({
    id: z.string().min(1),
    category: ScientificDecisionSchema.shape.category,
    question: z.string().min(1),
    selectedOption: z.string().min(1).nullable(),
    alternatives: z.array(
      z.object({
        option: z.string().min(1),
        reasonNotSelected: z.string().min(1),
      }),
    ),
    rationale: z.string().min(1),
    skillRefs: z.array(SkillFragmentReferenceSchema),
    evidenceRefs: z.array(z.string().min(1)),
    riskClass: ScientificRiskClassSchema,
    requiresApproval: z.boolean(),
  })
  .strict();
export type ScientificDecisionCandidate = z.infer<typeof ScientificDecisionCandidateSchema>;

export const ScientificPlannerOutputSchema = z
  .object({
    schemaVersion: z.literal(ScientificPlannerOutputVersion),
    normalizedObjective: z.string().min(1),
    missingInputs: z.array(z.string().min(1)),
    assumptions: z.array(ScientificAssumptionSchema),
    candidateProtocol: ScientificProtocolSchema.nullable(),
    skillReferences: z.array(SkillFragmentReferenceSchema).min(1),
    scientificDecisions: z.array(ScientificDecisionCandidateSchema),
    alternatives: z.array(
      z.object({
        id: z.string().min(1),
        description: z.string().min(1),
        tradeoffs: z.array(z.string().min(1)),
      }),
    ),
    resourceEstimate: z
      .object({
        wallTimeSeconds: z.number().int().nonnegative(),
        cpuCoreHours: z.number().nonnegative(),
        cost: z.number().nonnegative(),
        basis: z.string().min(1),
      })
      .strict(),
    riskClassification: z
      .object({
        highestRiskClass: ScientificRiskClassSchema,
        reasons: z.array(z.string().min(1)),
      })
      .strict(),
    requiredApprovals: z.array(z.string().min(1)),
    validationGates: z.array(
      z
        .object({
          criterionId: z.string().min(1),
          description: z.string().min(1),
          requiredEvidenceKinds: z.array(z.string().min(1)),
        })
        .strict(),
    ),
    limitations: z.array(z.string().min(1)),
  })
  .strict();
export type ScientificPlannerOutput = z.infer<typeof ScientificPlannerOutputSchema>;

export interface ScientificPlannerRequest {
  mission: ScientificMission;
  planningClaimId?: string;
  resolvedSkillGraph: ResolvedSkillGraph;
  context: AssembledScientificContext;
  contextDigest: string;
  invocationBudget: ModelInvocationBudget;
  timeoutMilliseconds: number;
  maximumRepairAttempts?: number;
  preferredIdentities?: ModelProviderIdentity[];
  signal?: AbortSignal;
  invocationJournal?: ModelInvocationJournal;
}

function fragmentIdentity(reference: SkillFragmentReference): string {
  return digestCanonical(reference);
}

function plannerSchemaFor(request: ScientificPlannerRequest): z.ZodType<ScientificPlannerOutput> {
  const exactFragments = new Set(
    request.resolvedSkillGraph.selectedFragments.map(fragmentIdentity),
  );
  const requiredCriterionIds = new Set(
    request.mission.acceptanceCriteria
      .filter((criterion) => criterion.required)
      .map((criterion) => criterion.id),
  );
  return ScientificPlannerOutputSchema.superRefine((output, context) => {
    if (output.missingInputs.length === 0 && output.candidateProtocol === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["candidateProtocol"],
        message: "A complete input set requires a candidate protocol",
      });
    }
    if (output.missingInputs.length > 0 && output.candidateProtocol !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["candidateProtocol"],
        message: "A protocol cannot be asserted while mandatory inputs remain unresolved",
      });
    }
    for (const reference of output.skillReferences) {
      if (!exactFragments.has(fragmentIdentity(reference))) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["skillReferences"],
          message: `Skill fragment ${reference.fragmentId} is outside the resolved graph`,
        });
      }
    }
    const protocol = output.candidateProtocol;
    if (protocol) {
      if (protocol.objectiveId !== request.mission.objective.id) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["candidateProtocol", "objectiveId"],
          message: "Candidate protocol changed the objective identity",
        });
      }
      if (
        protocol.system.evidenceId !== request.mission.objective.system.evidenceId ||
        protocol.system.contentDigest !== request.mission.objective.system.contentDigest
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["candidateProtocol", "system"],
          message: "Candidate protocol changed the molecular system",
        });
      }
      if (protocol.skillGraphDigest !== request.resolvedSkillGraph.graphDigest) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["candidateProtocol", "skillGraphDigest"],
          message: "Candidate protocol does not cite the exact resolved skill graph",
        });
      }
      if (computeScientificProtocolDigest(protocol) !== protocol.protocolDigest) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["candidateProtocol", "protocolDigest"],
          message: "Candidate protocol digest is invalid",
        });
      }
      for (const step of protocol.engineAgnosticSteps) {
        for (const reference of step.sourceFragments) {
          if (!exactFragments.has(fragmentIdentity(reference))) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["candidateProtocol", "engineAgnosticSteps"],
              message: `Protocol step ${step.id} has unresolvable fragment attribution`,
            });
          }
        }
      }
    }
    const validationIds = new Set(output.validationGates.map((gate) => gate.criterionId));
    for (const criterionId of requiredCriterionIds) {
      if (!validationIds.has(criterionId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["validationGates"],
          message: `Required acceptance criterion ${criterionId} has no validation gate`,
        });
      }
    }
    const maximumDeclaredRisk = Math.max(
      0,
      ...output.scientificDecisions.map((decision) => decision.riskClass),
      ...(output.candidateProtocol?.engineAgnosticSteps.map((step) => step.riskClass) ?? []),
    );
    if (output.riskClassification.highestRiskClass < maximumDeclaredRisk) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["riskClassification", "highestRiskClass"],
        message: "Risk classification understates a protocol step or decision",
      });
    }
    for (const decision of output.scientificDecisions) {
      if (decision.riskClass >= 3 && !decision.requiresApproval) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["scientificDecisions", decision.id],
          message: "Scientifically material decisions must require approval",
        });
      }
    }
  }) as z.ZodType<ScientificPlannerOutput>;
}

const plannerInstruction = [
  "Act only as EigenGrid's scientific planner.",
  "Return the requested structured proposal; do not execute, approve, or mutate durable state.",
  "Preserve the objective, molecular system, charge, multiplicity, method, basis, and physical model.",
  "Use only the exact skill fragments and evidence in the supplied authority-ordered context.",
  "When a mandatory input is missing, report it and return no candidate protocol.",
  "Expose concise decisions, alternatives, risks, approvals, validation gates, and limitations.",
  "Never return hidden reasoning, credentials, shell commands, SQL, runner calls, or scheduler calls.",
].join(" ");

/** Structured planning is an ephemeral model computation; persistence remains a MissionService job. */
export class ScientificPlanner {
  constructor(private readonly gateway: ModelGateway) {}

  plan(request: ScientificPlannerRequest): Promise<ModelGatewayOutcome<ScientificPlannerOutput>> {
    return this.gateway.invoke({
      missionId: request.mission.id,
      ...(request.planningClaimId ? { planningClaimId: request.planningClaimId } : {}),
      role: "planner",
      task: "Create a scientific plan candidate for the durable mission objective",
      instruction: plannerInstruction,
      context: request.context,
      contextDigest: request.contextDigest,
      input: {
        objective: request.mission.objective,
        constraints: request.mission.constraints,
        assumptions: request.mission.assumptions,
        acceptanceCriteria: request.mission.acceptanceCriteria,
        budgetId: request.mission.budgetId,
        policyProfile: request.mission.policyProfile,
        resolvedSkillGraph: request.resolvedSkillGraph,
      },
      outputSchemaName: "ScientificPlannerOutput",
      outputSchemaVersion: ScientificPlannerOutputVersion,
      outputSchema: plannerSchemaFor(request),
      budget: request.invocationBudget,
      timeoutMilliseconds: request.timeoutMilliseconds,
      maximumRepairAttempts: request.maximumRepairAttempts,
      preferredIdentities: request.preferredIdentities,
      signal: request.signal,
      invocationJournal: request.invocationJournal,
    });
  }
}

export function computeScientificPlanDigest(
  plan: Omit<ScientificPlan, "planDigest"> | ScientificPlan,
): string {
  const {
    planDigest: _digest,
    status: _status,
    updatedAt: _updatedAt,
    ...payload
  } = plan as ScientificPlan;
  return digestCanonical(payload);
}
