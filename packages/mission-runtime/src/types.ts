import type { DatabaseLike, DbTransaction } from "@eigengrid/db";
import type {
  ActorIdentity,
  ApprovalRequest,
  CriticFinding,
  EvidenceReference,
  ExternalOperation,
  MissionBudget,
  MissionCheckpoint,
  ModelInvocationIntent,
  ModelInvocationRecord,
  OperationReceipt,
  PlanningClaim,
  ResolvedSkillGraph,
  ScientificAssessment,
  ScientificDecision,
  ScientificMission,
  ScientificObservation,
  ScientificPlan,
  ValidationResult,
  WorkUnit,
} from "@eigengrid/scientific-schema";

export interface ScientificTransaction extends DbTransaction {
  queryRows<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: Record<string, unknown> | unknown[],
  ): Promise<T[]>;
}

export type ScientificDatabase = Pick<DatabaseLike, "_provider" | "beginTransaction">;

export type WorkUnitClaimFailureReason =
  | "not_ready"
  | "dependency_blocked"
  | "approval_required"
  | "lease_active"
  | "reconciliation_required"
  | "incompatible_mission"
  | "lost_race";

export type WorkUnitClaimResult =
  | {
      claimed: true;
      claimId: string;
      workUnit: WorkUnit;
      ownerId: string;
      expiresAt: string;
    }
  | {
      claimed: false;
      reason: WorkUnitClaimFailureReason;
      message: string;
      workUnit?: WorkUnit;
    };

export interface MissionTransitionRecord {
  missionId: string;
  sequence: number;
  fromState: ScientificMission["state"] | null;
  toState: ScientificMission["state"];
  fromRevision: number;
  toRevision: number;
  reason: string;
  actor: ScientificMission["requestedBy"];
  occurredAt: string;
}

export interface WorkUnitClaimRecord {
  id: string;
  workUnitId: string;
  ownerId: string;
  acquiredAt: string;
  expiresAt: string;
  releasedAt?: string;
  releaseReason?: string;
  active: boolean;
}

export type PlanningClaimResult =
  | { claimed: true; claim: PlanningClaim }
  | {
      claimed: false;
      reason: "active" | "stale_revision" | "stale_parent";
      message: string;
      claim?: PlanningClaim;
    };

export interface MissionProvenance {
  mission: ScientificMission;
  budget: MissionBudget;
  budgetReservations: MissionBudget["reservations"];
  skillResolutions: ResolvedSkillGraph[];
  plans: ScientificPlan[];
  workUnits: WorkUnit[];
  workUnitClaims: WorkUnitClaimRecord[];
  checkpoints: MissionCheckpoint[];
  decisions: ScientificDecision[];
  approvals: ApprovalRequest[];
  operations: ExternalOperation[];
  receipts: OperationReceipt[];
  evidence: EvidenceReference[];
  observations: ScientificObservation[];
  validations: ValidationResult[];
  modelInvocationIntents: ModelInvocationIntent[];
  modelInvocations: ModelInvocationRecord[];
  planningClaims: PlanningClaim[];
  criticFindings: CriticFinding[];
  assessments: ScientificAssessment[];
  transitions: MissionTransitionRecord[];
  missingReferences: string[];
  complete: boolean;
}

export interface ExactApprovalContext {
  now: string;
  currentPolicyDigest: string;
}

/** Authenticated application authority used only when recording a human decision. */
export interface ExactApprovalDecisionContext extends ExactApprovalContext {
  authenticatedActor: ActorIdentity;
  authorizedRoles: string[];
}

/** Current lease authority required before a persisted operation may start an effect. */
export interface OperationIntentContext {
  claimOwner: string;
  now: string;
}

export interface SubjectSnapshot {
  missionId: string;
  version: number;
  revision: number;
  digest: string;
  requiredDecisionIds: string[];
  requiredDecisions?: SubjectDecisionRequirement[];
  decisionPlanId?: string;
}

/** Exact material decision required by a subject snapshot. Optional fields denote legacy IDs. */
export interface SubjectDecisionRequirement {
  id: string;
  revision?: number;
  digest?: string;
  approvalRef?: string;
}
