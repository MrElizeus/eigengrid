import {
  ExternalOperationSchema,
  OperationReceiptSchema,
  WorkUnitSchema,
  assertScientificTransition,
  canonicalJson,
  digestCanonical,
} from "@eigengrid/scientific-schema";
import { ScientificIntegrityError, ScientificRevisionConflictError } from "../errors";
import { mdStageEffectIdentity } from "../md-effect-authority";
import { readScientificEffectAdmission } from "../operation-outbox";
import { EffectReconciliationContext } from "./context";
import { type ReconcileWorkUnitEffectInput, type ReconcileWorkUnitEffectResult } from "./contracts";
import { effectIdentity, requestedEffectIdentity } from "./identity";
import { parsePayload } from "./payload";
import { expectedOperationState, transitionPath } from "./transitions";

export async function reconcileWorkUnitEffect(
  store: EffectReconciliationContext,
  input: ReconcileWorkUnitEffectInput,
): Promise<ReconcileWorkUnitEffectResult> {
  return store.inTransaction("reconcile work-unit effect", async (transaction) => {
    const operationRow = await store.requiredRow(
      transaction,
      "scientific_external_operations",
      input.operationId,
      "external operation",
    );
    const operation = parsePayload(
      ExternalOperationSchema,
      operationRow,
      `External operation ${input.operationId}`,
    );
    if (operation.workUnitId !== input.workUnitId) {
      throw new ScientificIntegrityError("External operation targets a different work unit", {
        operationId: operation.id,
        expectedWorkUnitId: input.workUnitId,
        actualWorkUnitId: operation.workUnitId,
      });
    }
    const requiredOperationState = expectedOperationState(input.outcome);
    if (operation.state !== requiredOperationState || !operation.receiptId) {
      throw new ScientificIntegrityError(
        `Effect reconciliation requires a ${requiredOperationState} operation with a receipt`,
        { operationId: operation.id, operationState: operation.state },
      );
    }

    const receiptRow = await store.requiredRow(
      transaction,
      "scientific_operation_receipts",
      operation.receiptId,
      "operation receipt",
    );
    const receipt = parsePayload(
      OperationReceiptSchema,
      receiptRow,
      `Operation receipt ${operation.receiptId}`,
    );
    if (receipt.operationId !== operation.id || receipt.requestDigest !== operation.requestDigest) {
      throw new ScientificIntegrityError("Operation receipt is not bound to the exact request", {
        operationId: operation.id,
        receiptId: receipt.id,
      });
    }
    if (
      (input.outcome === "completed" && receipt.status !== "confirmed") ||
      (input.outcome !== "completed" && receipt.status !== "failed")
    ) {
      throw new ScientificIntegrityError(
        "Operation receipt status does not match the effect outcome",
        {
          operationId: operation.id,
          receiptStatus: receipt.status,
          outcome: input.outcome,
        },
      );
    }
    let identity = {
      ...requestedEffectIdentity(operation),
      ...effectIdentity(operation.externalIdentity),
      ...effectIdentity(receipt.externalIdentity),
      ...(receipt.jobId ? { jobId: receipt.jobId } : {}),
      ...(receipt.attemptId ? { attemptId: receipt.attemptId } : {}),
    };
    if (operation.kind === "md_stage_execution") {
      const admission = await readScientificEffectAdmission(transaction, operation);
      const exact = mdStageEffectIdentity(operation);
      if (!admission || receipt.jobId !== exact.jobId || receipt.attemptId !== exact.attemptId) {
        throw new ScientificIntegrityError(
          "MD reconciliation requires its consumed admission and exact receipt identity",
        );
      }
      // An external scheduler identity may supplement, never replace, the
      // internal job/attempt derived from the immutable scientific intent.
      for (const candidate of [operation.externalIdentity, receipt.externalIdentity]) {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
        for (const key of ["jobId", "attemptId"] as const) {
          if (Object.hasOwn(candidate, key) && candidate[key] !== exact[key]) {
            throw new ScientificIntegrityError("MD external identity conflicts with admission");
          }
        }
      }
      identity = exact;
    }
    if (identity.jobId !== input.jobId || identity.attemptId !== input.attemptId) {
      throw new ScientificIntegrityError("Effect identity does not match the canonical receipt", {
        operationId: operation.id,
        expectedJobId: input.jobId,
        expectedAttemptId: input.attemptId,
        actualJobId: identity.jobId,
        actualAttemptId: identity.attemptId,
      });
    }

    const workRow = await store.requiredRow(
      transaction,
      "scientific_work_units",
      input.workUnitId,
      "work unit",
    );
    const current = parsePayload(WorkUnitSchema, workRow, `Work unit ${input.workUnitId}`);
    if (current.missionId !== operation.missionId) {
      throw new ScientificIntegrityError("Operation and work unit cross a mission boundary", {
        operationId: operation.id,
        workUnitId: current.id,
      });
    }
    if (
      (current.jobId && current.jobId !== input.jobId) ||
      (current.attemptId && current.attemptId !== input.attemptId)
    ) {
      throw new ScientificIntegrityError("Work unit effect identity conflicts with the receipt", {
        workUnitId: current.id,
        currentJobId: current.jobId,
        currentAttemptId: current.attemptId,
        receiptJobId: input.jobId,
        receiptAttemptId: input.attemptId,
      });
    }

    const path = transitionPath(current.state, input.outcome, input.retryable === true);
    let logicalState = current.state;
    for (const nextState of path) {
      assertScientificTransition("work_unit", logicalState, nextState);
      logicalState = nextState;
    }
    if (path.length === 0) {
      return {
        workUnit: current,
        operation,
        receipt,
        transitionedThrough: [],
        alreadyReconciled: true,
      };
    }

    const finalState = path[path.length - 1]!;
    const releasesClaim = !["claimed", "executing", "observing"].includes(finalState);
    const next = WorkUnitSchema.parse({
      ...current,
      state: finalState,
      revision: current.revision + path.length,
      claimOwner: releasesClaim ? null : current.claimOwner,
      claimExpiresAt: releasesClaim ? null : current.claimExpiresAt,
      jobId: input.jobId,
      attemptId: input.attemptId,
      updatedAt: input.at,
    });
    const changed = await transaction.queryRows<{ id: string }>(
      `UPDATE scientific_work_units
         SET state = $1, revision = $2, claim_owner = $3, claim_expires_at = $4,
             job_id = $5, attempt_id = $6, payload_digest = $7, payload_json = $8,
             updated_at = $9
         WHERE id = $10 AND revision = $11 AND state = $12 RETURNING id`,
      [
        next.state,
        next.revision,
        next.claimOwner,
        next.claimExpiresAt,
        next.jobId,
        next.attemptId,
        digestCanonical(next),
        canonicalJson(next),
        next.updatedAt,
        next.id,
        current.revision,
        current.state,
      ],
    );
    if (changed.length === 0) {
      throw new ScientificRevisionConflictError(
        "work unit",
        current.id,
        current.revision,
        current.revision + 1,
      );
    }
    if (releasesClaim && current.claimOwner) {
      await transaction.query(
        `UPDATE scientific_work_unit_claims
           SET active = $1, released_at = $2, release_reason = $3
           WHERE work_unit_id = $4 AND active = $5`,
        [false, input.at, `effect_reconciled:${operation.id}:${input.outcome}`, current.id, true],
      );
    }
    return {
      workUnit: next,
      operation,
      receipt,
      transitionedThrough: path,
      alreadyReconciled: false,
    };
  });
}
