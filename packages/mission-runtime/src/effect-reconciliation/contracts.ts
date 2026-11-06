import {
  ScientificMissionSchema,
  type ExternalOperation,
  type OperationReceipt,
  type WorkUnit,
  type WorkUnitState,
} from "@eigengrid/scientific-schema";
import { type MdEffectAuthorityEvidence } from "../md-effect-authority";
import { type ScientificEffectAdmission } from "../operation-outbox";

export interface MdSubmissionAuthorityInput {
  operationId: string;
  claimOwner: string;
  currentPolicyDigest: string;
}

/** Head-internal, freshly read prerequisite for signing, NOT a capability or an
 * effect receipt. The transport must still persist its exact immutable delivery
 * binding/body, resolve current project/UID authority and verify engine bytes.
 */
export interface MdSubmissionAuthority extends MdEffectAuthorityEvidence {
  operation: ExternalOperation;
  workUnit: WorkUnit;
  mission: ReturnType<typeof ScientificMissionSchema.parse>;
  admission: ScientificEffectAdmission;
  checkedAt: string;
  expiresAt: string;
}

export interface BeginWorkUnitEffectInput {
  operationId: string;
  expectedOperationRevision: number;
  workUnitId: string;
  expectedWorkUnitRevision: number;
  claimOwner: string;
  jobId: string;
  attemptId: string;
  /** Policy authority resolved immediately before crossing the effect boundary. */
  currentPolicyDigest: string;
  at: string;
}

export interface BeginWorkUnitEffectResult {
  operation: ExternalOperation;
  workUnit: WorkUnit;
}

export type ReconciledEffectOutcome = "completed" | "failed" | "cancelled";

export interface ReconcileWorkUnitEffectInput {
  operationId: string;
  workUnitId: string;
  jobId: string;
  attemptId: string;
  outcome: ReconciledEffectOutcome;
  retryable?: boolean;
  at: string;
}

export interface ReconcileWorkUnitEffectResult {
  workUnit: WorkUnit;
  operation: ExternalOperation;
  receipt: OperationReceipt;
  transitionedThrough: WorkUnitState[];
  alreadyReconciled: boolean;
}

export interface ScientificEffectPersistence {
  beginWorkUnitEffect(input: BeginWorkUnitEffectInput): Promise<BeginWorkUnitEffectResult>;
  reconcileWorkUnitEffect(
    input: ReconcileWorkUnitEffectInput,
  ): Promise<ReconcileWorkUnitEffectResult>;
}

export type ScientificEffectReconciler = ScientificEffectPersistence;
