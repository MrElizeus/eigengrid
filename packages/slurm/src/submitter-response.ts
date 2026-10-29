import { z } from "zod";
import {
  SlurmSubmissionBindingSchema,
  assertSlurmSubmissionBinding,
  resolveSlurmSubmission,
  type SlurmSubmissionBinding,
} from "./submission-identity";
import { hasControlCharacter } from "./script-builder";

const schedulerIdentifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u);
const simpleJobId = z.string().regex(/^[1-9]\d{0,19}$/u);
const durableJobId = simpleJobId.refine(
  (value) => Number(value) < 4_294_967_296,
  "Submitter acknowledgement JobID exceeds the durable journal contract",
);
const secondTimestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u)
  .refine(
    (value) =>
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value.replace("Z", ".000Z"),
    "Invalid Slurm observation timestamp",
  );
const safeDiagnostic = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !hasControlCharacter(value), "Submitter diagnostic contains controls");
const observationText = z
  .string()
  .max(128)
  .refine((value) => !hasControlCharacter(value), "Slurm observation contains controls");

/** The only receipt shapes the durable Python journal can publish. Neither is
 * execution completion or scientific acceptance. */
export const SubmitterTransportReceiptSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("acknowledged"),
      resubmitAllowed: z.literal(false),
      jobId: durableJobId,
      cluster: schedulerIdentifier,
    })
    .strict(),
  z.object({ status: z.literal("indeterminate"), resubmitAllowed: z.literal(false) }).strict(),
]);
export type SubmitterTransportReceipt = z.infer<typeof SubmitterTransportReceiptSchema>;

const SlurmSubmissionObservationSchema = z
  .object({
    source: z.enum(["sacct", "squeue"]),
    jobId: simpleJobId,
    cluster: schedulerIdentifier,
    uid: z.number().int().positive().max(4_294_967_294),
    submittedAt: secondTimestamp,
    jobName: observationText,
    marker: observationText,
  })
  .strict();

const SlurmSubmissionIdentitySchema = z
  .object({
    jobId: simpleJobId,
    cluster: schedulerIdentifier,
    uid: z.number().int().positive().max(4_294_967_294),
    submittedAt: secondTimestamp,
  })
  .strict();

const observationFields = {
  resubmitAllowed: z.literal(false),
  reason: safeDiagnostic,
  observations: z.array(SlurmSubmissionObservationSchema).max(512),
};

/** Read-only scheduler evidence returned for an existing claim. A conflict or
 * indeterminate result is deliberately preserved, never converted to a retry. */
export const SubmitterSchedulerObservationSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("matched"),
      ...observationFields,
      markerEvidence: z.enum(["accounting_comment", "durable_name_and_queue_comment"]),
      identity: SlurmSubmissionIdentitySchema,
    })
    .strict(),
  z.object({ status: z.literal("indeterminate"), ...observationFields }).strict(),
  z.object({ status: z.literal("conflict"), ...observationFields }).strict(),
]);
export type SubmitterSchedulerObservation = z.infer<typeof SubmitterSchedulerObservationSchema>;

/** Exact closed public union emitted by SubmitterBoundary/service.py. The
 * response is transport evidence only; no member represents scientific PASS. */
export const SubmitterResponseSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("consumed"),
      operationId: schedulerIdentifier,
      resubmitAllowed: z.literal(false),
      receipt: SubmitterTransportReceiptSchema,
      requiresReconciliation: z.literal(true),
    })
    .strict(),
  z
    .object({
      status: z.literal("already_consumed"),
      operationId: schedulerIdentifier,
      resubmitAllowed: z.literal(false),
      receipt: SubmitterTransportReceiptSchema.nullable(),
      requiresReconciliation: z.literal(true),
    })
    .strict(),
  z
    .object({
      status: z.literal("observation"),
      operationId: schedulerIdentifier,
      resubmitAllowed: z.literal(false),
      observation: SubmitterSchedulerObservationSchema,
    })
    .strict(),
  z.object({ status: z.literal("rejected"), resubmitAllowed: z.literal(false) }).strict(),
]);
export type SubmitterResponse = z.infer<typeof SubmitterResponseSchema>;

/** The caller supplies its immutable, validated delivery binding; the RPC can
 * never select a different operation, action, or scheduler identity. */
export const SubmitterResponseExpectationSchema = z
  .object({
    operationId: schedulerIdentifier,
    action: z.enum(["submit", "observe"]),
    binding: SlurmSubmissionBindingSchema,
  })
  .strict();
export type SubmitterResponseExpectation = z.infer<typeof SubmitterResponseExpectationSchema>;

interface ValidatedExpectation {
  operationId: string;
  action: "submit" | "observe";
  binding: SlurmSubmissionBinding;
}

function validateExpectation(value: unknown): ValidatedExpectation {
  const parsed = SubmitterResponseExpectationSchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid expected submitter operation");
  let binding: SlurmSubmissionBinding;
  try {
    binding = assertSlurmSubmissionBinding(parsed.data.binding);
  } catch {
    throw new Error("Invalid expected submitter binding");
  }
  if (parsed.data.operationId !== binding.operationId)
    throw new Error("Expected submitter operation differs from its binding");
  return { operationId: parsed.data.operationId, action: parsed.data.action, binding };
}

function assertReceiptBinding(
  receipt: SubmitterTransportReceipt,
  binding: SlurmSubmissionBinding,
): void {
  if (receipt.status === "acknowledged" && receipt.cluster !== binding.cluster)
    throw new Error("Submitter acknowledgement cluster differs from its binding");
}

function assertMatchedObservation(
  observation: SubmitterSchedulerObservation,
  binding: SlurmSubmissionBinding,
): void {
  if (observation.status !== "matched") return;
  const resolved = resolveSlurmSubmission(binding, observation.observations, {
    accounting: true,
    queue: true,
  });
  if (
    resolved.status !== "matched" ||
    resolved.markerEvidence !== observation.markerEvidence ||
    !resolved.identity ||
    resolved.identity.jobId !== observation.identity.jobId ||
    resolved.identity.cluster !== observation.identity.cluster ||
    resolved.identity.uid !== observation.identity.uid ||
    resolved.identity.submittedAt !== observation.identity.submittedAt
  ) {
    throw new Error("Matched submitter observation differs from its binding");
  }
}

/** Decode the unknown result of callSubmitter without granting retries or
 * execution/scientific success. A malformed value throws before any caller can
 * persist an acknowledgement. */
export function decodeSubmitterResponse(
  value: unknown,
  expectationValue: unknown,
): SubmitterResponse {
  const expectation = validateExpectation(expectationValue);
  const parsed = SubmitterResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error("Submitter response does not match its closed contract");
  const response = parsed.data;
  if (response.status === "rejected") return response;
  if (response.operationId !== expectation.operationId)
    throw new Error("Submitter response operation differs from the expected operation");

  if (expectation.action === "observe") {
    if (response.status !== "observation")
      throw new Error("Observe capability received a non-observation submitter response");
    assertMatchedObservation(response.observation, expectation.binding);
    return response;
  }

  if (response.status === "observation")
    throw new Error("Submit capability received an observation submitter response");
  if (response.receipt !== null) assertReceiptBinding(response.receipt, expectation.binding);
  return response;
}
