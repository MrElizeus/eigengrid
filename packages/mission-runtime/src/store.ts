/** Compatibility facade for typed mission services. Domain repositories own each
 * operation's transaction; forwarding never opens a nested transaction. */
import {
  type ActorIdentity,
  type ApprovalRequest,
  type ApprovalResponse,
  type CriticFinding,
  type EvidenceReference,
  type ExternalOperation,
  type ExternalOperationState,
  type MissionBudget,
  type MissionCheckpoint,
  type MissionState,
  type ModelInvocationIntent,
  type ModelInvocationRecord,
  type OperationReceipt,
  type PlanStatus,
  type PlanningClaim,
  type ResolvedSkillGraph,
  type ScientificAssessment,
  type ScientificDecision,
  type ScientificMission,
  type ScientificObservation,
  type ScientificPlan,
  type ValidationResult,
  type WorkUnit,
  type WorkUnitState,
} from "@eigengrid/scientific-schema";
import { type ScientificMissionProjectAssociation } from "./mission-project";
import { type OperationIntentOutbox, type ScientificEffectAdmission } from "./operation-outbox";
import { ScientificApprovals } from "./scientific-approvals";
import { ScientificBudgets } from "./scientific-budgets";
import { ScientificEvidence } from "./scientific-evidence";
import { ScientificMissions } from "./scientific-missions";
import { ScientificOperations } from "./scientific-operations";
import { ScientificPlans } from "./scientific-plans";
import { ScientificProvenance } from "./scientific-provenance";
import { ScientificStoreContext } from "./scientific-store-context";
import { BudgetReservation, CreateMissionInProjectInput } from "./scientific-store-validation";
import { ScientificWorkUnits } from "./scientific-work-units";
import type {
  ExactApprovalContext,
  ExactApprovalDecisionContext,
  MissionProvenance,
  OperationIntentContext,
  PlanningClaimResult,
  ScientificDatabase,
  WorkUnitClaimResult,
} from "./types";

export {
  computePlanDigest,
  computeProtocolDigest,
  computeSkillGraphDigest,
} from "./scientific-store-validation";
export type { CreateMissionInProjectInput } from "./scientific-store-validation";
export class ScientificStore {
  private readonly plans: ScientificPlans;
  private readonly missions: ScientificMissions;
  private readonly budgets: ScientificBudgets;
  private readonly workUnits: ScientificWorkUnits;
  private readonly evidence: ScientificEvidence;
  private readonly approvals: ScientificApprovals;
  private readonly operations: ScientificOperations;
  private readonly provenance: ScientificProvenance;
  constructor(database: ScientificDatabase) {
    const context = new ScientificStoreContext(database);
    this.plans = new ScientificPlans(context);
    this.missions = new ScientificMissions(context);
    this.budgets = new ScientificBudgets(context);
    this.workUnits = new ScientificWorkUnits(context);
    this.evidence = new ScientificEvidence(context);
    this.approvals = new ScientificApprovals(context);
    this.operations = new ScientificOperations(context);
    this.provenance = new ScientificProvenance(context);
  }

  // ── Missions and budgets ─────────────────────────────────

  async createMission(
    missionInput: ScientificMission,
    budgetInput: MissionBudget,
  ): Promise<ScientificMission> {
    return this.missions.createMission(missionInput, budgetInput);
  }

  /**
   * Production V1 multi-user creation path. Unlike the legacy createMission
   * helper, this binds a human-owned mission to its selected project before it
   * can enter the production planning/effect route. The association is created
   * in the same PostgreSQL transaction as mission and budget; it is not a
   * mutable request field or a later delivery-time inference.
   */
  async createMissionInProject(input: CreateMissionInProjectInput): Promise<ScientificMission> {
    return this.missions.createMissionInProject(input);
  }

  /**
   * Explicit guard for the production planning façade. Legacy historical
   * missions intentionally keep their old createMission semantics; they cannot
   * use this route until an administrator performs a separately reviewed
   * migration. New external effects revalidate again at their own boundary.
   */
  async assertProductionProjectPlanningAccess(input: {
    projectId: string;
    ownerUserId: string;
  }): Promise<void> {
    return this.missions.assertProductionProjectPlanningAccess(input);
  }

  async assertProductionMissionPlanningAccess(input: {
    missionId: string;
    projectId: string;
    ownerUserId: string;
  }): Promise<{
    mission: ScientificMission;
    association: ScientificMissionProjectAssociation;
  }> {
    return this.missions.assertProductionMissionPlanningAccess(input);
  }

  async getMissionProjectAssociation(
    missionId: string,
  ): Promise<ScientificMissionProjectAssociation | null> {
    return this.missions.getMissionProjectAssociation(missionId);
  }

  async getMission(missionId: string): Promise<ScientificMission | null> {
    return this.missions.getMission(missionId);
  }

  async getMissionBudget(missionId: string): Promise<MissionBudget> {
    return this.missions.getMissionBudget(missionId);
  }

  async listRecoverableMissions(): Promise<ScientificMission[]> {
    return this.missions.listRecoverableMissions();
  }

  async transitionMission(input: {
    missionId: string;
    expectedRevision: number;
    to: MissionState;
    reason: string;
    actor: ActorIdentity;
    at: string;
  }): Promise<ScientificMission> {
    return this.missions.transitionMission(input);
  }

  async activatePlan(input: {
    missionId: string;
    planId: string;
    expectedMissionRevision: number;
    actor: ActorIdentity;
    at: string;
  }): Promise<ScientificMission> {
    return this.missions.activatePlan(input);
  }

  async reserveBudget(input: {
    missionId: string;
    expectedBudgetRevision: number;
    reservation: BudgetReservation;
  }): Promise<MissionBudget> {
    return this.budgets.reserveBudget(input);
  }

  async settleBudgetReservation(input: {
    missionId: string;
    reservationId: string;
    expectedBudgetRevision: number;
    state: "consumed" | "released" | "ambiguous";
    at: string;
  }): Promise<MissionBudget> {
    return this.budgets.settleBudgetReservation(input);
  }

  /**
   * Persists a model intent and reserves its conservative maximum budget before a provider call.
   * A caller must not invoke a provider until this method returns admitted=true.
   */
  async beginModelInvocation(input: ModelInvocationIntent): Promise<{
    admitted: boolean;
    reason?: "already_in_flight" | "already_observed" | "already_unavailable" | "already_ambiguous";
    intent: ModelInvocationIntent;
  }> {
    return this.budgets.beginModelInvocation(input);
  }

  /** Records the first durable observation after a provider promise settles. */
  async observeModelInvocation(input: {
    intentId: string;
    status: "observed" | "unavailable" | "ambiguous";
    observedAt: string;
    responseDigest?: string;
    inputTokens?: number;
    outputTokens?: number;
    cost?: number;
    errorCode?: string;
  }): Promise<ModelInvocationIntent> {
    return this.budgets.observeModelInvocation(input);
  }

  /** Acquires one durable planner lease for an exact mission revision. */
  async acquirePlanningClaim(input: {
    missionId: string;
    expectedMissionRevision: number;
    parentPlanId?: string;
    proposedNextVersion: number;
    ownerId: string;
    now: string;
    expiresAt: string;
    claimId?: string;
  }): Promise<PlanningClaimResult> {
    return this.plans.acquirePlanningClaim(input);
  }

  /** Renews an active planner lease with an exact claim identity and expiry CAS. */
  async renewPlanningClaim(input: {
    claimId: string;
    missionId: string;
    ownerId: string;
    now: string;
    expiresAt: string;
  }): Promise<PlanningClaim> {
    return this.plans.renewPlanningClaim(input);
  }

  async releasePlanningClaim(input: {
    claimId: string;
    ownerId: string;
    at: string;
    status: "completed" | "released";
    reason: string;
  }): Promise<PlanningClaim> {
    return this.plans.releasePlanningClaim(input);
  }

  // ── Skill resolutions and plans ──────────────────────────

  async createSkillResolution(graphInput: ResolvedSkillGraph): Promise<ResolvedSkillGraph> {
    return this.plans.createSkillResolution(graphInput);
  }

  async createPlan(planInput: ScientificPlan): Promise<ScientificPlan> {
    return this.plans.createPlan(planInput);
  }

  async getPlan(planId: string): Promise<ScientificPlan | null> {
    return this.plans.getPlan(planId);
  }

  async listPlans(missionId: string): Promise<ScientificPlan[]> {
    return this.plans.listPlans(missionId);
  }

  /** Plan status is lifecycle metadata; its immutable content revision and digest do not change. */
  async transitionPlan(input: {
    planId: string;
    expectedRevision: number;
    from: PlanStatus;
    to: PlanStatus;
    at: string;
  }): Promise<ScientificPlan> {
    return this.plans.transitionPlan(input);
  }

  // ── Work units, dependencies, and leased claims ──────────

  async createWorkUnits(workUnitInputs: WorkUnit[]): Promise<WorkUnit[]> {
    return this.workUnits.createWorkUnits(workUnitInputs);
  }

  async getWorkUnit(workUnitId: string): Promise<WorkUnit | null> {
    return this.workUnits.getWorkUnit(workUnitId);
  }

  async listWorkUnits(missionId: string): Promise<WorkUnit[]> {
    return this.workUnits.listWorkUnits(missionId);
  }

  async listRunnableWorkUnits(missionId: string, now: string): Promise<WorkUnit[]> {
    return this.workUnits.listRunnableWorkUnits(missionId, now);
  }

  async transitionWorkUnit(input: {
    workUnitId: string;
    expectedRevision: number;
    to: WorkUnitState;
    at: string;
    claimOwner?: string;
    jobId?: string | null;
    attemptId?: string | null;
  }): Promise<WorkUnit> {
    return this.workUnits.transitionWorkUnit(input);
  }

  async completeMdWorkUnit(input: {
    workUnitId: string;
    expectedRevision: number;
    stageResultId: string;
    stageResultDigest: string;
    assessmentId: string;
    assessmentRevision: number;
    assessmentDigest: string;
    at: string;
    claimOwner?: string;
  }): Promise<WorkUnit> {
    return this.workUnits.completeMdWorkUnit(input);
  }

  async claimWorkUnit(input: {
    workUnitId: string;
    ownerId: string;
    now: string;
    expiresAt: string;
    claimId?: string;
    policyDigest?: string;
  }): Promise<WorkUnitClaimResult> {
    return this.workUnits.claimWorkUnit(input);
  }

  async renewWorkUnitClaim(input: {
    workUnitId: string;
    claimId: string;
    ownerId: string;
    expectedRevision?: number;
    now: string;
    expiresAt: string;
  }): Promise<WorkUnit> {
    return this.workUnits.renewWorkUnitClaim(input);
  }

  // ── Evidence, checkpoints, and decisions ─────────────────

  async createEvidence(referenceInput: EvidenceReference): Promise<EvidenceReference> {
    return this.evidence.createEvidence(referenceInput);
  }

  async createCheckpoint(checkpointInput: MissionCheckpoint): Promise<MissionCheckpoint> {
    return this.evidence.createCheckpoint(checkpointInput);
  }

  async createDecision(decisionInput: ScientificDecision): Promise<ScientificDecision> {
    return this.evidence.createDecision(decisionInput);
  }

  // ── Exact-revision approvals ─────────────────────────────

  async createApprovalRequest(requestInput: ApprovalRequest): Promise<ApprovalRequest> {
    return this.approvals.createApprovalRequest(requestInput);
  }

  async respondToApproval(
    requestId: string,
    responseInput: ApprovalResponse,
    context: ExactApprovalDecisionContext,
  ): Promise<ApprovalRequest> {
    return this.approvals.respondToApproval(requestId, responseInput, context);
  }

  async assertApprovalValid(
    requestId: string,
    context: ExactApprovalContext,
  ): Promise<ApprovalRequest> {
    return this.approvals.assertApprovalValid(requestId, context);
  }

  // ── Intent-before-effect operations and receipts ─────────

  async createOperationIntent(
    operationInput: ExternalOperation,
    context: OperationIntentContext,
  ): Promise<ExternalOperation> {
    return this.operations.createOperationIntent(operationInput, context);
  }

  async getExternalOperation(operationId: string): Promise<ExternalOperation | null> {
    return this.operations.getExternalOperation(operationId);
  }

  async getOperationIntentOutbox(operationId: string): Promise<OperationIntentOutbox | null> {
    return this.operations.getOperationIntentOutbox(operationId);
  }

  async getEffectAdmission(operationId: string): Promise<ScientificEffectAdmission | null> {
    return this.operations.getEffectAdmission(operationId);
  }

  /** Discovery only. Every delivery MUST still cross beginWorkUnitEffect's authority checks. */
  async listPendingOperationOutbox(input: {
    missionId: string;
    limit?: number;
    after?: { createdAt: string; operationId: string };
  }): Promise<OperationIntentOutbox[]> {
    return this.operations.listPendingOperationOutbox(input);
  }

  async transitionExternalOperation(input: {
    operationId: string;
    expectedRevision: number;
    to: Exclude<ExternalOperationState, "confirmed">;
    at: string;
    externalIdentity?: Record<string, unknown>;
  }): Promise<ExternalOperation> {
    return this.operations.transitionExternalOperation(input);
  }

  async finalizeOperationReceipt(
    operationId: string,
    expectedRevision: number,
    receiptInput: OperationReceipt,
  ): Promise<{ operation: ExternalOperation; receipt: OperationReceipt }> {
    return this.operations.finalizeOperationReceipt(operationId, expectedRevision, receiptInput);
  }

  async reconcileAmbiguousOperation(
    input:
      | {
          operationId: string;
          expectedRevision: number;
          resolution: "acknowledged" | "failed" | "abandoned";
          at: string;
          externalIdentity?: Record<string, unknown>;
        }
      | {
          operationId: string;
          expectedRevision: number;
          resolution: "receipt";
          receipt: OperationReceipt;
        },
  ): Promise<ExternalOperation> {
    return this.operations.reconcileAmbiguousOperation(input);
  }

  async listOperationsForReconciliation(missionId: string): Promise<ExternalOperation[]> {
    return this.operations.listOperationsForReconciliation(missionId);
  }

  // ── Observations, validation, models, and assessments ─────

  async createObservation(observationInput: ScientificObservation): Promise<ScientificObservation> {
    return this.evidence.createObservation(observationInput);
  }

  async createValidationResult(resultInput: ValidationResult): Promise<ValidationResult> {
    return this.evidence.createValidationResult(resultInput);
  }

  async createModelInvocation(recordInput: ModelInvocationRecord): Promise<ModelInvocationRecord> {
    return this.evidence.createModelInvocation(recordInput);
  }

  async createCriticFinding(findingInput: CriticFinding): Promise<CriticFinding> {
    return this.evidence.createCriticFinding(findingInput);
  }

  async createAssessment(assessmentInput: ScientificAssessment): Promise<ScientificAssessment> {
    return this.evidence.createAssessment(assessmentInput);
  }

  // ── Complete objective-to-assessment provenance ──────────

  async getMissionProvenance(missionId: string): Promise<MissionProvenance> {
    return this.provenance.getMissionProvenance(missionId);
  }
}
