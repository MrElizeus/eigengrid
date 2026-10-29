import { z } from "zod";
import { hasControlCharacter } from "./script-builder";
import { assertSlurmSubmissionBinding } from "./submission-identity";
import { isSlurmTerminal } from "./state-mapper";
import { NATIVE_ACCOUNTING_SCHEMA } from "./native-accounting";
import { decodeSubmitterResponse, SubmitterSchedulerObservationSchema } from "./submitter-response";

const text = z
  .string()
  .max(256)
  .refine((value) => !hasControlCharacter(value));
const jobId = z.string().regex(/^[1-9]\d{0,19}$/u);
const integer = z.number().int().nonnegative().safe();
const exitCode = integer.max(255);
const signal = integer.max(127);
const state = z.enum([
  "PENDING",
  "RUNNING",
  "COMPLETING",
  "COMPLETED",
  "CANCELLED",
  "FAILED",
  "TIMEOUT",
  "NODE_FAIL",
  "PREEMPTED",
  "BOOT_FAIL",
  "OUT_OF_MEMORY",
  "SUSPENDED",
  "REQUEUED",
  "RESIZING",
  "CONFIGURING",
  "SIGNALING",
  "STAGE_OUT",
  "STOPPED",
  "SPECIAL_EXIT",
  "REVOKED",
  "DEADLINE",
  "RESV_DEL_HOLD",
  "REQUEUE_HOLD",
  "REQUEUE_FED",
  "UNKNOWN",
]);
const record = z
  .object({
    jobId: z.string().regex(/^[1-9]\d{0,19}(?:\.(?:batch|extern|\d+))?$/u),
    allocationId: jobId,
    kind: z.enum(["allocation", "batch", "external", "step"]),
    stepId: z
      .string()
      .regex(/^(?:batch|extern|\d+)$/u)
      .optional(),
    rawState: text,
    state: text,
    exitCode: exitCode.optional(),
    rawTextExitCode: exitCode.optional(),
    signal: signal.optional(),
    derivedExitCode: exitCode.optional(),
    derivedSignal: signal.optional(),
    elapsed: text,
    maxRss: text,
    reqMem: text,
    nNodes: integer.optional(),
    nCpus: integer.optional(),
    uid: integer.optional(),
    submittedAt: text,
    cluster: text,
    nodeList: text,
    reason: text,
  })
  .strict();

/** The bounded ordinary-batch subset returned by the qualified Slurm client.
 * Identity is rechecked against the signed delivery, never chosen by a caller. */
export const SubmitterAccountingRecordSchema = z
  .object({
    slurmJobId: jobId,
    state,
    exitCode: exitCode.optional(),
    signal: signal.optional(),
    derivedExitCode: exitCode.optional(),
    derivedSignal: signal.optional(),
    rawState: text.optional(),
    reason: text.optional(),
    uid: integer.positive(),
    submittedAt: text,
    cluster: text,
    nodeName: text,
    accountingSchema: z.literal("slurm-23.11/parsable2-v1"),
    nativeAccountingSchema: z.literal(NATIVE_ACCOUNTING_SCHEMA).optional(),
    records: z.array(record).min(1).max(64),
    elapsed: text.optional(),
    maxRss: text.optional(),
    reqMem: text.optional(),
    nNodes: integer.optional(),
    nCpus: integer.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const allocations = value.records.filter((item) => item.kind === "allocation");
    const allocation = allocations[0];
    if (
      allocations.length !== 1 ||
      !allocation ||
      allocation.jobId !== value.slurmJobId ||
      allocation.uid !== value.uid ||
      allocation.submittedAt !== value.submittedAt ||
      allocation.cluster !== value.cluster ||
      allocation.nodeList !== value.nodeName ||
      new Set(value.records.map((item) => item.jobId)).size !== value.records.length ||
      value.records.some(
        (item) =>
          item.allocationId !== value.slurmJobId ||
          (item.uid !== undefined && item.uid !== value.uid) ||
          (item.cluster !== "" && item.cluster !== value.cluster),
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Accounting records have conflicting identities",
      });
    }
    if (
      isSlurmTerminal(value.state) &&
      (value.nativeAccountingSchema !== NATIVE_ACCOUNTING_SCHEMA ||
        value.exitCode === undefined ||
        value.signal === undefined ||
        value.derivedExitCode === undefined ||
        value.derivedSignal === undefined ||
        value.records.some(
          (item) =>
            item.exitCode === undefined ||
            item.signal === undefined ||
            item.rawTextExitCode === undefined,
        ))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Terminal accounting requires native corroboration of every record",
      });
    }
    if (
      allocation &&
      (allocation.exitCode !== value.exitCode ||
        allocation.signal !== value.signal ||
        allocation.derivedExitCode !== value.derivedExitCode ||
        allocation.derivedSignal !== value.derivedSignal)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Accounting summary differs from allocation exits",
      });
    }
    if (allocation) {
      const normalized = (raw: string) =>
        state.safeParse(raw.trim().toUpperCase()).data ?? "UNKNOWN";
      let expectedState = normalized(allocation.state);
      if (
        isSlurmTerminal(expectedState) &&
        (allocation.exitCode === undefined || allocation.signal === undefined)
      )
        expectedState = "UNKNOWN";
      if (expectedState === "COMPLETED") {
        if (allocation.derivedExitCode === undefined || allocation.derivedSignal === undefined)
          expectedState = "UNKNOWN";
        else if (
          value.records.some(
            (item) =>
              (item.exitCode ?? 0) !== 0 ||
              (item.signal ?? 0) !== 0 ||
              (item.derivedExitCode ?? 0) !== 0 ||
              (item.derivedSignal ?? 0) !== 0 ||
              (isSlurmTerminal(normalized(item.state)) && item.state !== "COMPLETED"),
          )
        ) {
          expectedState = value.records.some((item) => item.state === "OUT_OF_MEMORY")
            ? "OUT_OF_MEMORY"
            : "FAILED";
        }
      }
      if (value.state !== expectedState)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Accounting summary differs from record states",
        });
    }
    if (
      value.records.some((item) => {
        const suffix = item.jobId.split(".")[1];
        const expectedKind =
          suffix === undefined
            ? "allocation"
            : suffix === "batch"
              ? "batch"
              : suffix === "extern"
                ? "external"
                : "step";
        return item.kind !== expectedKind || item.stepId !== suffix;
      })
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Accounting record kind differs from its JobID",
      });
  });
export type SubmitterAccountingRecord = z.infer<typeof SubmitterAccountingRecordSchema>;

export const SubmitterAccountingResultSchema = z
  .object({
    observation: SubmitterSchedulerObservationSchema,
    accounting: SubmitterAccountingRecordSchema.nullable(),
  })
  .strict();
export type SubmitterAccountingResult = z.infer<typeof SubmitterAccountingResultSchema>;

export const SubmitterAccountingResponseSchema = z.union([
  z
    .object({
      version: z.literal("eigengrid.submitter-response/v2"),
      status: z.literal("accounting"),
      operationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u),
      resubmitAllowed: z.literal(false),
      ...SubmitterAccountingResultSchema.shape,
    })
    .strict(),
  // A legacy service rejects V2, rather than reinterpreting it as submit.
  z.object({ status: z.literal("rejected"), resubmitAllowed: z.literal(false) }).strict(),
]);
export type SubmitterAccountingResponse = z.infer<typeof SubmitterAccountingResponseSchema>;

export function assertSubmitterAccountingResult(
  value: unknown,
  bindingValue: unknown,
): SubmitterAccountingResult {
  const binding = assertSlurmSubmissionBinding(bindingValue);
  const result = SubmitterAccountingResultSchema.parse(value);
  decodeSubmitterResponse(
    {
      status: "observation",
      operationId: binding.operationId,
      resubmitAllowed: false,
      observation: result.observation,
    },
    { action: "observe", operationId: binding.operationId, binding },
  );
  const accounting = result.accounting;
  if (accounting) {
    const observation = result.observation;
    if (
      observation.status !== "matched" ||
      accounting.slurmJobId !== observation.identity.jobId ||
      accounting.uid !== observation.identity.uid ||
      accounting.submittedAt !== observation.identity.submittedAt ||
      accounting.cluster !== observation.identity.cluster ||
      accounting.nodeName !== binding.resources.node
    ) {
      throw new Error("Accounting differs from the exact observed Slurm identity/site");
    }
  }
  return result;
}

export function decodeSubmitterAccountingResponse(
  value: unknown,
  expectation: { operationId: string; binding: unknown },
): SubmitterAccountingResponse {
  const binding = assertSlurmSubmissionBinding(expectation.binding);
  if (expectation.operationId !== binding.operationId)
    throw new Error("Expected accounting operation differs from its binding");
  if (Buffer.byteLength(JSON.stringify(value) ?? "") > 64 * 1024)
    throw new Error("Accounting response exceeds transport bound");
  const response = SubmitterAccountingResponseSchema.parse(value);
  if (response.status === "rejected") return response;
  if (response.operationId !== expectation.operationId)
    throw new Error("Accounting response operation differs from its binding");
  assertSubmitterAccountingResult(
    { observation: response.observation, accounting: response.accounting },
    binding,
  );
  return response;
}
