import {
  ApprovalRequestSchema,
  ApprovalResponseSchema,
  EvidenceReferenceSchema,
  ScientificDecisionSchema,
  ScientificPlanSchema,
  digestCanonical,
  type ActorIdentity,
  type ApprovalRequest,
  type EvidenceReference,
  type MissionBudget,
  type ScientificDecision,
  type ScientificMission,
  type ScientificPlan,
  type WorkUnit,
} from "@eigengrid/scientific-schema";
import { ScientificRevisionConflictError, ScientificStore } from "@eigengrid/mission-runtime";
import {
  ScientificSkillRegistry,
  graphWithSelectedFragments,
  resolveScientificSkillGraph,
  selectProgressiveSkillContext,
} from "@eigengrid/scientific-skills";
import { assembleScientificContext, type ContextEvidenceSummary } from "./context-assembler";
import {
  ScientificCritic,
  type CriticEvidenceAssertion,
  type ScientificCriticRequirements,
  type ScientificCriticReview,
} from "./critic";
import type { ModelGatewayOutcome, ModelInvocationBudget } from "./model-gateway";
import { randomUUID } from "node:crypto";
import {
  ScientificPlanner,
  computeScientificPlanDigest,
  type ScientificPlannerOutput,
} from "./planner";
import {
  compileScientificProtocol,
  type CompiledWorkUnitDag,
  type CompilerPolicyProfile,
  type EnvironmentCapabilityProfile,
} from "./protocol-compiler";
import type { ModelInvocationJournal } from "./model-gateway";

export interface ScientificMissionServiceOptions {
  store: ScientificStore;
  skillRegistry?: ScientificSkillRegistry;
  planner?: ScientificPlanner;
  critic?: ScientificCritic;
  serviceActor?: ActorIdentity;
  now?: () => Date;
  planningLeaseMilliseconds?: number;
  planningHeartbeatMilliseconds?: number;
}

export interface CreateDurableScientificMissionInput {
  mission: ScientificMission;
  budget: MissionBudget;
  objectiveEvidence: EvidenceReference[];
}

/** Authenticated production route. projectId is an explicit selection, never
 * standalone authority; ScientificStore validates it against PostgreSQL. */
export interface CreateMissionInProjectInput extends CreateDurableScientificMissionInput {
  authenticatedActor: ActorIdentity;
  projectId: string;
}

export interface PlanDurableScientificMissionInput {
  missionId: string;
  requestedSkillIds: string[];
  includeOptionalSkills?: boolean;
  domains: string[];
  skillQuery: string;
  skillSelectionReason: string;
  environment: EnvironmentCapabilityProfile;
  compilerPolicy: CompilerPolicyProfile;
  criticRequirements: ScientificCriticRequirements;
  criticEvidence: CriticEvidenceAssertion[];
  evidenceSummaries?: ContextEvidenceSummary[];
  contextMaximumBytes: number;
  plannerBudget: ModelInvocationBudget;
  criticBudget?: ModelInvocationBudget;
  timeoutMilliseconds: number;
  maximumRepairAttempts?: number;
  approvalRequestedBy: ActorIdentity;
  approvalExpiresAt?: string;
  signal?: AbortSignal;
}

/** Production planning path for a previously, atomically bound mission. */
export interface PlanMissionInProjectInput extends PlanDurableScientificMissionInput {
  authenticatedActor: ActorIdentity;
  projectId: string;
}

export type PlanDurableScientificMissionResult =
  | {
      status: "awaiting_input";
      missingInputs: string[];
      modelOutcome: ModelGatewayOutcome<ScientificPlannerOutput>;
    }
  | {
      status:
        | "model_unavailable"
        | "model_invalid"
        | "model_budget_exceeded"
        | "model_ambiguous"
        | "aborted";
      modelOutcome: ModelGatewayOutcome<ScientificPlannerOutput>;
    }
  | {
      status: "planning_in_progress";
      message: string;
    }
  | {
      status: "revision_required";
      plan: ScientificPlan;
      decisions: ScientificDecision[];
      critique: ScientificCriticReview;
    }
  | {
      status: "awaiting_approval";
      mission: ScientificMission;
      plan: ScientificPlan;
      decisions: ScientificDecision[];
      critique: ScientificCriticReview;
      approval: ApprovalRequest;
    };

export interface DecidePlanApprovalInput {
  missionId: string;
  approvalRequestId: string;
  decision: "approved" | "rejected";
  actor: ActorIdentity;
  reason: string;
  currentPolicyDigest: string;
  authorizedRoles: string[];
  decidedAt?: string;
}

export interface ImportPlanInProjectInput {
  authenticatedActor: ActorIdentity;
  projectId: string;
  plan: ScientificPlan;
  decisions: ScientificDecision[];
  currentPolicyDigest: string;
  minimumApprovalRole: string;
  approvalExpiresAt?: string;
}

export interface DecidePlanApprovalInProjectInput extends DecidePlanApprovalInput {
  authenticatedActor: ActorIdentity;
  projectId: string;
  expectedSubjectVersion: number;
  expectedSubjectRevision: number;
  expectedPayloadDigest: string;
  expectedPolicyDigest: string;
}

export interface CompileApprovedScientificPlanInput {
  missionId: string;
  planId: string;
  compilerPolicy: CompilerPolicyProfile;
  environment: EnvironmentCapabilityProfile;
  actor?: ActorIdentity;
  at?: string;
}

export interface CompileApprovedPlanInProjectInput extends CompileApprovedScientificPlanInput {
  authenticatedActor: ActorIdentity;
  projectId: string;
}

export interface StartExecutionInProjectInput {
  missionId: string;
  authenticatedActor: ActorIdentity;
  projectId: string;
  at?: string;
}

const defaultServiceActor: ActorIdentity = {
  id: "eigengrid-scientific-mission-service",
  kind: "service",
  role: "scientific-mission-owner",
  displayName: "EigenGrid Scientific Mission Service",
};

const reusableCompiledMissionStates = new Set<ScientificMission["state"]>([
  "ready",
  "executing",
  "observing",
  "diagnosing",
  "validating",
  "completed",
  "paused",
  "blocked",
]);

function iso(now: () => Date): string {
  const value = now();
  if (!Number.isFinite(value.getTime())) throw new TypeError("Mission service clock is invalid");
  return value.toISOString();
}

function compiledWorkUnitDefinition(workUnit: WorkUnit): Record<string, unknown> {
  const {
    state: _state,
    revision: _revision,
    claimOwner: _claimOwner,
    claimExpiresAt: _claimExpiresAt,
    jobId: _jobId,
    attemptId: _attemptId,
    updatedAt: _updatedAt,
    ...definition
  } = workUnit;
  return definition;
}

function latestPlan(plans: readonly ScientificPlan[]): ScientificPlan | undefined {
  return [...plans].sort((left, right) => right.version - left.version)[0];
}

function planRiskRecords(
  missionId: string,
  version: number,
  output: ScientificPlannerOutput,
): ScientificPlan["risks"] {
  return output.riskClassification.reasons.map((description, index) => ({
    id: `risk-${digestCanonical({ missionId, version, description, index }).slice(0, 24)}`,
    riskClass: output.riskClassification.highestRiskClass,
    description,
    mitigation:
      "Bind the exact plan revision to human approval and enforce its declared validation gates.",
  }));
}

function evidenceSummary(reference: EvidenceReference): ContextEvidenceSummary {
  return {
    reference,
    summary: `${reference.kind} evidence at ${reference.uri}; immutable digest ${reference.contentDigest}`,
  };
}

function plannerFailureStatus(
  outcome: Exclude<ModelGatewayOutcome<ScientificPlannerOutput>, { status: "succeeded" }>,
): "model_unavailable" | "model_invalid" | "model_budget_exceeded" | "model_ambiguous" | "aborted" {
  return outcome.status === "unavailable"
    ? "model_unavailable"
    : outcome.status === "invalid_output"
      ? "model_invalid"
      : outcome.status === "budget_exceeded"
        ? "model_budget_exceeded"
        : outcome.status === "ambiguous"
          ? "model_ambiguous"
          : "aborted";
}

/**
 * Durable application service for objective, planning, critique, exact approval,
 * and deterministic protocol compilation. Models only return proposals; every
 * authoritative transition and record is written through ScientificStore.
 */
export class ScientificMissionService {
  private readonly store: ScientificStore;
  private readonly skillRegistry?: ScientificSkillRegistry;
  private readonly planner?: ScientificPlanner;
  private readonly critic?: ScientificCritic;
  private readonly serviceActor: ActorIdentity;
  private readonly now: () => Date;
  private readonly planningLeaseMilliseconds: number;
  private readonly planningHeartbeatMilliseconds: number;

  constructor(options: ScientificMissionServiceOptions) {
    this.store = options.store;
    this.skillRegistry = options.skillRegistry;
    this.planner = options.planner;
    this.critic = options.critic;
    this.serviceActor = options.serviceActor ?? defaultServiceActor;
    this.now = options.now ?? (() => new Date());
    this.planningLeaseMilliseconds = options.planningLeaseMilliseconds ?? 60_000;
    this.planningHeartbeatMilliseconds =
      options.planningHeartbeatMilliseconds ??
      Math.max(1, Math.floor(this.planningLeaseMilliseconds / 2));
    if (
      !Number.isSafeInteger(this.planningLeaseMilliseconds) ||
      this.planningLeaseMilliseconds <= 0
    ) {
      throw new TypeError("planningLeaseMilliseconds must be a positive safe integer");
    }
    if (
      !Number.isSafeInteger(this.planningHeartbeatMilliseconds) ||
      this.planningHeartbeatMilliseconds <= 0 ||
      this.planningHeartbeatMilliseconds >= this.planningLeaseMilliseconds
    ) {
      throw new TypeError(
        "planningHeartbeatMilliseconds must be a positive safe integer below planningLeaseMilliseconds",
      );
    }
  }

  async createMission(input: CreateDurableScientificMissionInput): Promise<ScientificMission> {
    this.assertObjectiveEvidence(input);
    const mission = await this.store.createMission(input.mission, input.budget);
    for (const evidence of input.objectiveEvidence) await this.store.createEvidence(evidence);
    return mission;
  }

  /**
   * The only production multi-user creation route. It intentionally does not
   * delegate to legacy createMission, because the association must be present
   * atomically before a production caller can plan or start the mission.
   */
  async createMissionInProject(input: CreateMissionInProjectInput): Promise<ScientificMission> {
    const actor = this.requireProductionHuman(input.authenticatedActor);
    if (input.mission.requestedBy.kind !== "human" || input.mission.requestedBy.id !== actor.id) {
      throw new Error("Production mission requester must equal the authenticated human actor");
    }
    this.assertObjectiveEvidence(input);
    const mission = await this.store.createMissionInProject({
      mission: input.mission,
      budget: input.budget,
      projectId: input.projectId,
      ownerUserId: actor.id,
    });
    for (const evidence of input.objectiveEvidence) await this.store.createEvidence(evidence);
    return mission;
  }

  async planMissionInProject(
    input: PlanMissionInProjectInput,
  ): Promise<PlanDurableScientificMissionResult> {
    const actor = this.requireProductionHuman(input.authenticatedActor);
    if (input.approvalRequestedBy.kind !== "human" || input.approvalRequestedBy.id !== actor.id) {
      throw new Error(
        "Production plan approval requester must equal the authenticated human actor",
      );
    }
    await this.store.assertProductionMissionPlanningAccess({
      missionId: input.missionId,
      projectId: input.projectId,
      ownerUserId: actor.id,
    });
    return this.planMission(input);
  }

  /** Import a complete human proposal without invoking a model or granting approval. */
  async importPlanInProject(input: ImportPlanInProjectInput): Promise<ApprovalRequest> {
    const actor = this.requireProductionHuman(input.authenticatedActor);
    const plan = ScientificPlanSchema.parse(input.plan);
    if (plan.status !== "under_review" || plan.revision !== 1 || plan.missingInputs.length) {
      throw new Error("Imported plans must be complete, under review, and at revision 1");
    }
    if (
      plan.requiredApprovals.length !== 1 ||
      plan.requiredApprovals[0] !== input.minimumApprovalRole
    ) {
      throw new Error("Imported plan approval role does not match current policy");
    }
    const decisions = input.decisions.map((value) => ScientificDecisionSchema.parse(value));
    if (
      decisions.some(
        (decision) => decision.missionId !== plan.missionId || decision.planId !== plan.id,
      ) ||
      new Set(decisions.map((decision) => decision.id)).size !== decisions.length ||
      digestCanonical([...plan.protocol.decisions].sort()) !==
        digestCanonical(decisions.map((decision) => decision.id).sort())
    ) {
      throw new Error("Imported decisions must exactly cover the plan in the same mission");
    }
    await this.store.assertProductionMissionPlanningAccess({
      missionId: plan.missionId,
      projectId: input.projectId,
      ownerUserId: actor.id,
    });
    const at = iso(this.now);
    if (input.approvalExpiresAt && Date.parse(input.approvalExpiresAt) <= Date.parse(at)) {
      throw new Error("Imported plan approval expiration must be in the future");
    }
    let mission = await this.requireMission(plan.missionId);
    const persisted = await this.store.getPlan(plan.id);
    if (persisted && persisted.planDigest !== plan.planDigest)
      throw new Error("Imported plan differs from its persisted revision");
    if (!persisted) {
      mission = await this.ensurePlanningState(mission, at);
      const plans = await this.store.listPlans(mission.id);
      const parent = latestPlan(plans);
      if (plan.version !== (parent?.version ?? 0) + 1 || plan.parentPlanId !== parent?.id) {
        throw new Error("Imported plan version or parent is stale");
      }
      await this.store.createPlan(plan);
    }
    for (const decision of decisions) await this.store.createDecision(decision);
    if (mission.state === "planning" || mission.state === "replanning") {
      mission = await this.store.transitionMission({
        missionId: mission.id,
        expectedRevision: mission.revision,
        to: "awaiting_approval",
        reason: `human_candidate_imported:${plan.id}`,
        actor,
        at,
      });
    }
    const id = `approval-${digestCanonical({ planId: plan.id, version: plan.version, revision: plan.revision, planDigest: plan.planDigest, policyDigest: input.currentPolicyDigest }).slice(0, 32)}`;
    const existing = (await this.store.getMissionProvenance(mission.id)).approvals.find(
      (request) => request.id === id,
    );
    if (existing) {
      if (
        existing.requestedFromRole !== input.minimumApprovalRole ||
        !["pending", "approved"].includes(existing.state) ||
        (existing.expiresAt && Date.parse(existing.expiresAt) <= Date.parse(at))
      ) {
        throw new Error(
          "Existing approval is no longer usable; submit a new plan revision for review",
        );
      }
      return existing;
    }
    return this.store.createApprovalRequest(
      ApprovalRequestSchema.parse({
        id,
        missionId: mission.id,
        subjectType: "plan",
        subjectId: plan.id,
        subjectVersion: plan.version,
        subjectRevision: plan.revision,
        state: "pending",
        requestedFromRole: input.minimumApprovalRole,
        payloadDigest: plan.planDigest,
        policyDigest: input.currentPolicyDigest,
        editableFields: [],
        requestedBy: actor,
        requestedAt: at,
        ...(input.approvalExpiresAt ? { expiresAt: input.approvalExpiresAt } : {}),
      }),
    );
  }

  async decidePlanApprovalInProject(
    input: DecidePlanApprovalInProjectInput,
  ): Promise<ApprovalRequest> {
    const actor = this.requireProductionHuman(input.authenticatedActor);
    await this.store.assertProductionMissionPlanningAccess({
      missionId: input.missionId,
      projectId: input.projectId,
      ownerUserId: actor.id,
    });
    const request = (await this.store.getMissionProvenance(input.missionId)).approvals.find(
      (value) => value.id === input.approvalRequestId,
    );
    if (
      !request ||
      request.subjectType !== "plan" ||
      request.subjectVersion !== input.expectedSubjectVersion ||
      request.subjectRevision !== input.expectedSubjectRevision ||
      request.payloadDigest !== input.expectedPayloadDigest ||
      request.policyDigest !== input.expectedPolicyDigest
    ) {
      throw new Error("Approval does not match the exact reviewed plan revision and digests");
    }
    return this.decidePlanApproval({ ...input, actor });
  }

  async compileApprovedPlanInProject(
    input: CompileApprovedPlanInProjectInput,
  ): Promise<CompiledWorkUnitDag> {
    const actor = this.requireProductionHuman(input.authenticatedActor);
    await this.store.assertProductionMissionPlanningAccess({
      missionId: input.missionId,
      projectId: input.projectId,
      ownerUserId: actor.id,
    });
    return this.compileApprovedPlan({ ...input, actor });
  }

  async startExecutionInProject(input: StartExecutionInProjectInput): Promise<ScientificMission> {
    const actor = this.requireProductionHuman(input.authenticatedActor);
    await this.store.assertProductionMissionPlanningAccess({
      missionId: input.missionId,
      projectId: input.projectId,
      ownerUserId: actor.id,
    });
    return this.startExecution(input.missionId, actor, input.at ?? iso(this.now));
  }

  private assertObjectiveEvidence(input: CreateDurableScientificMissionInput): void {
    const evidenceIds = new Set<string>();
    for (const evidence of input.objectiveEvidence) {
      if (evidence.missionId !== input.mission.id) {
        throw new Error(`Evidence ${evidence.id} belongs to a different mission`);
      }
      if (evidenceIds.has(evidence.id)) {
        throw new Error(`Objective evidence ${evidence.id} is duplicated`);
      }
      evidenceIds.add(evidence.id);
    }
    const systemEvidence = input.objectiveEvidence.find(
      (evidence) => evidence.id === input.mission.objective.system.evidenceId,
    );
    if (!systemEvidence) {
      throw new Error(
        `Objective system evidence ${input.mission.objective.system.evidenceId} is required`,
      );
    }
    if (
      !systemEvidence.immutable ||
      systemEvidence.contentDigest !== input.mission.objective.system.contentDigest
    ) {
      throw new Error("Objective molecular-system evidence must be immutable and digest-exact");
    }
  }

  async planMission(
    input: PlanDurableScientificMissionInput,
  ): Promise<PlanDurableScientificMissionResult> {
    if (!this.skillRegistry || !this.planner || !this.critic) {
      throw new Error(
        "Model planning requires a configured skill registry, planner, and critic; complete candidate import does not",
      );
    }
    let mission = await this.requireMission(input.missionId);
    const at = iso(this.now);
    mission = await this.ensurePlanningState(mission, at);
    const provenance = await this.store.getMissionProvenance(mission.id);
    const parent = latestPlan(provenance.plans);
    const version = (parent?.version ?? 0) + 1;
    const planningOwnerId = `planning-owner-${randomUUID()}`;
    const planningClaim = await this.store.acquirePlanningClaim({
      missionId: mission.id,
      expectedMissionRevision: mission.revision,
      ...(parent ? { parentPlanId: parent.id } : {}),
      proposedNextVersion: version,
      ownerId: planningOwnerId,
      now: at,
      expiresAt: new Date(Date.parse(at) + this.planningLeaseMilliseconds).toISOString(),
    });
    if (!planningClaim.claimed) {
      return {
        status: "planning_in_progress",
        message: planningClaim.message,
      };
    }
    let planningCompletion: "completed" | "released" = "released";
    let planningReleaseReason = "planning_did_not_persist_a_plan";
    const invocationJournal: ModelInvocationJournal = {
      begin: (intent) => this.store.beginModelInvocation(intent),
      observe: (observation) => this.store.observeModelInvocation(observation),
    };
    const planningController = new AbortController();
    const abortPlanning = (): void => {
      if (!planningController.signal.aborted) {
        planningController.abort(input.signal?.reason ?? new Error("Planning claim lost"));
      }
    };
    if (input.signal?.aborted) abortPlanning();
    else input.signal?.addEventListener("abort", abortPlanning, { once: true });
    let planningClaimLost = false;
    let planningHeartbeatRunning = false;
    let planningHeartbeatPromise: Promise<void> | undefined;
    const renewPlanningClaim = async (): Promise<void> => {
      const renewedAt = iso(this.now);
      await this.store.renewPlanningClaim({
        claimId: planningClaim.claim.id,
        missionId: mission.id,
        ownerId: planningOwnerId,
        now: renewedAt,
        expiresAt: new Date(Date.parse(renewedAt) + this.planningLeaseMilliseconds).toISOString(),
      });
    };
    const heartbeat = async (): Promise<void> => {
      if (planningHeartbeatRunning || planningController.signal.aborted) return;
      planningHeartbeatRunning = true;
      try {
        await renewPlanningClaim();
      } catch (error) {
        planningClaimLost = true;
        abortPlanning();
        void error;
      } finally {
        planningHeartbeatRunning = false;
      }
    };
    const planningHeartbeatTimer = setInterval(() => {
      planningHeartbeatPromise = heartbeat();
    }, this.planningHeartbeatMilliseconds);

    try {
      const resolved = resolveScientificSkillGraph(this.skillRegistry, {
        requested: [...new Set(input.requestedSkillIds)].sort(),
        includeOptional: input.includeOptionalSkills,
        missionId: mission.id,
        engine: {
          id: input.environment.selectedEngine.id,
          version: input.environment.selectedEngine.version,
        },
        domains: [...new Set(input.domains)].sort(),
        minimumKnowledgeMaturity: input.compilerPolicy.minimumKnowledgeMaturity,
        requiredCapability: input.compilerPolicy.minimumCapabilityMaturity,
        resolvedAt: at,
        environmentDigest: input.environment.environmentDigest,
      });
      const skillContext = selectProgressiveSkillContext(resolved, {
        query: input.skillQuery,
        reason: input.skillSelectionReason,
        assetKinds: [
          "summary",
          "concepts",
          "decision_rules",
          "protocols",
          "diagnostics",
          "validation",
        ],
        maxFragments: 32,
        maxCharacters: Math.max(8_000, Math.floor(input.contextMaximumBytes * 0.65)),
      });
      const skillResolution = graphWithSelectedFragments(resolved.graph, skillContext);

      const skillEvidence: EvidenceReference[] = skillResolution.selectedFragments.map((fragment) =>
        EvidenceReferenceSchema.parse({
          id: `evidence-skill-${digestCanonical({ missionId: mission.id, fragment }).slice(0, 24)}`,
          missionId: mission.id,
          kind: "skill_fragment",
          uri: `eigengrid-skill://${fragment.skillId}@${fragment.version}/${fragment.relativePath}#${fragment.selector}`,
          contentDigest: fragment.fragmentDigest,
          immutable: true,
          sourceId: skillResolution.id,
          createdAt: at,
        }),
      );
      for (const evidence of skillEvidence) await this.store.createEvidence(evidence);

      const current = await this.store.getMissionProvenance(mission.id);
      const evidence = input.evidenceSummaries ?? current.evidence.map(evidenceSummary);
      const assembled = assembleScientificContext({
        mission,
        policyProfile: input.compilerPolicy,
        budget: current.budget,
        scope: "molecular-electronic-structure",
        skillFragments: skillContext.fragments.map((fragment) => ({
          reference: fragment.reference,
          content: fragment.content,
        })),
        evidence,
        contradictions: [],
        unresolvedQuestions: [],
        maximumBytes: input.contextMaximumBytes,
      });
      if (assembled.status !== "assembled") {
        throw new Error(
          `Mandatory scientific context requires ${assembled.requiredBytes} bytes, limit ${assembled.maximumBytes}`,
        );
      }

      const availableModelTokens = Math.max(
        0,
        current.budget.limits.modelTokens - current.budget.consumed.modelTokens,
      );
      const availableModelCost = Math.max(
        0,
        current.budget.limits.cost - current.budget.consumed.cost,
      );
      const plannerBudget: ModelInvocationBudget = {
        ...input.plannerBudget,
        maximumInputTokens: Math.min(input.plannerBudget.maximumInputTokens, availableModelTokens),
        maximumOutputTokens: Math.min(
          input.plannerBudget.maximumOutputTokens,
          availableModelTokens,
        ),
        maximumTotalTokens: Math.min(input.plannerBudget.maximumTotalTokens, availableModelTokens),
        maximumCost: Math.min(input.plannerBudget.maximumCost, availableModelCost),
      };

      const plannerOutcome = await this.planner.plan({
        mission,
        planningClaimId: planningClaim.claim.id,
        resolvedSkillGraph: skillResolution,
        context: assembled.context,
        contextDigest: assembled.contextDigest,
        invocationBudget: plannerBudget,
        timeoutMilliseconds: input.timeoutMilliseconds,
        maximumRepairAttempts: input.maximumRepairAttempts,
        signal: planningController.signal,
        invocationJournal,
      });
      for (const record of plannerOutcome.records) await this.store.createModelInvocation(record);
      if (plannerOutcome.status !== "succeeded") {
        return { status: plannerFailureStatus(plannerOutcome), modelOutcome: plannerOutcome };
      }
      if (
        plannerOutcome.output.missingInputs.length > 0 ||
        !plannerOutcome.output.candidateProtocol
      ) {
        return {
          status: "awaiting_input",
          missingInputs: plannerOutcome.output.missingInputs,
          modelOutcome: plannerOutcome,
        };
      }
      const unresolvedDecisions = plannerOutcome.output.scientificDecisions.filter(
        (decision) => decision.selectedOption === null,
      );
      if (unresolvedDecisions.length > 0) {
        return {
          status: "awaiting_input",
          missingInputs: unresolvedDecisions.map((decision) => decision.question),
          modelOutcome: plannerOutcome,
        };
      }
      if (
        plannerOutcome.output.requiredApprovals.length !== 1 ||
        plannerOutcome.output.requiredApprovals[0] !== input.compilerPolicy.minimumApprovalRole
      ) {
        throw new Error(
          "Scientific planner approval roles do not match the executable single-role alpha policy",
        );
      }

      const planId = `plan-${digestCanonical({
        missionId: mission.id,
        version,
        graphDigest: skillResolution.graphDigest,
        protocolDigest: plannerOutcome.output.candidateProtocol.protocolDigest,
      }).slice(0, 32)}`;
      const planWithoutDigest = {
        id: planId,
        missionId: mission.id,
        version,
        revision: 1,
        status: "under_review" as const,
        normalizedObjective: plannerOutcome.output.normalizedObjective,
        missingInputs: plannerOutcome.output.missingInputs,
        assumptions: plannerOutcome.output.assumptions,
        skillResolution,
        protocol: plannerOutcome.output.candidateProtocol,
        alternatives: plannerOutcome.output.alternatives.map((alternative) => ({
          id: alternative.id,
          description: `${alternative.description} Tradeoffs: ${alternative.tradeoffs.join("; ")}`,
        })),
        risks: planRiskRecords(mission.id, version, plannerOutcome.output),
        estimatedCost: {
          wallTimeSeconds: plannerOutcome.output.resourceEstimate.wallTimeSeconds,
          cpuCoreHours: plannerOutcome.output.resourceEstimate.cpuCoreHours,
          cost: plannerOutcome.output.resourceEstimate.cost,
        },
        requiredApprovals: plannerOutcome.output.requiredApprovals,
        validationGates: plannerOutcome.output.validationGates.map((gate) => gate.criterionId),
        limitations: plannerOutcome.output.limitations,
        createdBy: this.serviceActor,
        ...(parent ? { parentPlanId: parent.id } : {}),
        createdAt: at,
        updatedAt: at,
      };
      const plan = ScientificPlanSchema.parse({
        ...planWithoutDigest,
        planDigest: computeScientificPlanDigest(planWithoutDigest as ScientificPlan),
      });
      if (planningHeartbeatPromise) await planningHeartbeatPromise;
      await renewPlanningClaim();
      if (planningClaimLost || planningController.signal.aborted) {
        throw new Error("Planning claim was lost before plan persistence");
      }
      await this.store.createPlan(plan);
      planningCompletion = "completed";
      planningReleaseReason = `plan_persisted:${plan.id}`;
      if (parent && ["draft", "under_review", "approved"].includes(parent.status)) {
        await this.store.transitionPlan({
          planId: parent.id,
          expectedRevision: parent.revision,
          from: parent.status,
          to: "superseded",
          at,
        });
      }

      const decisions: ScientificDecision[] = [];
      for (const candidate of plannerOutcome.output.scientificDecisions) {
        if (candidate.selectedOption === null) {
          throw new Error(`Decision ${candidate.id} unexpectedly became unresolved`);
        }
        const decision = ScientificDecisionSchema.parse({
          ...candidate,
          missionId: mission.id,
          planId: plan.id,
          selectedOption: candidate.selectedOption,
          confidence: {
            level: "medium",
            basis: "Structured planner proposal constrained by exact skill and evidence references",
          },
          actor: this.serviceActor,
          createdAt: at,
        });
        decisions.push(await this.store.createDecision(decision));
      }

      const critique = await this.critic.review({
        mission,
        planId: plan.id,
        planningClaimId: planningClaim.claim.id,
        candidate: plannerOutcome.output,
        environment: input.environment,
        requirements: input.criticRequirements,
        evidence: input.criticEvidence,
        context: assembled.context,
        contextDigest: assembled.contextDigest,
        gatewayBudget: input.criticBudget,
        timeoutMilliseconds: input.criticBudget ? input.timeoutMilliseconds : undefined,
        maximumRepairAttempts: input.maximumRepairAttempts,
        signal: planningController.signal,
        invocationJournal,
      });
      if (planningClaimLost) throw new Error("Planning claim was lost during critique");
      for (const record of critique.modelInvocations)
        await this.store.createModelInvocation(record);
      for (const finding of critique.findings) await this.store.createCriticFinding(finding);
      if (critique.requiresNewPlanRevision) {
        return { status: "revision_required", plan, decisions, critique };
      }

      mission = await this.store.transitionMission({
        missionId: mission.id,
        expectedRevision: mission.revision,
        to: "awaiting_approval",
        reason: `plan_ready_for_exact_approval:${plan.id}`,
        actor: this.serviceActor,
        at,
      });
      const approval = ApprovalRequestSchema.parse({
        id: `approval-${digestCanonical({
          planId: plan.id,
          version: plan.version,
          revision: plan.revision,
          planDigest: plan.planDigest,
          policyDigest: input.compilerPolicy.policyDigest,
        }).slice(0, 32)}`,
        missionId: mission.id,
        subjectType: "plan",
        subjectId: plan.id,
        subjectVersion: plan.version,
        subjectRevision: plan.revision,
        state: "pending",
        requestedFromRole: input.compilerPolicy.minimumApprovalRole,
        payloadDigest: plan.planDigest,
        policyDigest: input.compilerPolicy.policyDigest,
        editableFields: [],
        requestedBy: input.approvalRequestedBy,
        requestedAt: at,
        ...(input.approvalExpiresAt ? { expiresAt: input.approvalExpiresAt } : {}),
      });
      await this.store.createApprovalRequest(approval);
      return { status: "awaiting_approval", mission, plan, decisions, critique, approval };
    } finally {
      clearInterval(planningHeartbeatTimer);
      await planningHeartbeatPromise;
      input.signal?.removeEventListener("abort", abortPlanning);
      await this.store.releasePlanningClaim({
        claimId: planningClaim.claim.id,
        ownerId: planningOwnerId,
        at: iso(this.now),
        status: planningCompletion,
        reason: planningReleaseReason,
      });
    }
  }

  async decidePlanApproval(input: DecidePlanApprovalInput): Promise<ApprovalRequest> {
    const provenance = await this.store.getMissionProvenance(input.missionId);
    const request = provenance.approvals.find(
      (approval) => approval.id === input.approvalRequestId,
    );
    if (!request) throw new Error(`Approval request ${input.approvalRequestId} was not found`);
    const decidedAt = input.decidedAt ?? iso(this.now);
    const response = ApprovalResponseSchema.parse({
      id: `approval-response-${digestCanonical({
        requestId: request.id,
        decision: input.decision,
        actorId: input.actor.id,
        decidedAt,
      }).slice(0, 24)}`,
      approvalRequestId: request.id,
      decision: input.decision,
      actor: input.actor,
      role: input.actor.role,
      reason: input.reason,
      subjectVersion: request.subjectVersion,
      subjectRevision: request.subjectRevision,
      payloadDigest: request.payloadDigest,
      policyDigest: request.policyDigest,
      decidedAt,
    });
    const decided = await this.store.respondToApproval(request.id, response, {
      now: decidedAt,
      currentPolicyDigest: input.currentPolicyDigest,
      authenticatedActor: input.actor,
      authorizedRoles: input.authorizedRoles,
    });
    if (input.decision === "rejected") {
      const mission = await this.requireMission(input.missionId);
      await this.store.transitionMission({
        missionId: mission.id,
        expectedRevision: mission.revision,
        to: "planning",
        reason: `plan_rejected:${request.subjectId}`,
        actor: input.actor,
        at: decidedAt,
      });
    }
    return decided;
  }

  async compileApprovedPlan(
    input: CompileApprovedScientificPlanInput,
  ): Promise<CompiledWorkUnitDag> {
    let mission = await this.requireMission(input.missionId);
    const plan = await this.store.getPlan(input.planId);
    if (!plan || plan.missionId !== mission.id) {
      throw new Error(`Approved plan ${input.planId} was not found in mission ${mission.id}`);
    }
    const provenance = await this.store.getMissionProvenance(mission.id);
    const approval = provenance.approvals.find(
      (candidate) =>
        candidate.subjectType === "plan" &&
        candidate.subjectId === plan.id &&
        candidate.subjectVersion === plan.version &&
        candidate.subjectRevision === plan.revision &&
        candidate.payloadDigest === plan.planDigest &&
        candidate.policyDigest === input.compilerPolicy.policyDigest &&
        candidate.state === "approved",
    );
    if (!approval) throw new Error(`Plan ${plan.id} has no current exact-revision approval`);
    const at = input.at ?? iso(this.now);
    await this.store.assertApprovalValid(approval.id, {
      now: at,
      currentPolicyDigest: input.compilerPolicy.policyDigest,
    });

    const decisions = provenance.decisions.filter((decision) => decision.planId === plan.id);
    const compiled = compileScientificProtocol({
      objective: mission.objective,
      plan,
      approvedPlanRevision: approval.subjectRevision,
      decisions,
      approvedDecisionIds:
        input.compilerPolicy.materialDecisionApproval === "covered_by_plan"
          ? decisions.map((decision) => decision.id)
          : [],
      constraints: mission.constraints,
      policy: input.compilerPolicy,
      environment: input.environment,
    });
    const persistedWorkUnits = new Map(
      provenance.workUnits.map((workUnit) => [workUnit.id, workUnit]),
    );
    const missingWorkUnits: WorkUnit[] = [];
    for (const expected of compiled.workUnits) {
      const persisted = persistedWorkUnits.get(expected.id);
      if (!persisted) {
        missingWorkUnits.push(expected);
        continue;
      }
      if (
        digestCanonical(compiledWorkUnitDefinition(persisted)) !==
        digestCanonical(compiledWorkUnitDefinition(expected))
      ) {
        throw new Error(
          `Persisted work unit ${persisted.id} diverges from the exact compiled definition`,
        );
      }
    }
    await this.store.createWorkUnits(missingWorkUnits);

    const actor = input.actor ?? this.serviceActor;
    if (mission.activePlanId === null) {
      mission = await this.store.activatePlan({
        missionId: mission.id,
        planId: plan.id,
        expectedMissionRevision: mission.revision,
        actor,
        at,
      });
    } else if (mission.activePlanId !== plan.id) {
      throw new Error(
        `Mission ${mission.id} already has a different active plan ${mission.activePlanId}`,
      );
    }

    if (mission.state === "awaiting_approval") {
      mission = await this.store.transitionMission({
        missionId: mission.id,
        expectedRevision: mission.revision,
        to: "ready",
        reason: `approved_plan_compiled:${plan.id}:${compiled.graphDigest}`,
        actor,
        at,
      });
    } else if (!reusableCompiledMissionStates.has(mission.state)) {
      throw new Error(
        `Mission ${mission.id} cannot reuse compiled plan ${plan.id} from ${mission.state}`,
      );
    }

    for (const expected of compiled.workUnits) {
      const current = await this.store.getWorkUnit(expected.id);
      if (!current) throw new Error(`Compiled work unit ${expected.id} was not persisted`);
      if (
        current.missionId !== mission.id ||
        current.planId !== plan.id ||
        current.planVersion !== plan.version
      ) {
        throw new Error(`Persisted work unit ${current.id} diverges from its approved plan`);
      }
      if (current.state === "created") {
        await this.store.transitionWorkUnit({
          workUnitId: current.id,
          expectedRevision: current.revision,
          to: "ready",
          at,
        });
      }
    }
    return compiled;
  }

  async startExecution(
    missionId: string,
    actor: ActorIdentity = this.serviceActor,
    at = iso(this.now),
  ): Promise<ScientificMission> {
    const mission = await this.requireMission(missionId);
    if (mission.state === "executing") return mission;
    if (mission.state !== "ready") {
      throw new Error(`Mission ${mission.id} cannot start execution from ${mission.state}`);
    }
    return this.store.transitionMission({
      missionId,
      expectedRevision: mission.revision,
      to: "executing",
      reason: "persistent_head_execution_started",
      actor,
      at,
    });
  }

  private requireProductionHuman(actor: ActorIdentity): ActorIdentity {
    if (actor.kind !== "human") {
      throw new Error("Production mission operations require an authenticated human actor");
    }
    return actor;
  }

  private async requireMission(missionId: string): Promise<ScientificMission> {
    const mission = await this.store.getMission(missionId);
    if (!mission) throw new Error(`Scientific mission ${missionId} was not found`);
    return mission;
  }

  private async ensurePlanningState(
    mission: ScientificMission,
    at: string,
  ): Promise<ScientificMission> {
    let current = mission;
    const advance = async (
      expected: ScientificMission,
      to: ScientificMission["state"],
      reason: string,
    ): Promise<ScientificMission> => {
      try {
        return await this.store.transitionMission({
          missionId: expected.id,
          expectedRevision: expected.revision,
          to,
          reason,
          actor: this.serviceActor,
          at,
        });
      } catch (error) {
        if (!(error instanceof ScientificRevisionConflictError)) throw error;
        const latest = await this.requireMission(expected.id);
        if (latest.state === to || latest.state === "planning" || latest.state === "replanning") {
          return latest;
        }
        throw error;
      }
    };
    if (current.state === "created") {
      current = await advance(current, "scoping", "objective_scope_started");
    }
    if (current.state === "scoping" || current.state === "blocked" || current.state === "paused") {
      current = await advance(current, "planning", "structured_scientific_planning_started");
    }
    if (current.state !== "planning" && current.state !== "replanning") {
      throw new Error(`Mission ${current.id} cannot be planned from ${current.state}`);
    }
    return current;
  }
}
