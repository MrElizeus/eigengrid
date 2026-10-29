import { z } from "zod";
import {
  ActorIdentitySchema,
  DigestSchema,
  ExternalOperationSchema,
  IdSchema,
  TimestampSchema,
  canonicalJson,
  digestCanonical,
  type ExternalOperation,
} from "@eigengrid/scientific-schema";
import { ScientificIntegrityError } from "./errors";
import { mdStageEffectIdentity } from "./md-effect-authority";
import type { ScientificTransaction } from "./types";

/** Immutable delivery record; ExternalOperation remains the only lifecycle owner. */
export const OperationIntentOutboxSchema = z
  .object({
    schemaVersion: z.literal("eigengrid.operation-intent-outbox/v1"),
    intent: ExternalOperationSchema,
    envelopeDigest: DigestSchema,
  })
  .strict();
export type OperationIntentOutbox = z.infer<typeof OperationIntentOutboxSchema>;

/** Consumed authority, NOT evidence that sbatch accepted or the engine ran. */
export const ScientificEffectAdmissionSchema = z
  .object({
    schemaVersion: z.literal("eigengrid.scientific-effect-admission/v1"),
    operationId: IdSchema,
    missionId: IdSchema,
    workUnitId: IdSchema,
    outboxDigest: DigestSchema,
    requestDigest: DigestSchema,
    claimId: IdSchema,
    claimOwner: IdSchema,
    claimExpiresAt: TimestampSchema,
    fencingGeneration: z.number().int().positive().safe(),
    jobId: IdSchema,
    attemptId: IdSchema,
    plan: z
      .object({
        id: IdSchema,
        version: z.number().int().positive(),
        revision: z.number().int().positive(),
        digest: DigestSchema,
      })
      .strict(),
    approvalId: IdSchema,
    approvalResponseId: IdSchema,
    approvalDigest: DigestSchema,
    approvedBy: ActorIdentitySchema.refine(
      (actor) => actor.kind === "human",
      "A human approval is required",
    ),
    policyDigest: DigestSchema,
    admittedAt: TimestampSchema,
    admissionDigest: DigestSchema,
  })
  .strict();
export type ScientificEffectAdmission = z.infer<typeof ScientificEffectAdmissionSchema>;

type OutboxRow = {
  operation_id: string;
  mission_id: string;
  work_unit_id: string;
  request_digest: string;
  envelope_digest: string;
  payload_json: string;
  created_at: string;
};

function immutableOperationIdentity(operation: ExternalOperation): unknown {
  // Policy can be revalidated at admission against a new exact human approval;
  // both the original intent policy and the admitted policy remain durable.
  const {
    state: _state,
    revision: _revision,
    updatedAt: _updatedAt,
    externalIdentity: _externalIdentity,
    receiptId: _receiptId,
    policyDigest: _policyDigest,
    ...identity
  } = operation;
  return identity;
}

export function assertOperationIntentOutbox(
  value: unknown,
  operation?: ExternalOperation,
): OperationIntentOutbox {
  const parsed = OperationIntentOutboxSchema.safeParse(value);
  if (!parsed.success) throw new ScientificIntegrityError("Invalid operation outbox envelope");
  const { envelopeDigest, ...unsigned } = parsed.data;
  const { intent } = unsigned;
  if (
    envelopeDigest !== digestCanonical(unsigned) ||
    intent.state !== "intent" ||
    intent.revision !== 1 ||
    intent.externalIdentity !== undefined ||
    intent.receiptId !== undefined ||
    intent.requestDigest !== digestCanonical(intent.request) ||
    (operation &&
      canonicalJson(immutableOperationIdentity(intent)) !==
        canonicalJson(immutableOperationIdentity(operation)))
  ) {
    throw new ScientificIntegrityError("Operation outbox does not bind the exact durable intent");
  }
  return parsed.data;
}

export async function readOperationIntentOutbox(
  transaction: ScientificTransaction,
  operation: ExternalOperation,
): Promise<OperationIntentOutbox | null> {
  const [row] = await transaction.queryRows<OutboxRow>(
    "SELECT * FROM scientific_operation_outbox WHERE operation_id = $1",
    [operation.id],
  );
  if (!row) return null;
  let value: unknown;
  try {
    value = JSON.parse(row.payload_json);
  } catch {
    throw new ScientificIntegrityError("Invalid operation outbox JSON");
  }
  const outbox = assertOperationIntentOutbox(value, operation);
  if (
    row.operation_id !== outbox.intent.id ||
    row.mission_id !== outbox.intent.missionId ||
    row.work_unit_id !== outbox.intent.workUnitId ||
    row.request_digest !== outbox.intent.requestDigest ||
    row.envelope_digest !== outbox.envelopeDigest ||
    row.created_at !== outbox.intent.createdAt
  ) {
    throw new ScientificIntegrityError("Operation outbox columns differ from their envelope");
  }
  return outbox;
}

/** Caller owns the SAME transaction that inserts ExternalOperation. */
export async function insertOperationIntentOutbox(
  transaction: ScientificTransaction,
  operation: ExternalOperation,
): Promise<OperationIntentOutbox> {
  const unsigned = {
    schemaVersion: "eigengrid.operation-intent-outbox/v1" as const,
    intent: operation,
  };
  const outbox = assertOperationIntentOutbox({
    ...unsigned,
    envelopeDigest: digestCanonical(unsigned),
  });
  await transaction.query(
    `INSERT INTO scientific_operation_outbox
       (operation_id, mission_id, work_unit_id, request_digest, envelope_digest, payload_json, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (operation_id) DO NOTHING`,
    [
      operation.id,
      operation.missionId,
      operation.workUnitId,
      operation.requestDigest,
      outbox.envelopeDigest,
      canonicalJson(outbox),
      operation.createdAt,
    ],
  );
  const persisted = await readOperationIntentOutbox(transaction, operation);
  if (!persisted || canonicalJson(persisted) !== canonicalJson(outbox)) {
    throw new ScientificIntegrityError("Conflicting operation outbox envelope");
  }
  return persisted;
}

export function assertScientificEffectAdmission(value: unknown): ScientificEffectAdmission {
  const parsed = ScientificEffectAdmissionSchema.safeParse(value);
  if (!parsed.success) throw new ScientificIntegrityError("Invalid scientific effect admission");
  const { admissionDigest, ...unsigned } = parsed.data;
  if (
    admissionDigest !== digestCanonical(unsigned) ||
    Date.parse(unsigned.admittedAt) >= Date.parse(unsigned.claimExpiresAt)
  ) {
    throw new ScientificIntegrityError("Scientific effect admission digest or lease is invalid");
  }
  return parsed.data;
}

/** Caller holds the WorkUnit, operation, mission, plan and approval authority locks. */
export async function insertScientificEffectAdmission(
  transaction: ScientificTransaction,
  input: Omit<ScientificEffectAdmission, "schemaVersion" | "admissionDigest">,
): Promise<ScientificEffectAdmission> {
  const unsigned = { schemaVersion: "eigengrid.scientific-effect-admission/v1" as const, ...input };
  const admission = assertScientificEffectAdmission({
    ...unsigned,
    admissionDigest: digestCanonical(unsigned),
  });
  // No ON CONFLICT: crossing this boundary is permitted once, never replayed.
  await transaction.query(
    `INSERT INTO scientific_effect_admissions
       (operation_id, work_unit_id, claim_id, fencing_generation, approval_id, approval_response_id,
        policy_digest, admission_digest, payload_json, admitted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      admission.operationId,
      admission.workUnitId,
      admission.claimId,
      admission.fencingGeneration,
      admission.approvalId,
      admission.approvalResponseId,
      admission.policyDigest,
      admission.admissionDigest,
      canonicalJson(admission),
      admission.admittedAt,
    ],
  );
  return admission;
}

export async function readScientificEffectAdmission(
  transaction: ScientificTransaction,
  operation: ExternalOperation,
): Promise<ScientificEffectAdmission | null> {
  const [row] = await transaction.queryRows<{
    operation_id: string;
    work_unit_id: string;
    claim_id: string;
    fencing_generation: number;
    approval_id: string;
    approval_response_id: string;
    policy_digest: string;
    admission_digest: string;
    payload_json: string;
    admitted_at: string;
  }>("SELECT * FROM scientific_effect_admissions WHERE operation_id = $1", [operation.id]);
  if (!row) return null;
  let value: unknown;
  try {
    value = JSON.parse(row.payload_json);
  } catch {
    throw new ScientificIntegrityError("Invalid scientific effect admission JSON");
  }
  const admission = assertScientificEffectAdmission(value);
  const outbox = await readOperationIntentOutbox(transaction, operation);
  const expectedIdentity =
    operation.kind === "md_stage_execution"
      ? mdStageEffectIdentity(operation)
      : { jobId: operation.request.intendedJobId, attemptId: operation.request.intendedAttemptId };
  if (
    !outbox ||
    admission.outboxDigest !== outbox.envelopeDigest ||
    admission.operationId !== operation.id ||
    admission.missionId !== operation.missionId ||
    admission.workUnitId !== operation.workUnitId ||
    admission.requestDigest !== operation.requestDigest ||
    admission.policyDigest !== operation.policyDigest ||
    operation.state === "intent" ||
    operation.revision < 2 ||
    admission.jobId !== expectedIdentity.jobId ||
    admission.attemptId !== expectedIdentity.attemptId ||
    row.operation_id !== admission.operationId ||
    row.work_unit_id !== admission.workUnitId ||
    row.claim_id !== admission.claimId ||
    Number(row.fencing_generation) !== admission.fencingGeneration ||
    row.approval_id !== admission.approvalId ||
    row.approval_response_id !== admission.approvalResponseId ||
    row.policy_digest !== admission.policyDigest ||
    row.admission_digest !== admission.admissionDigest ||
    row.admitted_at !== admission.admittedAt
  ) {
    throw new ScientificIntegrityError("Effect admission is outside its exact durable outbox");
  }
  return admission;
}
