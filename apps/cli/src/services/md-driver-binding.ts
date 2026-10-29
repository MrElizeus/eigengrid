import {
  MdStageOperationRequestSchema,
  digestCanonical,
  type ExternalOperation,
  type MdStageOperationRequest,
  type WorkUnit,
} from "@eigengrid/scientific-schema";
import {
  assertMdStageOperationRequestAuthority,
  type ScientificDatabase,
} from "@eigengrid/mission-runtime";
import type { VerifiedAmberStageBundle } from "./amber-stage-bundle";
import type { MdResultCollectionOutcome } from "./md-result-collector";
import type {
  HeadMdAmberDeliverySession,
  HeadMdObservationSession,
} from "./head-md-site-authority";

/**
 * This is the sole deterministic identity for a first MD-stage operation.
 * It deliberately derives from the immutable request, rather than a Slurm
 * JobID, capability nonce, socket response, or caller-selected attempt ID.
 */
export function mdDriverOperationIdentity(
  workUnit: WorkUnit,
  requestValue: unknown,
): {
  operationId: string;
  reservationId: string;
  idempotencyKey: string;
} {
  const request = assertMdStageOperationRequestAuthority(workUnit, requestValue);
  const requestDigest = digestCanonical(request);
  const token = digestCanonical({
    schemaVersion: "eigengrid.md-driver-operation/v1",
    missionId: workUnit.missionId,
    planId: workUnit.planId,
    planVersion: workUnit.planVersion,
    workUnitId: workUnit.id,
    requestDigest,
  });
  return {
    operationId: `operation-md-${token}`,
    reservationId: `reservation-md-${token}`,
    idempotencyKey: `md-stage/${workUnit.missionId}/${workUnit.planId}/${workUnit.id}/${requestDigest}`,
  };
}

/** Read the immutable request only after the bundle reader has independently
 * rehashed/reconstructed it. The driver never composes request fields from a
 * browser, model, Slurm profile, or unverified CAS descriptor.
 */
export function requestFromVerifiedAmberBundle(
  workUnit: WorkUnit,
  bundle: VerifiedAmberStageBundle,
): MdStageOperationRequest {
  const request = MdStageOperationRequestSchema.parse(bundle.manifest.request);
  return assertMdStageOperationRequestAuthority(workUnit, request);
}

/** Narrow Head composition port. Production construction is the protected
 * site-authority reader; tests may inject a strict equivalent but never raw
 * UID/GID, PEM, profile, socket, or delivery body fields from an API request.
 */
export interface MdDeliverySessionFactory {
  createAmberObservationSession?(
    database: ScientificDatabase,
    association: { subject: string; projectId: string },
    now?: () => Date,
  ): HeadMdObservationSession;
  createAmberDeliverySession(
    database: ScientificDatabase,
    association: { subject: string; projectId: string },
    bundle: VerifiedAmberStageBundle,
    now?: () => Date,
  ): HeadMdAmberDeliverySession;
}

export interface CanonicalMdExecutionGateway {
  /** PostgreSQL is checked again at the MD entry point; SQLite is not a
   * production fallback for signing/delivery authority. */
  readonly database: ScientificDatabase;
  /** Resolves/revalidates an already-published bundle before any admission TX. */
  readonly prepareBundle: (workUnit: WorkUnit) => Promise<VerifiedAmberStageBundle>;
  readonly siteAuthority: MdDeliverySessionFactory;
  /** Historical result adoption; never a submit/retry capability. */
  readonly collectResult?: (
    operationId: string,
    signal?: AbortSignal,
  ) => Promise<MdResultCollectionOutcome>;
  /** Deterministic finalization/continuation of an ALREADY collected effect. */
  readonly postprocessResult?: (
    operationId: string,
    ownerId: string,
    signal?: AbortSignal,
  ) => Promise<import("./md-stage-postprocessor").MdPostprocessingOutcome>;
  /** The default is the closed Unix-socket client. Injection exists only for
   * local boundary tests; it cannot select the socket or alter the signed wire. */
  readonly callSubmitter?: (socketPath: string, wire: Uint8Array) => Promise<unknown>;
}

export function mdTransportIdentity(
  operation: ExternalOperation,
  input: {
    deliveryDigest: string;
    capabilityRequestId: string;
    status: "consumed" | "already_consumed";
    receipt:
      | { status: "acknowledged"; jobId: string; cluster: string }
      | { status: "indeterminate" };
  },
): Record<string, unknown> {
  return {
    schemaVersion: "eigengrid.md-submitter-transport/v1",
    operationId: operation.id,
    deliveryDigest: input.deliveryDigest,
    capabilityRequestId: input.capabilityRequestId,
    transportStatus: input.status,
    receiptStatus: input.receipt.status,
    ...(input.receipt.status === "acknowledged"
      ? { slurmJobId: input.receipt.jobId, slurmCluster: input.receipt.cluster }
      : {}),
  };
}
