import { z } from "zod";
import {
  ActorIdentitySchema,
  ApprovalRequestSchema,
  ApprovalResponseSchema,
  AtomMapPublicationRequestSchema,
  AtomMapPublicationRequestSchemaVersion,
  BiomolecularSystemBuildRequestSchema,
  BiomolecularSystemBuildRequestSchemaVersion,
  BiomolecularSystemBuildWorkUnitParametersSchema,
  BiomolecularDecisionReferenceSchema,
  BiomolecularSystemManifestSchema,
  DigestSchema,
  EvidenceReferenceSchema,
  ForceFieldStackPublicationRequestSchema,
  ForceFieldStackPublicationRequestSchemaVersion,
  MissionBudgetSchema,
  ScientificDecisionSchema,
  ScientificMissionSchema,
  ScientificPlanSchema,
  MdWorkflowProtocolSchema,
  MdExecutionBindingParametersSchema,
  assertPublishedBiomolecularSystemManifestDigest,
  assertMdWorkflowProtocolDigest,
  canonicalJson,
  digestCanonical,
  type ActorIdentity,
  type ApprovalRequest,
  type EvidenceReference,
  type MdEnvironmentCapabilitySnapshot,
  type ModelInvocationIntent,
  type WorkUnit,
} from "@eigengrid/scientific-schema";
import {
  ContentAddressedArtifactStore,
  ContentAddressedStoreError,
  MdProjectionStore,
  ScientificStore,
  ScientificEntityNotFoundError,
  ScientificIntegrityError,
  ScientificRevisionConflictError,
  ScientificApprovalExpiredError,
  ScientificApprovalPolicyMismatchError,
  computePlanDigest,
  computeProtocolDigest,
  computeSkillGraphDigest,
  type MissionProvenance,
} from "@eigengrid/mission-runtime";
import {
  ScientificMissionService,
  MdStageSkillBindingSchema,
  compileMdWorkflowProtocol,
  type CompilerPolicyProfile,
  type EnvironmentCapabilityProfile,
  type MdCompilerPolicy,
} from "@eigengrid/scientific-agent";
import { systemPreparationEffectIdentity } from "./system-preparation-binding";

export type MissionApplicationErrorCode =
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INVALID_CANDIDATE"
  | "CANDIDATE_CHANGED"
  | "ENVIRONMENT_CHANGED"
  | "APPROVAL_REQUIRED"
  | "CONFLICT";

/** Stable application codes; transports expose their own fixed, safe messages. */
export class MissionApplicationError extends Error {
  readonly name = "MissionApplicationError";
  constructor(
    readonly code: MissionApplicationErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const inaccessibleMissionMessages = new Set([
  "A production mission-project association requires its requesting human owner",
  "Production mission project membership is missing, revoked, ambiguous or insufficient",
  "Production mission planning requires its exact immutable project association",
]);

export interface MissionApplicationContext {
  authenticatedActor: ActorIdentity;
  authorizedRoles: readonly string[];
  compilerPolicy: CompilerPolicyProfile;
  environment: EnvironmentCapabilityProfile;
  mdCompilerPolicy?: MdCompilerPolicy;
  mdEnvironment?: MdEnvironmentCapabilitySnapshot;
}
export interface MissionApplicationAuthority<
  C extends MissionApplicationContext = MissionApplicationContext,
> {
  current(): Promise<C>;
  assertCurrent(context: C): Promise<void>;
}

export const MissionCandidateSchema = z
  .object({
    schemaVersion: z.literal("eigengrid.mission-candidate/v1"),
    plan: ScientificPlanSchema,
    decisions: z.array(ScientificDecisionSchema),
    evidence: z.array(EvidenceReferenceSchema),
    md: z
      .object({
        system: BiomolecularSystemManifestSchema,
        protocol: MdWorkflowProtocolSchema,
        decisionRefs: z.array(BiomolecularDecisionReferenceSchema),
        stageSkillBindings: z.array(MdStageSkillBindingSchema),
      })
      .strict()
      .optional(),
    candidateDigest: DigestSchema,
  })
  .strict();
export type MissionCandidate = z.infer<typeof MissionCandidateSchema>;
export function computeMissionCandidateDigest(
  candidate: Omit<MissionCandidate, "candidateDigest"> | MissionCandidate,
): string {
  const { candidateDigest: _digest, ...material } = candidate as MissionCandidate;
  return digestCanonical(material);
}

const Address = z.object({ projectId: z.string().min(1), missionId: z.string().min(1) }).strict();
const PlanAddress = Address.extend({ planId: z.string().min(1) }).strict();
const ExactCandidate = PlanAddress.extend({ candidateDigest: DigestSchema }).strict();
const Create = z
  .object({
    projectId: z.string().min(1),
    mission: ScientificMissionSchema.omit({ requestedBy: true, policyProfile: true }).strict(),
    budget: MissionBudgetSchema,
    objectiveEvidence: z.array(EvidenceReferenceSchema).min(1),
  })
  .strict();
const Import = Address.extend({
  candidate: MissionCandidateSchema,
  expectedCandidateDigest: DigestSchema,
  approvalExpiresAt: z.string().datetime().optional(),
}).strict();
const ReplanUnstarted = ExactCandidate.extend({ reason: z.string().trim().min(1) }).strict();
const Cancel = Address.extend({
  schemaVersion: z.literal("eigengrid.mission-cancel/v1"),
  expectedRevision: z.number().int().positive(),
  reason: z.string().trim().min(1).max(2048),
}).strict();
const AgentInferenceAdmission = Address.extend({
  sessionId: z.string().uuid(),
  step: z.number().int().positive().safe(),
  requestDigest: DigestSchema,
  contextDigest: DigestSchema,
  provider: z.string().min(1).max(256),
  model: z.string().min(1).max(256),
  maximumInputTokens: z.number().int().positive().safe(),
  maximumOutputTokens: z.number().int().positive().safe(),
  maximumCost: z.number().finite().nonnegative(),
  timeoutMilliseconds: z.number().int().positive().safe(),
}).strict();
export interface AgentInferenceLease {
  readonly intent: ModelInvocationIntent;
  readonly remainingBudget: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cost: number;
  };
}
const Approve = ExactCandidate.extend({
  approvalRequestId: z.string().min(1),
  subjectVersion: z.number().int().positive(),
  subjectRevision: z.number().int().positive(),
  payloadDigest: DigestSchema,
  policyDigest: DigestSchema,
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().trim().min(1),
}).strict();
export {
  Address as MissionAddressSchema,
  PlanAddress as MissionReviewRequestSchema,
  ExactCandidate as MissionCompileRequestSchema,
  ExactCandidate as MissionStartRequestSchema,
  Create as MissionCreateRequestSchema,
  Import as MissionImportRequestSchema,
  Approve as MissionApproveRequestSchema,
  ReplanUnstarted as MissionReplanUnstartedRequestSchema,
  Cancel as MissionCancelRequestSchema,
};
const candidateEvidenceId = (planId: string) =>
  `candidate-${digestCanonical({ planId }).slice(0, 32)}`;

/** Operation approvals are reviewable only when their immutable v2 request is
 * bound to this candidate's system manifest, exact WorkUnit and CAS inputs.
 * Historical v1 operation payloads remain importable by the prepared-system
 * reader, but they cannot authorize a new application decision.
 */
export function approvalBelongsToMissionCandidate(
  approval: ApprovalRequest,
  candidate: MissionCandidate,
  provenance: MissionProvenance,
): boolean {
  if (approval.subjectType !== "operation") return false;
  const operation = provenance.operations.find((item) => item.id === approval.subjectId);
  if (
    !operation ||
    operation.kind !== "system_preparation" ||
    operation.missionId !== candidate.plan.missionId ||
    operation.requestDigest !== digestCanonical(operation.request) ||
    candidate.plan.requiredApprovals.length !== 1 ||
    approval.requestedFromRole !== candidate.plan.requiredApprovals[0] ||
    approval.missionId !== operation.missionId ||
    approval.subjectVersion !== 1 ||
    approval.subjectRevision !== 1 ||
    approval.payloadDigest !== operation.requestDigest ||
    approval.policyDigest !== operation.policyDigest
  ) {
    return false;
  }
  const workUnit = provenance.workUnits.find((item) => item.id === operation.workUnitId);
  if (
    !workUnit ||
    workUnit.missionId !== operation.missionId ||
    workUnit.planId !== candidate.plan.id ||
    workUnit.planVersion !== candidate.plan.version ||
    workUnit.protocolFragment.kind !== "scientific_capability" ||
    workUnit.executionPolicy.capability !== workUnit.protocolFragment.capability.id
  ) {
    return false;
  }
  const capability = workUnit.protocolFragment.capability;
  const parametersDigest = digestCanonical(workUnit.protocolFragment.parameters);
  const outputContractDigest = digestCanonical(workUnit.outputContract);
  const hasMissionEvidence = (id: string, contentDigest: string) => {
    const evidence = provenance.evidence.find((item) => item.id === id);
    return (
      evidence?.missionId === operation.missionId &&
      evidence.immutable &&
      evidence.contentDigest === contentDigest
    );
  };
  const hasExactInput = (id: string, contentDigest: string) =>
    workUnit.inputRefs.includes(id) && hasMissionEvidence(id, contentDigest);
  const exactCoordinator = (request: {
    missionId: string;
    planId: string;
    planVersion: number;
    workUnitId: string;
    intendedJobId: string;
    intendedAttemptId: string;
    inputEvidenceId: string;
    inputContentDigest: string;
    capability: { id: string; version: string; contractDigest: string };
    parametersDigest: string;
    outputContractDigest: string;
  }) =>
    request.missionId === operation.missionId &&
    request.planId === candidate.plan.id &&
    request.planVersion === candidate.plan.version &&
    request.workUnitId === workUnit.id &&
    (!workUnit.jobId || request.intendedJobId === workUnit.jobId) &&
    (!workUnit.attemptId || request.intendedAttemptId === workUnit.attemptId) &&
    canonicalJson(request.capability) === canonicalJson(capability) &&
    request.parametersDigest === parametersDigest &&
    request.outputContractDigest === outputContractDigest &&
    hasExactInput(request.inputEvidenceId, request.inputContentDigest);

  const build = BiomolecularSystemBuildRequestSchema.safeParse(operation.request);
  if (build.success) {
    const request = build.data;
    const parameters = BiomolecularSystemBuildWorkUnitParametersSchema.safeParse(
      workUnit.protocolFragment.parameters,
    );
    if (
      request.schemaVersion === BiomolecularSystemBuildRequestSchemaVersion &&
      parameters.success &&
      workUnit.kind === "scientific_capability" &&
      workUnit.protocolFragment.kind === "scientific_capability" &&
      workUnit.protocolFragment.capability.id === "biomolecular.build-system" &&
      workUnit.executionPolicy.capability === "biomolecular.build-system" &&
      workUnit.executionPolicy.riskClass === 3 &&
      workUnit.protocolFragment.riskClass === 3
    ) {
      const binding = parameters.data.systemBuild;
      const sourceEvidence = binding.sourceEvidenceRefs.map((id) => {
        const matches = provenance.evidence.filter((item) => item.id === id);
        if (
          matches.length !== 1 ||
          matches[0]!.missionId !== operation.missionId ||
          !matches[0]!.immutable ||
          !matches[0]!.contentDigest
        ) {
          return null;
        }
        return { id, contentDigest: matches[0]!.contentDigest };
      });
      const stackEvidence = provenance.evidence.filter(
        (item) => item.id === binding.forceFieldStackEvidenceRef,
      );
      let identity: ReturnType<typeof systemPreparationEffectIdentity> | undefined;
      try {
        identity = systemPreparationEffectIdentity(workUnit);
      } catch {
        return false;
      }
      const expectedInputIds = [
        ...binding.sourceEvidenceRefs,
        binding.forceFieldStackEvidenceRef,
      ].sort();
      const expectedDecisionRefs = [...binding.decisionRefs].sort((left, right) =>
        left.id.localeCompare(right.id),
      );
      if (
        sourceEvidence.some((item) => item === null) ||
        stackEvidence.length !== 1 ||
        stackEvidence[0]!.missionId !== operation.missionId ||
        !stackEvidence[0]!.immutable ||
        stackEvidence[0]!.kind !== "force_field_stack" ||
        stackEvidence[0]!.contentDigest !== binding.forceFieldStack.digest ||
        canonicalJson([...workUnit.inputRefs].sort()) !== canonicalJson(expectedInputIds) ||
        canonicalJson(sourceEvidence.sort((left, right) => left!.id.localeCompare(right!.id))) !==
          canonicalJson(request.sourceEvidence) ||
        request.inputEvidenceId !== binding.primaryInputEvidenceId ||
        request.schemaVersion !== BiomolecularSystemBuildRequestSchemaVersion ||
        request.workUnitId !== workUnit.id ||
        request.systemManifest.id !== parameters.data.manifestId ||
        request.systemManifest.revision !== parameters.data.manifestRevision ||
        canonicalJson(request.decisionRefs) !== canonicalJson(expectedDecisionRefs) ||
        canonicalJson(request.forceFieldStack) !== canonicalJson(binding.forceFieldStack) ||
        canonicalJson(request.outputArtifacts) !== canonicalJson(binding.outputArtifacts) ||
        request.intendedJobId !== identity.jobId ||
        request.intendedAttemptId !== identity.attemptId ||
        request.parametersDigest !== parametersDigest ||
        request.outputContractDigest !== outputContractDigest ||
        operation.id !== identity.operationId ||
        operation.idempotencyKey !== identity.idempotencyKey
      ) {
        return false;
      }
      if (!candidate.md) return true;
      return (
        operation.id === candidate.md.system.provenance.operationId &&
        request.systemManifest.id === candidate.md.system.id &&
        request.systemManifest.revision === candidate.md.system.revision &&
        canonicalJson(request.forceFieldStack) ===
          canonicalJson(candidate.md.system.forceFieldStack) &&
        canonicalJson(request.decisionRefs) === canonicalJson(candidate.md.decisionRefs)
      );
    }
    if (!candidate.md) return false;
    return (
      operation.id === candidate.md.system.provenance.operationId &&
      request.schemaVersion === BiomolecularSystemBuildRequestSchemaVersion &&
      request.capability.id === "biomolecular.build-system" &&
      exactCoordinator(request) &&
      request.systemManifest.id === candidate.md.system.id &&
      request.systemManifest.revision === candidate.md.system.revision &&
      canonicalJson(request.forceFieldStack) ===
        canonicalJson(candidate.md.system.forceFieldStack) &&
      canonicalJson(request.decisionRefs) === canonicalJson(candidate.md.decisionRefs) &&
      request.sourceEvidence.every((item) => hasMissionEvidence(item.id, item.contentDigest))
    );
  }

  if (!candidate.md) return false;
  const stack = ForceFieldStackPublicationRequestSchema.safeParse(operation.request);
  if (stack.success) {
    const request = stack.data;
    return (
      request.schemaVersion === ForceFieldStackPublicationRequestSchemaVersion &&
      request.capability.id === "amber.force-field-stack" &&
      exactCoordinator(request) &&
      request.stack.id === candidate.md.system.forceFieldStack.id &&
      request.stack.revision === candidate.md.system.forceFieldStack.revision &&
      request.stack.digest === candidate.md.system.forceFieldStack.digest &&
      request.sourceEvidence.every((item) => hasMissionEvidence(item.id, item.contentDigest))
    );
  }

  const atomMap = AtomMapPublicationRequestSchema.safeParse(operation.request);
  if (!atomMap.success) return false;
  const request = atomMap.data;
  return (
    request.schemaVersion === AtomMapPublicationRequestSchemaVersion &&
    ["amber.topology-coordinate-validation", "biomolecular.system-provenance"].includes(
      request.capability.id,
    ) &&
    exactCoordinator(request) &&
    request.systemManifest.id === candidate.md.system.id &&
    request.systemManifest.revision === candidate.md.system.revision &&
    request.systemManifest.digest === candidate.md.system.manifestDigest &&
    request.atomMap.digest === candidate.md.system.atomMapDigest &&
    request.sourceArtifact.evidenceRef === request.inputEvidenceId &&
    provenance.evidence.some(
      (item) =>
        item.id === request.sourceArtifact.evidenceRef &&
        item.mediaType === request.sourceArtifact.mediaType,
    )
  );
}

function requiredEvidenceIds(candidate: MissionCandidate): Set<string> {
  const ids = new Set([
    candidate.plan.protocol.system.evidenceId,
    ...candidate.decisions.flatMap((decision) => decision.evidenceRefs),
    ...candidate.plan.assumptions.flatMap((assumption) => assumption.evidenceRefs),
  ]);
  for (const step of candidate.plan.protocol.engineAgnosticSteps) {
    const execution = step.parameters.execution as { inputEvidenceId?: unknown } | undefined;
    if (typeof execution?.inputEvidenceId === "string") ids.add(execution.inputEvidenceId);
  }
  return ids;
}

/** Human application boundary. Authority comes from composition, never request JSON.
 * Every mutation remains durable; this object has no scheduler or execution-loop API. */
export class MissionApplication<C extends MissionApplicationContext = MissionApplicationContext> {
  private readonly now: () => Date;
  private readonly inferenceLeases = new WeakSet<AgentInferenceLease>();
  constructor(
    private readonly options: {
      store: ScientificStore;
      service: ScientificMissionService;
      authority: MissionApplicationAuthority<C>;
      artifacts: ContentAddressedArtifactStore;
      mdStore?: MdProjectionStore;
      now?: () => Date;
    },
  ) {
    this.now = options.now ?? (() => new Date());
  }

  private async context(): Promise<C> {
    const context = await this.options.authority.current();
    const actor = ActorIdentitySchema.parse(context.authenticatedActor);
    if (actor.kind !== "human" || !context.authorizedRoles.includes(actor.role))
      throw new MissionApplicationError(
        "FORBIDDEN",
        "Mission application requires an authenticated human with a current role",
      );
    return context;
  }
  private async access(input: z.infer<typeof Address>, context: C): Promise<void> {
    await this.options.authority.assertCurrent(context);
    try {
      await this.options.store.assertProductionMissionPlanningAccess({
        ...input,
        ownerUserId: context.authenticatedActor.id,
      });
    } catch (error) {
      if (
        error instanceof ScientificEntityNotFoundError ||
        (error instanceof ScientificIntegrityError &&
          inaccessibleMissionMessages.has(error.message))
      ) {
        throw new MissionApplicationError(
          "NOT_FOUND",
          "Mission was not found or is not accessible",
        );
      }
      throw error;
    }
  }
  private async verifyEvidence(
    evidence: readonly EvidenceReference[],
    missionId: string,
  ): Promise<void> {
    const ids = new Set<string>();
    for (const item of evidence) {
      if (
        item.missionId !== missionId ||
        !item.immutable ||
        ids.has(item.id) ||
        item.uri !== `cas://sha256/${item.contentDigest}`
      )
        throw new MissionApplicationError(
          "INVALID_CANDIDATE",
          "Candidate evidence must be unique, immutable CAS evidence in this mission",
        );
      ids.add(item.id);
      try {
        await this.options.artifacts.verify(item.contentDigest);
      } catch (error) {
        if (
          error instanceof ContentAddressedStoreError &&
          ["NOT_FOUND", "DIGEST_MISMATCH"].includes(error.code)
        ) {
          throw new MissionApplicationError(
            error.code === "NOT_FOUND" ? "INVALID_CANDIDATE" : "CANDIDATE_CHANGED",
            error.message,
          );
        }
        throw error;
      }
    }
  }

  async assertProjectAccess(projectId: string): Promise<void> {
    const context = await this.context();
    await this.options.authority.assertCurrent(context);
    try {
      await this.options.store.assertProductionProjectPlanningAccess({
        projectId,
        ownerUserId: context.authenticatedActor.id,
      });
    } catch (error) {
      if (error instanceof ScientificIntegrityError)
        throw new MissionApplicationError(
          "NOT_FOUND",
          "Project was not found or is not accessible",
        );
      throw error;
    }
    await this.options.authority.assertCurrent(context);
  }

  /** Host-only inference admission using the mission runtime's existing atomic mission budget ledger. */
  async beginAgentInference(
    value: z.input<typeof AgentInferenceAdmission>,
  ): Promise<AgentInferenceLease> {
    const input = AgentInferenceAdmission.parse(value);
    const context = await this.context();
    await this.access(input, context);
    const budget = await this.options.store.getMissionBudget(input.missionId);
    const held = (kind: "model_tokens" | "cost") =>
      budget.reservations
        .filter((r) => r.kind === kind && ["reserved", "ambiguous"].includes(r.state))
        .reduce((sum, r) => sum + r.amount, 0);
    const availableTokens = Math.floor(
      budget.limits.modelTokens - budget.consumed.modelTokens - held("model_tokens"),
    );
    const availableCost = budget.limits.cost - budget.consumed.cost - held("cost");
    const total = Math.min(availableTokens, input.maximumInputTokens + input.maximumOutputTokens);
    const outputTokens = Math.min(input.maximumOutputTokens, Math.floor(total / 2));
    const inputTokens = Math.min(input.maximumInputTokens, total - outputTokens);
    if (inputTokens < 1 || outputTokens < 1 || availableCost <= 0 || input.maximumCost <= 0)
      throw new MissionApplicationError("CONFLICT", "PARENT_MODEL_BUDGET_EXHAUSTED");
    const cost = Math.min(input.maximumCost, availableCost);
    const key = digestCanonical({
      sessionId: input.sessionId,
      step: input.step,
      missionId: input.missionId,
      requestDigest: input.requestDigest,
      contextDigest: input.contextDigest,
      provider: input.provider,
      model: input.model,
    });
    const at = this.now().toISOString();
    const mission = await this.options.store.getMission(input.missionId);
    await this.access(input, context);
    const admitted = await this.options.store.beginModelInvocation({
      id: `agent-model-${key.slice(0, 48)}`,
      idempotencyKey: key,
      missionId: input.missionId,
      ...(mission?.activePlanId ? { planId: mission.activePlanId } : {}),
      role: "diagnostician",
      provider: input.provider,
      model: input.model,
      capabilityDigest: digestCanonical({
        port: "eigengrid.agent-inference/v1",
        policy: context.compilerPolicy.policyDigest,
      }),
      requestDigest: input.requestDigest,
      contextDigest: input.contextDigest,
      budget: {
        maximumCalls: 1,
        maximumInputTokens: inputTokens,
        maximumOutputTokens: outputTokens,
        maximumTotalTokens: inputTokens + outputTokens,
        maximumCost: cost,
      },
      budgetReservationIds: {
        modelTokens: `agent-model-${key.slice(0, 48)}-tokens`,
        cost: `agent-model-${key.slice(0, 48)}-cost`,
      },
      timeoutMilliseconds: input.timeoutMilliseconds,
      maximumRepairAttempts: 0,
      status: "invoking",
      createdAt: at,
      updatedAt: at,
    });
    if (!admitted.admitted)
      throw new MissionApplicationError("CONFLICT", "MODEL_INVOCATION_REQUIRES_RECONCILIATION");
    const lease = Object.freeze({
      intent: admitted.intent,
      remainingBudget: Object.freeze({ inputTokens, outputTokens, cost }),
    });
    this.inferenceLeases.add(lease);
    return lease;
  }

  /** Account an already admitted call even if a client disconnects or loses permission.
   * This host-issued lease cannot authorize a scientific effect or a new model call. */
  async observeAgentInference(
    lease: AgentInferenceLease,
    observation: {
      responseDigest?: string;
      inputTokens?: number;
      outputTokens?: number;
      cost?: number;
      ambiguous?: boolean;
    },
  ): Promise<void> {
    if (!this.inferenceLeases.has(lease))
      throw new MissionApplicationError("FORBIDDEN", "Foreign inference accounting lease");
    await this.options.store.observeModelInvocation({
      intentId: lease.intent.id,
      status: observation.ambiguous ? "ambiguous" : "observed",
      observedAt: this.now().toISOString(),
      ...(observation.ambiguous
        ? { errorCode: "MODEL_USAGE_UNCONFIRMED" }
        : {
            responseDigest: observation.responseDigest,
            inputTokens: observation.inputTokens,
            outputTokens: observation.outputTokens,
            cost: observation.cost,
          }),
    });
  }

  async create(value: z.input<typeof Create>) {
    const input = Create.parse(value);
    const context = await this.context();
    await this.verifyEvidence(input.objectiveEvidence, input.mission.id);
    await this.options.authority.assertCurrent(context);
    return this.options.service.createMissionInProject({
      ...input,
      authenticatedActor: context.authenticatedActor,
      mission: ScientificMissionSchema.parse({
        ...input.mission,
        requestedBy: context.authenticatedActor,
        policyProfile: context.compilerPolicy.id,
      }),
    });
  }

  async importCandidate(value: z.input<typeof Import>) {
    const input = Import.parse(value);
    const context = await this.context();
    await this.access(input, context);
    const candidate = input.candidate;
    if (
      candidate.plan.missionId !== input.missionId ||
      computeMissionCandidateDigest(candidate) !== input.expectedCandidateDigest ||
      candidate.candidateDigest !== input.expectedCandidateDigest
    )
      throw new MissionApplicationError(
        "CANDIDATE_CHANGED",
        "Candidate manifest differs from the exact requested digest or mission",
      );
    const { protocolDigest, ...protocolMaterial } = candidate.plan.protocol;
    if (
      candidate.plan.planDigest !== computePlanDigest(candidate.plan) ||
      protocolDigest !== computeProtocolDigest(protocolMaterial) ||
      candidate.plan.skillResolution.graphDigest !==
        computeSkillGraphDigest(candidate.plan.skillResolution)
    )
      throw new MissionApplicationError(
        "INVALID_CANDIDATE",
        "Candidate plan, protocol, or skill graph digest is invalid",
      );
    const provenance = await this.options.store.getMissionProvenance(input.missionId);
    if (
      candidate.plan.status !== "under_review" ||
      candidate.plan.revision !== 1 ||
      candidate.plan.missingInputs.length ||
      candidate.decisions.some(
        (decision) =>
          decision.missionId !== input.missionId || decision.planId !== candidate.plan.id,
      ) ||
      new Set(candidate.decisions.map((decision) => decision.id)).size !==
        candidate.decisions.length ||
      digestCanonical([...candidate.plan.protocol.decisions].sort()) !==
        digestCanonical(candidate.decisions.map((decision) => decision.id).sort())
    )
      throw new MissionApplicationError(
        "INVALID_CANDIDATE",
        "Candidate must contain a complete under-review plan and its exact decisions",
      );
    const existingPlan = provenance.plans.find((plan) => plan.id === candidate.plan.id);
    if (
      !existingPlan &&
      !["created", "scoping", "blocked", "paused", "planning", "replanning"].includes(
        provenance.mission.state,
      )
    ) {
      throw new MissionApplicationError(
        "CONFLICT",
        `Mission ${input.missionId} cannot import a new plan from ${provenance.mission.state}`,
      );
    }
    if (existingPlan && existingPlan.planDigest !== candidate.plan.planDigest) {
      throw new MissionApplicationError(
        "CANDIDATE_CHANGED",
        "Imported plan differs from its persisted revision",
      );
    }
    const parent = [...provenance.plans].sort((left, right) => right.version - left.version)[0];
    if (
      !existingPlan &&
      (candidate.plan.version !== (parent?.version ?? 0) + 1 ||
        candidate.plan.parentPlanId !== parent?.id)
    )
      throw new MissionApplicationError("CONFLICT", "Candidate plan version or parent is stale");
    if (input.approvalExpiresAt && Date.parse(input.approvalExpiresAt) <= this.now().getTime())
      throw new MissionApplicationError(
        "INVALID_CANDIDATE",
        "Candidate approval expiration must be in the future",
      );
    if (
      candidate.plan.protocol.objectiveId !== provenance.mission.objective.id ||
      digestCanonical(candidate.plan.protocol.system) !==
        digestCanonical(provenance.mission.objective.system)
    )
      throw new MissionApplicationError(
        "INVALID_CANDIDATE",
        "Candidate objective must match the durable mission",
      );
    await this.verifyEvidence(candidate.evidence, input.missionId);
    for (const item of candidate.evidence) {
      const existing = provenance.evidence.find((entry) => entry.id === item.id);
      if (existing && digestCanonical(existing) !== digestCanonical(item))
        throw new MissionApplicationError(
          "CANDIDATE_CHANGED",
          "Candidate evidence differs from its immutable durable identity",
        );
    }
    const allEvidence = [...provenance.evidence, ...candidate.evidence];
    for (const id of requiredEvidenceIds(candidate)) {
      const evidence = allEvidence.find((item) => item.id === id);
      if (!evidence)
        throw new MissionApplicationError(
          "INVALID_CANDIDATE",
          `Candidate input evidence ${id} is absent`,
        );
      await this.verifyEvidence([evidence], input.missionId);
    }
    if (candidate.md) await this.verifyMd(candidate, context, allEvidence);
    const policy = this.policy(candidate, context);
    if (
      candidate.plan.requiredApprovals.length !== 1 ||
      candidate.plan.requiredApprovals[0] !== policy.minimumApprovalRole
    )
      throw new MissionApplicationError(
        "INVALID_CANDIDATE",
        "Candidate approval role does not match current policy",
      );
    if (
      candidate.plan.skillResolution.environmentDigest !==
      (candidate.md
        ? context.mdEnvironment!.environmentDigest
        : context.environment.environmentDigest)
    )
      throw new MissionApplicationError(
        "ENVIRONMENT_CHANGED",
        "Candidate environment digest differs from current environment",
      );
    const { candidateDigest, ...material } = candidate;
    const stored = await this.options.artifacts.put(
      new TextEncoder().encode(canonicalJson(material)),
    );
    if (stored.digest !== candidateDigest)
      throw new MissionApplicationError(
        "INVALID_CANDIDATE",
        "Candidate CAS material digest mismatch",
      );
    await this.access(input, context);
    for (const evidence of candidate.evidence) await this.options.store.createEvidence(evidence);
    await this.options.store.createEvidence(
      EvidenceReferenceSchema.parse({
        id: candidateEvidenceId(candidate.plan.id),
        missionId: input.missionId,
        kind: "human_review",
        uri: stored.uri,
        contentDigest: stored.digest,
        immutable: true,
        sourceId: candidate.plan.id,
        createdAt: candidate.plan.createdAt,
      }),
    );
    const approval = await this.options.service.importPlanInProject({
      authenticatedActor: context.authenticatedActor,
      projectId: input.projectId,
      plan: candidate.plan,
      decisions: candidate.decisions,
      currentPolicyDigest: policy.policyDigest,
      minimumApprovalRole: policy.minimumApprovalRole,
      approvalExpiresAt: input.approvalExpiresAt,
    });
    if (candidate.md) {
      const mdStore = this.options.mdStore!;
      const existingProtocol = await mdStore.getProtocol(
        candidate.md.protocol.id,
        candidate.md.protocol.revision,
      );
      if (!existingProtocol)
        await mdStore.putProtocol(candidate.md.protocol, {
          planId: candidate.plan.id,
          planVersion: candidate.plan.version,
        });
      else if (existingProtocol.protocolDigest !== candidate.md.protocol.protocolDigest)
        throw new MissionApplicationError(
          "CANDIDATE_CHANGED",
          "Persisted MD protocol differs from candidate",
        );
      await this.requestMdApproval(candidate, context, input.approvalExpiresAt);
    }
    return {
      missionId: input.missionId,
      planId: candidate.plan.id,
      candidateDigest,
      approval,
      state: (await this.options.store.getMission(input.missionId))!.state,
    };
  }

  async read(value: z.input<typeof Address>) {
    const input = Address.parse(value);
    const context = await this.context();
    await this.access(input, context);
    return this.options.store.getMissionProvenance(input.missionId);
  }
  async status(value: z.input<typeof Address>) {
    const provenance = await this.read(value);
    return {
      missionId: provenance.mission.id,
      revision: provenance.mission.revision,
      state: provenance.mission.state,
      activePlanId: provenance.mission.activePlanId,
      pendingApprovals: provenance.approvals
        .filter((item) => item.state === "pending")
        .map((item) => item.id),
      workUnits: provenance.workUnits.map((item) => ({
        workUnitId: item.id,
        state: item.state,
        jobId: item.jobId ?? null,
        attemptId: item.attemptId ?? null,
      })),
      operations: provenance.operations.map((item) => ({
        operationId: item.id,
        workUnitId: item.workUnitId,
        state: item.state,
      })),
      validationCount: provenance.validations.length,
      qcPending: provenance.assessments.length === 0,
      scientificAssessment: provenance.assessments,
      complete: provenance.complete,
    };
  }
  async review(value: z.input<typeof PlanAddress>) {
    const input = PlanAddress.parse(value);
    const context = await this.context();
    await this.access(input, context);
    const candidate = await this.loadCandidate(input.missionId, input.planId);
    const provenance = await this.options.store.getMissionProvenance(input.missionId);
    return {
      missionId: input.missionId,
      planId: input.planId,
      candidateDigest: candidate.candidateDigest,
      candidate,
      approvals: provenance.approvals.filter((item) =>
        this.belongsToCandidate(item, candidate, provenance),
      ),
      state: provenance.mission.state,
    };
  }
  async approve(value: z.input<typeof Approve>) {
    const input = Approve.parse(value);
    const context = await this.context();
    await this.access(input, context);
    const candidate = await this.exactCandidate(input);
    const policy = this.policy(candidate, context);
    await this.verifyInputs(candidate, context);
    const provenance = await this.options.store.getMissionProvenance(input.missionId);
    const request = provenance.approvals.find((item) => item.id === input.approvalRequestId);
    if (request && request.policyDigest !== policy.policyDigest)
      throw new ScientificApprovalPolicyMismatchError(
        request.id,
        request.policyDigest,
        policy.policyDigest,
      );
    if (
      !request ||
      !this.belongsToCandidate(request, candidate, provenance) ||
      request.subjectVersion !== input.subjectVersion ||
      request.subjectRevision !== input.subjectRevision ||
      request.payloadDigest !== input.payloadDigest ||
      request.policyDigest !== input.policyDigest ||
      input.policyDigest !== policy.policyDigest
    )
      throw new MissionApplicationError(
        "CANDIDATE_CHANGED",
        "Approval does not match the reviewed candidate revision and current policy",
      );
    await this.verifySystemBuildApprovalInputs(request, candidate, provenance);
    await this.access(input, context);
    if (!context.authorizedRoles.includes(request.requestedFromRole))
      throw new MissionApplicationError(
        "FORBIDDEN",
        "Authenticated human lacks the requested approval role",
      );
    const reviewer = { ...context.authenticatedActor, role: request.requestedFromRole };
    const at = this.now().toISOString();
    if (request.subjectType === "plan")
      return this.options.service.decidePlanApprovalInProject({
        missionId: input.missionId,
        projectId: input.projectId,
        authenticatedActor: reviewer,
        actor: reviewer,
        authorizedRoles: [...context.authorizedRoles],
        approvalRequestId: request.id,
        decision: input.decision,
        reason: input.reason,
        currentPolicyDigest: policy.policyDigest,
        expectedSubjectVersion: input.subjectVersion,
        expectedSubjectRevision: input.subjectRevision,
        expectedPayloadDigest: input.payloadDigest,
        expectedPolicyDigest: input.policyDigest,
        decidedAt: at,
      });
    return this.options.store.respondToApproval(
      request.id,
      ApprovalResponseSchema.parse({
        id: `response-${digestCanonical({ requestId: request.id, actor: context.authenticatedActor.id, at, decision: input.decision }).slice(0, 32)}`,
        approvalRequestId: request.id,
        decision: input.decision,
        actor: reviewer,
        role: reviewer.role,
        reason: input.reason,
        subjectVersion: input.subjectVersion,
        subjectRevision: input.subjectRevision,
        payloadDigest: input.payloadDigest,
        policyDigest: input.policyDigest,
        decidedAt: at,
      }),
      {
        now: at,
        currentPolicyDigest: policy.policyDigest,
        authenticatedActor: reviewer,
        authorizedRoles: [...context.authorizedRoles],
      },
    );
  }
  async compile(value: z.input<typeof ExactCandidate>) {
    const input = ExactCandidate.parse(value);
    const context = await this.context();
    await this.access(input, context);
    const candidate = await this.exactCandidate(input);
    await this.verifyInputs(candidate, context);
    await this.access(input, context);
    if (!candidate.md) {
      const provenance = await this.options.store.getMissionProvenance(input.missionId);
      const approved = provenance.approvals.filter(
        (request) =>
          request.subjectType === "plan" &&
          request.subjectId === candidate.plan.id &&
          request.subjectVersion === candidate.plan.version &&
          request.subjectRevision === candidate.plan.revision &&
          request.payloadDigest === candidate.plan.planDigest &&
          request.state === "approved",
      );
      if (
        !approved.some((request) => request.policyDigest === context.compilerPolicy.policyDigest)
      ) {
        if (approved[0])
          throw new ScientificApprovalPolicyMismatchError(
            approved[0].id,
            approved[0].policyDigest,
            context.compilerPolicy.policyDigest,
          );
        throw new MissionApplicationError(
          "APPROVAL_REQUIRED",
          `Plan ${candidate.plan.id} has no current exact-revision approval`,
        );
      }
      return this.options.service.compileApprovedPlanInProject({
        ...input,
        authenticatedActor: context.authenticatedActor,
        compilerPolicy: context.compilerPolicy,
        environment: context.environment,
      });
    }
    return this.compileMd(candidate, context, input.projectId);
  }
  async start(value: z.input<typeof ExactCandidate>) {
    const input = ExactCandidate.parse(value);
    // Recompilation revalidates current approvals, expiry, inputs, environment and exact DAG.
    await this.compile(input);
    const context = await this.context();
    await this.access(input, context);
    const candidate = await this.exactCandidate(input);
    await this.verifyInputs(candidate, context);
    const policy = this.policy(candidate, context);
    const provenance = await this.options.store.getMissionProvenance(input.missionId);
    const approvals = provenance.approvals.filter(
      (item) => this.belongsToCandidate(item, candidate, provenance) && item.state === "approved",
    );
    for (const approval of approvals) {
      const historicalPreparation = candidate.md?.protocol.preparationPolicyDigest;
      const preservedDecision = candidate.md?.decisionRefs.some(
        (ref) => ref.approvalRef === approval.id,
      );
      const completedPreparation =
        approval.subjectType === "operation" &&
        provenance.operations.some(
          (operation) => operation.id === approval.subjectId && operation.state === "confirmed",
        );
      await this.options.store.assertApprovalValid(approval.id, {
        now: this.now().toISOString(),
        currentPolicyDigest:
          historicalPreparation && (preservedDecision || completedPreparation)
            ? historicalPreparation
            : policy.policyDigest,
      });
    }
    await this.access(input, context);
    try {
      return await this.options.service.startExecutionInProject({
        ...input,
        authenticatedActor: context.authenticatedActor,
      });
    } catch (error) {
      if (
        !(error instanceof ScientificRevisionConflictError) ||
        error.details.entity !== "mission" ||
        error.details.id !== input.missionId
      )
        throw error;
      // A concurrent exact start may win the mission runtime's revision CAS. Observe its durable
      // proof without retrying the transition or granting any new effect.
      const observed = await this.reconcileStart(input);
      if (observed) return observed;
      throw error;
    }
  }

  /** Read back the mission runtime's exact mission-start transition after a lost acknowledgement.
   * This is proof of durable admission only; it never certifies a Slurm/MD effect. */
  async reconcileStart(value: z.input<typeof ExactCandidate>) {
    const input = ExactCandidate.parse(value);
    const context = await this.context();
    await this.access(input, context);
    const candidate = await this.exactCandidate(input);
    const provenance = await this.options.store.getMissionProvenance(input.missionId);
    if (
      provenance.mission.activePlanId !== candidate.plan.id ||
      !["executing", "observing", "completed", "failed", "cancelled"].includes(
        provenance.mission.state,
      ) ||
      !provenance.transitions.some(
        (item) =>
          item.toState === "executing" && item.reason === "persistent_head_execution_started",
      )
    )
      return null;
    await this.access(input, context);
    return provenance.mission;
  }

  /** Versioned durable cancellation request. Never invents a scheduler kill receipt. */
  async requestCancel(value: z.input<typeof Cancel>) {
    const input = Cancel.parse(value);
    const context = await this.context();
    await this.access(input, context);
    const mission = await this.options.store.getMission(input.missionId);
    if (!mission || mission.revision !== input.expectedRevision)
      throw new MissionApplicationError("CONFLICT", "Mission revision changed");
    if (
      ["completed", "failed", "cancelled", "cancel_requested", "cancelling"].includes(mission.state)
    )
      return mission;
    await this.access(input, context);
    return this.options.store.transitionMission({
      missionId: mission.id,
      expectedRevision: input.expectedRevision,
      to: "cancel_requested",
      reason: input.reason,
      actor: context.authenticatedActor,
      at: this.now().toISOString(),
    });
  }

  /** Withdraw only an unstarted MD phase. Never touches a live or acknowledged effect. */
  async replanUnstarted(value: z.input<typeof ReplanUnstarted>) {
    const input = ReplanUnstarted.parse(value),
      context = await this.context();
    await this.access(input, context);
    const candidate = await this.exactCandidate(input);
    if (!candidate.md)
      throw new MissionApplicationError(
        "CONFLICT",
        "Unstarted replanning is restricted to MD candidates",
      );
    let provenance = await this.options.store.getMissionProvenance(input.missionId);
    let mission = provenance.mission;
    const planUnits = provenance.workUnits.filter((w) => w.planId === input.planId);
    const units = planUnits.filter(
      (w) => MdExecutionBindingParametersSchema.safeParse(w.protocolFragment.parameters).success,
    );
    const otherUnits = planUnits.filter((w) => !units.includes(w));
    const otherIds = new Set(otherUnits.map((w) => w.id));
    const ids = new Set(units.map((w) => w.id));
    if (
      mission.activePlanId !== input.planId ||
      units.length === 0 ||
      otherUnits.some((w) => !["succeeded", "cancelled"].includes(w.state)) ||
      provenance.operations.some(
        (op) => otherIds.has(op.workUnitId) && !["confirmed", "abandoned"].includes(op.state),
      ) ||
      !["ready", "paused", "replanning"].includes(mission.state) ||
      units.some(
        (w) =>
          !["created", "ready", "cancel_requested", "cancelled"].includes(w.state) ||
          w.jobId ||
          w.attemptId ||
          w.claimOwner,
      ) ||
      provenance.operations.some((op) => ids.has(op.workUnitId))
    )
      throw new MissionApplicationError(
        "CONFLICT",
        "Replanning requires an unstarted active MD plan with no claims or effects",
      );
    await this.access(input, context);
    const at = this.now().toISOString();
    if (mission.state === "ready")
      mission = await this.options.store.transitionMission({
        missionId: mission.id,
        expectedRevision: mission.revision,
        to: "paused",
        reason: "withdraw_unstarted_md:" + input.reason,
        actor: context.authenticatedActor,
        at,
      });
    for (let work of units) {
      if (!["cancel_requested", "cancelled"].includes(work.state))
        work = await this.options.store.transitionWorkUnit({
          workUnitId: work.id,
          expectedRevision: work.revision,
          to: "cancel_requested",
          at,
        });
      if (work.state !== "cancelled")
        await this.options.store.transitionWorkUnit({
          workUnitId: work.id,
          expectedRevision: work.revision,
          to: "cancelled",
          at,
        });
    }
    if (mission.state !== "replanning")
      mission = await this.options.store.transitionMission({
        missionId: mission.id,
        expectedRevision: mission.revision,
        to: "replanning",
        reason: "withdraw_unstarted_md:" + input.reason,
        actor: context.authenticatedActor,
        at,
      });
    return {
      missionId: mission.id,
      planId: input.planId,
      state: mission.state,
      cancelledWorkUnitIds: [...ids],
      mdDispatched: false,
    };
  }

  private policy(candidate: MissionCandidate, context: C) {
    if (
      candidate.md &&
      (!context.mdCompilerPolicy || !context.mdEnvironment || !this.options.mdStore)
    )
      throw new MissionApplicationError(
        "CONFLICT",
        "MD candidate requires trusted MD policy, environment, and projection store",
      );
    return candidate.md ? context.mdCompilerPolicy! : context.compilerPolicy;
  }
  private async loadCandidate(missionId: string, planId: string): Promise<MissionCandidate> {
    const provenance = await this.options.store.getMissionProvenance(missionId);
    const evidence = provenance.evidence.find(
      (item) => item.id === candidateEvidenceId(planId) && item.sourceId === planId,
    );
    const plan = provenance.plans.find((item) => item.id === planId);
    if (
      !evidence ||
      !plan ||
      !evidence.immutable ||
      evidence.uri !== `cas://sha256/${evidence.contentDigest}`
    )
      throw new MissionApplicationError(
        "NOT_FOUND",
        "No durable candidate manifest exists for this plan",
      );
    const stored = await this.options.artifacts.get(evidence.contentDigest);
    const candidate = MissionCandidateSchema.parse({
      ...JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stored.bytes)),
      candidateDigest: evidence.contentDigest,
    });
    if (
      candidate.plan.id !== planId ||
      candidate.plan.missionId !== missionId ||
      candidate.plan.planDigest !== plan.planDigest ||
      computeMissionCandidateDigest(candidate) !== evidence.contentDigest
    )
      throw new MissionApplicationError(
        "CANDIDATE_CHANGED",
        "Durable candidate manifest does not match persisted plan",
      );
    return candidate;
  }
  private async exactCandidate(input: z.infer<typeof ExactCandidate>) {
    const candidate = await this.loadCandidate(input.missionId, input.planId);
    if (candidate.candidateDigest !== input.candidateDigest)
      throw new MissionApplicationError(
        "CANDIDATE_CHANGED",
        "Candidate changed since review; review the exact persisted manifest again",
      );
    return candidate;
  }
  private belongsToCandidate(
    request: ApprovalRequest,
    candidate: MissionCandidate,
    provenance?: MissionProvenance,
  ): boolean {
    if (request.subjectType === "operation")
      return !!provenance && approvalBelongsToMissionCandidate(request, candidate, provenance);
    if (request.subjectType === "plan")
      return (
        request.subjectId === candidate.plan.id &&
        request.payloadDigest === candidate.plan.planDigest
      );
    if (!candidate.md) return false;
    return (
      (request.subjectType === "md_protocol" &&
        request.subjectId === candidate.md.protocol.id &&
        request.payloadDigest === candidate.md.protocol.protocolDigest) ||
      (request.subjectType === "biomolecular_system_manifest" &&
        request.subjectId === candidate.md.system.id &&
        request.payloadDigest === candidate.md.system.manifestDigest) ||
      (request.subjectType === "decision" &&
        candidate.md.decisionRefs.some(
          (item) => item.id === request.subjectId && item.decisionDigest === request.payloadDigest,
        ))
    );
  }
  private async verifyInputs(candidate: MissionCandidate, context: C) {
    const provenance = await this.options.store.getMissionProvenance(candidate.plan.missionId);
    await this.verifyEvidence(candidate.evidence, candidate.plan.missionId);
    const objective = provenance.evidence.find(
      (item) => item.id === provenance.mission.objective.system.evidenceId,
    );
    if (!objective || objective.contentDigest !== provenance.mission.objective.system.contentDigest)
      throw new MissionApplicationError(
        "CANDIDATE_CHANGED",
        "Objective input evidence is absent or changed",
      );
    await this.verifyEvidence([objective], candidate.plan.missionId);
    for (const id of requiredEvidenceIds(candidate)) {
      const reference = provenance.evidence.find((item) => item.id === id);
      if (!reference)
        throw new MissionApplicationError(
          "INVALID_CANDIDATE",
          `Candidate input evidence ${id} is absent`,
        );
      await this.verifyEvidence([reference], candidate.plan.missionId);
    }
    const environmentDigest = candidate.md
      ? context.mdEnvironment?.environmentDigest
      : context.environment.environmentDigest;
    if (candidate.plan.skillResolution.environmentDigest !== environmentDigest)
      throw new MissionApplicationError(
        "ENVIRONMENT_CHANGED",
        "Current environment differs from reviewed candidate",
      );
    if (candidate.md) await this.verifyMd(candidate, context, provenance.evidence);
  }
  private async verifySystemBuildApprovalInputs(
    approval: ApprovalRequest,
    candidate: MissionCandidate,
    provenance: MissionProvenance,
  ): Promise<void> {
    if (approval.subjectType !== "operation") return;
    const operation = provenance.operations.find((item) => item.id === approval.subjectId);
    const parsed = operation
      ? BiomolecularSystemBuildRequestSchema.safeParse(operation.request)
      : undefined;
    if (
      !operation ||
      !parsed?.success ||
      parsed.data.schemaVersion !== BiomolecularSystemBuildRequestSchemaVersion
    )
      return;
    const workUnit = provenance.workUnits.find((item) => item.id === operation.workUnitId);
    const parameters = workUnit
      ? BiomolecularSystemBuildWorkUnitParametersSchema.safeParse(
          workUnit.protocolFragment.parameters,
        )
      : undefined;
    if (!workUnit || !parameters?.success) return;
    const binding = parameters.data.systemBuild;
    const refs = [...binding.sourceEvidenceRefs, binding.forceFieldStackEvidenceRef];
    const evidence = refs.map((id) => {
      const matches = provenance.evidence.filter((item) => item.id === id);
      if (matches.length !== 1) {
        throw new MissionApplicationError(
          "CANDIDATE_CHANGED",
          `System-build evidence ${id} is missing or ambiguous`,
        );
      }
      return matches[0]!;
    });
    const requestEvidence = new Map(parsed.data.sourceEvidence.map((item) => [item.id, item]));
    if (
      evidence.some((item) =>
        item.id === binding.forceFieldStackEvidenceRef
          ? item.contentDigest !== binding.forceFieldStack.digest ||
            item.kind !== "force_field_stack"
          : requestEvidence.get(item.id)?.contentDigest !== item.contentDigest,
      )
    )
      throw new MissionApplicationError(
        "CANDIDATE_CHANGED",
        "System-build CAS evidence no longer matches the reviewed request",
      );
    await this.verifyEvidence(evidence, candidate.plan.missionId);
  }
  private async verifyMd(
    candidate: MissionCandidate,
    context: C,
    evidence: readonly EvidenceReference[],
  ) {
    this.policy(candidate, context);
    const md = candidate.md!;
    const system = assertPublishedBiomolecularSystemManifestDigest(md.system);
    const protocol = assertMdWorkflowProtocolDigest(md.protocol);
    const persisted = await this.options.mdStore!.getSystemManifest(system.id, system.revision);
    if (
      !persisted ||
      persisted.missionId !== candidate.plan.missionId ||
      persisted.manifestDigest !== system.manifestDigest ||
      protocol.missionId !== candidate.plan.missionId ||
      protocol.system.manifestDigest !== system.manifestDigest
    )
      throw new MissionApplicationError(
        "CONFLICT",
        "MD system must already have exact published preparation authority in this mission",
      );
    for (const ref of md.decisionRefs) {
      const decision = await this.options.mdStore!.getBiomolecularDecision(ref.id, ref.revision);
      if (
        !decision ||
        decision.missionId !== candidate.plan.missionId ||
        decision.decisionDigest !== ref.decisionDigest
      )
        throw new MissionApplicationError("CONFLICT", "MD decision lacks exact durable authority");
    }
    for (const stage of protocol.stages)
      for (const artifact of stage.inputs) {
        const reference = evidence.find(
          (item) =>
            item.id === artifact.evidenceRef && item.contentDigest === artifact.contentDigest,
        );
        if (!reference)
          throw new MissionApplicationError(
            "INVALID_CANDIDATE",
            `MD stage input ${artifact.evidenceRef} is absent or changed`,
          );
        await this.verifyEvidence([reference], candidate.plan.missionId);
      }
  }
  private async requestMdApproval(candidate: MissionCandidate, context: C, expiresAt?: string) {
    const md = candidate.md!;
    const policy = this.policy(candidate, context);
    for (const subject of [
      {
        type: "biomolecular_system_manifest" as const,
        id: md.system.id,
        revision: md.system.revision,
        digest: md.system.manifestDigest,
      },
      {
        type: "md_protocol" as const,
        id: md.protocol.id,
        revision: md.protocol.revision,
        digest: md.protocol.protocolDigest,
      },
      ...md.decisionRefs.map((reference) => ({
        type: "decision" as const,
        id: reference.id,
        revision: reference.revision,
        digest: reference.decisionDigest,
        requestId: reference.approvalRef,
      })),
    ]) {
      const provenance = await this.options.store.getMissionProvenance(candidate.plan.missionId);
      const subjectPolicy =
        subject.type === "decision"
          ? (md.protocol.preparationPolicyDigest ?? policy.policyDigest)
          : policy.policyDigest;
      const existing = provenance.approvals.find(
        (item) =>
          item.subjectType === subject.type &&
          item.subjectId === subject.id &&
          item.subjectRevision === subject.revision &&
          item.payloadDigest === subject.digest &&
          item.policyDigest === subjectPolicy &&
          (!("requestId" in subject) || item.id === subject.requestId),
      );
      if (existing) {
        if (subjectPolicy !== policy.policyDigest) {
          await this.options.store.assertApprovalValid(existing.id, {
            now: this.now().toISOString(),
            currentPolicyDigest: subjectPolicy,
          });
        }
        if (existing.expiresAt && Date.parse(existing.expiresAt) <= this.now().getTime())
          throw new ScientificApprovalExpiredError(existing.id, existing.expiresAt);
        if (
          existing.requestedFromRole !== policy.minimumApprovalRole ||
          !["pending", "approved"].includes(existing.state)
        ) {
          throw new MissionApplicationError(
            "CONFLICT",
            `MD subject ${subject.id} has an expired, rejected, or incompatible approval; submit a new reviewed material revision`,
          );
        }
        continue;
      }
      if (subjectPolicy !== policy.policyDigest)
        throw new MissionApplicationError(
          "APPROVAL_REQUIRED",
          "Preparation policy handoff requires an existing exact approved decision",
        );
      const priorDecisionApproval =
        "requestId" in subject
          ? provenance.approvals.find((item) => item.id === subject.requestId)
          : undefined;
      if (priorDecisionApproval)
        throw new ScientificApprovalPolicyMismatchError(
          priorDecisionApproval.id,
          priorDecisionApproval.policyDigest,
          policy.policyDigest,
        );
      await this.options.store.createApprovalRequest(
        ApprovalRequestSchema.parse({
          id:
            "requestId" in subject
              ? subject.requestId
              : `approval-${digestCanonical({ subject, policy: policy.policyDigest }).slice(0, 32)}`,
          missionId: candidate.plan.missionId,
          subjectType: subject.type,
          subjectId: subject.id,
          subjectVersion: subject.revision,
          subjectRevision: subject.revision,
          state: "pending",
          requestedFromRole: policy.minimumApprovalRole,
          payloadDigest: subject.digest,
          policyDigest: policy.policyDigest,
          editableFields: [],
          requestedBy: context.authenticatedActor,
          requestedAt: this.now().toISOString(),
          ...(expiresAt ? { expiresAt } : {}),
        }),
      );
    }
  }
  private async compileMd(candidate: MissionCandidate, context: C, projectId: string) {
    const md = candidate.md!;
    const policy = context.mdCompilerPolicy!;
    const provenance = await this.options.store.getMissionProvenance(candidate.plan.missionId);
    const plan = provenance.plans.find((item) => item.id === candidate.plan.id)!;
    if (plan.status !== "approved")
      throw new MissionApplicationError(
        "APPROVAL_REQUIRED",
        "MD plan requires exact human approval",
      );
    const approvals = provenance.approvals.filter(
      (item) =>
        this.belongsToCandidate(item, candidate, provenance) &&
        item.state === "approved" &&
        item.policyDigest ===
          (item.subjectType === "decision"
            ? (md.protocol.preparationPolicyDigest ?? policy.policyDigest)
            : policy.policyDigest),
    );
    const find = (type: ApprovalRequest["subjectType"], id: string) => {
      const item = approvals.find((value) => value.subjectType === type && value.subjectId === id);
      if (!item)
        throw new MissionApplicationError(
          "APPROVAL_REQUIRED",
          `MD subject ${id} requires exact human approval`,
        );
      return item;
    };
    const planApproval = find("plan", plan.id),
      systemApproval = find("biomolecular_system_manifest", md.system.id),
      protocolApproval = find("md_protocol", md.protocol.id);
    const decisionApprovals = md.decisionRefs.map((item) => {
      const approval = find("decision", item.id);
      if (approval.id !== item.approvalRef)
        throw new MissionApplicationError(
          "APPROVAL_REQUIRED",
          "MD decision approval differs from frozen preparation",
        );
      return approval;
    });
    for (const approval of [planApproval, systemApproval, protocolApproval, ...decisionApprovals])
      await this.options.store.assertApprovalValid(approval.id, {
        now: this.now().toISOString(),
        currentPolicyDigest:
          approval.subjectType === "decision"
            ? (md.protocol.preparationPolicyDigest ?? policy.policyDigest)
            : policy.policyDigest,
      });
    const system = assertPublishedBiomolecularSystemManifestDigest(
      await this.options.mdStore!.getSystemManifest(md.system.id, md.system.revision),
    );
    const protocol = (await this.options.mdStore!.getProtocol(
      md.protocol.id,
      md.protocol.revision,
    ))!;
    const compiled = compileMdWorkflowProtocol({
      plan: {
        id: plan.id,
        missionId: plan.missionId,
        version: plan.version,
        revision: plan.revision,
        status: "approved",
        planDigest: plan.planDigest,
        createdAt: plan.createdAt,
        updatedAt: plan.updatedAt,
      },
      planApproval,
      system,
      systemApproval,
      protocol,
      protocolApproval,
      decisionRefs: md.decisionRefs,
      decisionApprovals,
      stageSkillBindings: md.stageSkillBindings,
      policy,
      environment: context.mdEnvironment!,
    });
    // Lifecycle state is mutable; scientific definitions remain byte-exact on retries.
    const definition = (work: WorkUnit) => {
      const {
        state: _state,
        revision: _revision,
        claimOwner: _owner,
        claimExpiresAt: _expiry,
        jobId: _job,
        attemptId: _attempt,
        updatedAt: _at,
        ...material
      } = work;
      return digestCanonical(material);
    };
    const missing: WorkUnit[] = [];
    for (const work of compiled.workUnits) {
      const existing = await this.options.store.getWorkUnit(work.id);
      if (existing && definition(existing) !== definition(work))
        throw new MissionApplicationError(
          "CANDIDATE_CHANGED",
          "Persisted MD work unit differs from exact compiled candidate",
        );
      if (!existing) missing.push(work);
    }
    await this.access({ projectId, missionId: plan.missionId }, context);
    await this.options.store.createWorkUnits(missing);
    let mission = (await this.options.store.getMission(plan.missionId))!;
    if (mission.activePlanId !== null && mission.activePlanId !== plan.id) {
      const current = await this.options.store.getMissionProvenance(mission.id);
      assertCompletedMdPredecessor({
        state: mission.state,
        activePlanId: mission.activePlanId,
        parentPlanId: plan.parentPlanId,
        workUnits: current.workUnits,
        operations: current.operations,
        plans: current.plans,
        approvals: current.approvals,
      });
    }
    if (mission.activePlanId !== plan.id)
      mission = await this.options.store.activatePlan({
        missionId: mission.id,
        planId: plan.id,
        expectedMissionRevision: mission.revision,
        actor: context.authenticatedActor,
        at: this.now().toISOString(),
      });
    if (mission.activePlanId !== plan.id)
      throw new MissionApplicationError("CONFLICT", "A different plan is already active");
    if (mission.state === "awaiting_approval")
      await this.options.store.transitionMission({
        missionId: mission.id,
        expectedRevision: mission.revision,
        to: "ready",
        reason: `human_md_candidate_compiled:${compiled.graphDigest}`,
        actor: context.authenticatedActor,
        at: this.now().toISOString(),
      });
    else if (
      ![
        "ready",
        "executing",
        "observing",
        "diagnosing",
        "validating",
        "completed",
        "paused",
        "blocked",
      ].includes(mission.state)
    )
      throw new MissionApplicationError(
        "CONFLICT",
        "Mission cannot reuse compiled MD candidate in its current state",
      );
    for (const work of compiled.workUnits) {
      const persisted = (await this.options.store.getWorkUnit(work.id))!;
      if (persisted.state === "created")
        await this.options.store.transitionWorkUnit({
          workUnitId: persisted.id,
          expectedRevision: persisted.revision,
          to: "ready",
          at: this.now().toISOString(),
        });
    }
    return compiled;
  }
}

/** New MD phases may activate only after their exact previous plan is closed. */
export function assertCompletedMdPredecessor(input: {
  state: string;
  activePlanId: string;
  parentPlanId?: string;
  workUnits: readonly { id: string; planId: string; state: string }[];
  operations: readonly { workUnitId: string; state: string }[];
  plans?: readonly {
    id: string;
    parentPlanId?: string;
    version: number;
    revision: number;
    planDigest: string;
  }[];
  approvals?: readonly {
    subjectType: string;
    subjectId: string;
    subjectVersion: number;
    subjectRevision: number;
    payloadDigest: string;
    state: string;
  }[];
}): void {
  const predecessorIds = new Set([input.activePlanId]);
  let ancestorId = input.parentPlanId;
  while (ancestorId && ancestorId !== input.activePlanId) {
    const ancestor = input.plans?.find((plan) => plan.id === ancestorId);
    const rejected =
      ancestor &&
      input.approvals?.some(
        (approval) =>
          approval.subjectType === "plan" &&
          approval.subjectId === ancestor.id &&
          approval.subjectVersion === ancestor.version &&
          approval.subjectRevision === ancestor.revision &&
          approval.payloadDigest === ancestor.planDigest &&
          approval.state === "rejected",
      );
    if (
      !ancestor ||
      !rejected ||
      predecessorIds.has(ancestorId) ||
      input.workUnits.some((work) => work.planId === ancestorId)
    )
      break;
    predecessorIds.add(ancestorId);
    ancestorId = ancestor.parentPlanId;
  }
  const units = input.workUnits.filter((work) => predecessorIds.has(work.planId));
  const ids = new Set(units.map((work) => work.id));
  if (
    input.state !== "awaiting_approval" ||
    ancestorId !== input.activePlanId ||
    units.some((work) => !["succeeded", "cancelled"].includes(work.state)) ||
    input.operations.some(
      (operation) =>
        ids.has(operation.workUnitId) && !["confirmed", "abandoned"].includes(operation.state),
    )
  )
    throw new MissionApplicationError(
      "CONFLICT",
      "MD successor requires its exact completed preparation plan and no live predecessor effects",
    );
}
