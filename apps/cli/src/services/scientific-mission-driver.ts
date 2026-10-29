import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BudgetReservationSchema,
  EvidenceReferenceSchema,
  ExternalOperationSchema,
  OperationReceiptSchema,
  digestCanonical,
  type ExternalOperation,
  type OperationReceipt,
  type WorkUnit,
} from "@eigengrid/scientific-schema";
import {
  ScientificStore,
  mdStageEffectIdentity,
  workUnitUsesMdExecutionBinding,
  type MissionOperationReconciliation,
  type MissionWorkExecution,
  type ScientificEffectPersistence,
  type ScientificMissionPolicyDigestResolver,
  type ScientificMissionWorkDriver,
} from "@eigengrid/mission-runtime";
import type { LocalReceipt } from "@eigengrid/runners";
import { callSubmitter, decodeSubmitterResponse } from "@eigengrid/slurm";
import { reconcileMdDelivery } from "./md-delivery-recovery";
import { parseAmberSlurmDelivery } from "./amber-slurm-delivery";
import type {
  ExecutionService,
  LocalExecutionRequest,
  ReconcileLocalOutcome,
} from "./execution-coordinator";
import {
  mdDriverOperationIdentity,
  mdTransportIdentity,
  requestFromVerifiedAmberBundle,
  type CanonicalMdExecutionGateway,
} from "./md-driver-binding";

export interface LocalScientificExecutionBinding {
  software: string;
  recipeId: string;
  inputEvidenceId: string;
  inputPath: string;
  inputContentDigest: string;
  name: string;
}

export interface ScientificExecutionBindingResolver {
  resolve(workUnit: WorkUnit): Promise<LocalScientificExecutionBinding>;
}

export interface CanonicalScientificExecutionDriverOptions {
  store: ScientificStore;
  execution: ExecutionService;
  effectPersistence: ScientificEffectPersistence;
  currentPolicyDigestFor: ScientificMissionPolicyDigestResolver;
  bindingResolver?: ScientificExecutionBindingResolver;
  /**
   * Omitted by the legacy/local composition and by the deployed closed Head.
   * A claimed MD WorkUnit then fails closed rather than falling through to a
   * local runner or a caller-selected Slurm route.
   */
  md?: CanonicalMdExecutionGateway;
  now?: () => Date;
}

type UnknownRecord = Record<string, unknown>;

type TerminalReconciliation = {
  status: "completed" | "failed" | "cancelled";
  jobId: string;
  attemptId: string;
  receipt?: LocalReceipt;
  exitCode?: number;
  message: string;
};

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required by the approved protocol fragment`);
  }
  return value;
}

function localEvidencePath(uri: string): string {
  if (uri.startsWith("file://")) return fileURLToPath(uri);
  if (/^[a-z][a-z0-9+.-]*:/iu.test(uri)) {
    throw new Error(`Evidence URI ${uri} is not a local file capability`);
  }
  if (!isAbsolute(uri)) {
    throw new Error("Local scientific execution requires an absolute path or file:// evidence URI");
  }
  return uri;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  return hash.digest("hex");
}

async function assertExactInput(binding: LocalScientificExecutionBinding): Promise<void> {
  const actualDigest = await sha256File(binding.inputPath);
  if (actualDigest !== binding.inputContentDigest) {
    throw new Error(
      `Input evidence ${binding.inputEvidenceId} bytes do not match the approved content digest`,
    );
  }
}

function iso(date: Date): string {
  if (!Number.isFinite(date.getTime())) throw new TypeError("Scientific effect clock is invalid");
  return date.toISOString();
}

/**
 * Resolve only an approved software/recipe pair and immutable local evidence.
 * Protocol content cannot inject commands, arguments, environment variables,
 * a shell, a runner, or a scheduler through this boundary.
 */
export class RepositoryEvidenceExecutionBindingResolver implements ScientificExecutionBindingResolver {
  constructor(private readonly store: ScientificStore) {}

  async resolve(workUnit: WorkUnit): Promise<LocalScientificExecutionBinding> {
    if (workUnit.kind !== "optimization" && workUnit.kind !== "frequency") {
      throw new Error(`Work-unit kind ${workUnit.kind} is not a local chemistry execution`);
    }
    const provenance = await this.store.getMissionProvenance(workUnit.missionId);
    const parameters = asRecord(workUnit.protocolFragment.parameters);
    const execution = asRecord(parameters.execution);
    const software = requiredString(execution.software ?? parameters.software, "software");
    const recipeId = requiredString(execution.recipeId ?? parameters.recipeId, "recipeId");
    const requestedEvidenceId =
      typeof execution.inputEvidenceId === "string"
        ? execution.inputEvidenceId
        : typeof parameters.inputEvidenceId === "string"
          ? parameters.inputEvidenceId
          : undefined;
    const evidence = provenance.evidence.find((candidate) => {
      const selected = requestedEvidenceId
        ? candidate.id === requestedEvidenceId
        : workUnit.inputRefs.includes(candidate.id);
      return selected && (candidate.kind === "structure" || candidate.kind === "objective");
    });
    if (!evidence) {
      throw new Error(`Work unit ${workUnit.id} has no immutable local structure evidence`);
    }
    if (!evidence.immutable) {
      throw new Error(`Work unit ${workUnit.id} refuses mutable input evidence ${evidence.id}`);
    }
    return {
      software,
      recipeId,
      inputEvidenceId: evidence.id,
      inputPath: localEvidencePath(evidence.uri),
      inputContentDigest: evidence.contentDigest,
      name: `${workUnit.kind}-${workUnit.id}`,
    };
  }
}

function effectIdentity(workUnit: WorkUnit): {
  jobId: string;
  attemptId: string;
  operationId: string;
  reservationId: string;
  idempotencyKey: string;
} {
  const token = digestCanonical({
    missionId: workUnit.missionId,
    planId: workUnit.planId,
    planVersion: workUnit.planVersion,
    workUnitId: workUnit.id,
    capability: workUnit.executionPolicy.capability,
  }).slice(0, 32);
  return {
    jobId: `job-scientific-${token}`,
    attemptId: `attempt-scientific-${token}-1`,
    operationId: `operation-scientific-${token}`,
    reservationId: `reservation-scientific-${token}`,
    idempotencyKey: `${workUnit.missionId}/${workUnit.planId}/${workUnit.id}/${token}/local-execution`,
  };
}

function renderedInputEvidenceId(
  workUnit: WorkUnit,
  binding: LocalScientificExecutionBinding,
): string {
  return `evidence-rendered-input-${digestCanonical({
    missionId: workUnit.missionId,
    workUnitId: workUnit.id,
    sourceEvidenceId: binding.inputEvidenceId,
    inputContentDigest: binding.inputContentDigest,
  }).slice(0, 28)}`;
}

function operationEffectIdentity(operation: ExternalOperation): {
  jobId?: string;
  attemptId?: string;
} {
  const request = asRecord(operation.request);
  const identity = asRecord(operation.externalIdentity);
  const jobId =
    typeof identity.jobId === "string"
      ? identity.jobId
      : typeof request.intendedJobId === "string"
        ? request.intendedJobId
        : undefined;
  const attemptId =
    typeof identity.attemptId === "string"
      ? identity.attemptId
      : typeof request.intendedAttemptId === "string"
        ? request.intendedAttemptId
        : undefined;
  return { jobId, attemptId };
}

function workExecutionFromReconciliation(
  workUnitId: string,
  reconciliation: MissionOperationReconciliation,
): MissionWorkExecution {
  if (reconciliation.status === "reconciled") {
    return { status: "completed", workUnitId, detail: reconciliation.detail };
  }
  if (reconciliation.status === "failed") {
    return {
      status: "failed",
      workUnitId,
      detail: reconciliation.detail,
      retryable: reconciliation.retryable,
    };
  }
  return { status: "waiting", workUnitId, detail: reconciliation.detail };
}

/**
 * Intent-before-effect adapter from durable WorkUnits to EigenGrid's canonical
 * ExecutionCoordinator. An ambiguous outcome is persisted and reconciled; it
 * is never converted into a fresh dispatch.
 */
export class CanonicalScientificExecutionDriver implements ScientificMissionWorkDriver {
  private readonly store: ScientificStore;
  private readonly execution: ExecutionService;
  private readonly effectPersistence: ScientificEffectPersistence;
  private readonly currentPolicyDigestFor: ScientificMissionPolicyDigestResolver;
  private readonly bindingResolver: ScientificExecutionBindingResolver;
  private readonly md: CanonicalMdExecutionGateway | undefined;
  private readonly now: () => Date;

  constructor(options: CanonicalScientificExecutionDriverOptions) {
    this.store = options.store;
    this.execution = options.execution;
    this.effectPersistence = options.effectPersistence;
    this.currentPolicyDigestFor = options.currentPolicyDigestFor;
    this.bindingResolver =
      options.bindingResolver ?? new RepositoryEvidenceExecutionBindingResolver(options.store);
    this.md = options.md;
    this.now = options.now ?? (() => new Date());
  }

  async executeClaimedWorkUnit(
    workUnit: WorkUnit,
    context: {
      ownerId: string;
      claimOwner: string;
      now: string;
      signal?: AbortSignal;
    },
  ): Promise<MissionWorkExecution> {
    if (workUnit.state !== "claimed" || workUnit.claimOwner !== context.claimOwner) {
      return {
        status: "failed",
        workUnitId: workUnit.id,
        detail: "Canonical execution requires the current durable work-unit claim",
        retryable: false,
      };
    }
    if (context.signal?.aborted) {
      return {
        status: "waiting",
        workUnitId: workUnit.id,
        detail: "Execution was not started because shutdown was requested",
      };
    }

    // MD is an explicitly versioned capability WorkUnit. It never reaches the
    // historical local runner, binding resolver, or local reconciliation path.
    if (workUnitUsesMdExecutionBinding(workUnit)) {
      return this.executeMdClaimedWorkUnit(workUnit, context);
    }

    try {
      const binding = await this.bindingResolver.resolve(workUnit);
      await assertExactInput(binding);
      const ids = effectIdentity(workUnit);
      const intentPolicyDigest = await this.currentPolicyDigestFor(workUnit);
      if (!intentPolicyDigest) {
        throw new Error(`No current policy digest is available for work unit ${workUnit.id}`);
      }
      const request = {
        capability: workUnit.executionPolicy.capability,
        missionId: workUnit.missionId,
        planId: workUnit.planId,
        planVersion: workUnit.planVersion,
        workUnitId: workUnit.id,
        software: binding.software,
        recipeId: binding.recipeId,
        inputEvidenceId: binding.inputEvidenceId,
        inputContentDigest: binding.inputContentDigest,
        intendedJobId: ids.jobId,
        intendedAttemptId: ids.attemptId,
      };

      let operation = await this.store.getExternalOperation(ids.operationId);
      const exactRequestDigest = digestCanonical(request);
      if (operation && operation.requestDigest !== exactRequestDigest) {
        throw new Error(
          `Persisted operation intent ${operation.id} does not match the exact approved execution request`,
        );
      }
      if (operation && operation.state !== "intent") {
        return workExecutionFromReconciliation(
          workUnit.id,
          await this.reconcileOperation(operation, context),
        );
      }
      if (!operation) {
        const budget = await this.store.getMissionBudget(workUnit.missionId);
        await this.store.reserveBudget({
          missionId: workUnit.missionId,
          expectedBudgetRevision: budget.revision,
          reservation: BudgetReservationSchema.parse({
            id: ids.reservationId,
            kind: "external_operation",
            amount: 1,
            state: "reserved",
            workUnitId: workUnit.id,
            operationId: ids.operationId,
            createdAt: workUnit.createdAt,
            updatedAt: workUnit.createdAt,
          }),
        });
        operation = await this.store.createOperationIntent(
          ExternalOperationSchema.parse({
            id: ids.operationId,
            missionId: workUnit.missionId,
            workUnitId: workUnit.id,
            idempotencyKey: ids.idempotencyKey,
            kind: "local_execution",
            state: "intent",
            request,
            requestDigest: exactRequestDigest,
            policyDigest: intentPolicyDigest,
            budgetReservationId: ids.reservationId,
            revision: 1,
            createdAt: workUnit.createdAt,
            updatedAt: workUnit.createdAt,
          }),
          { claimOwner: context.claimOwner, now: context.now },
        );
      }

      // Re-read both mutable authorities immediately before the durable effect boundary.
      // The persistence layer validates the policy/approval/active plan in the same
      // transaction that crosses intent -> effect_started.
      await assertExactInput(binding);
      const boundaryPolicyDigest = await this.currentPolicyDigestFor(workUnit);
      if (!boundaryPolicyDigest) {
        throw new Error(`No current policy digest is available for work unit ${workUnit.id}`);
      }
      const boundaryAt = iso(this.now());
      const begun = await this.effectPersistence.beginWorkUnitEffect({
        operationId: operation.id,
        expectedOperationRevision: operation.revision,
        workUnitId: workUnit.id,
        expectedWorkUnitRevision: workUnit.revision,
        claimOwner: context.claimOwner,
        jobId: ids.jobId,
        attemptId: ids.attemptId,
        currentPolicyDigest: boundaryPolicyDigest,
        at: boundaryAt,
      });
      operation = begun.operation;

      const localRequest: LocalExecutionRequest = {
        software: binding.software,
        inputPath: binding.inputPath,
        expectedInputDigest: binding.inputContentDigest,
        recipeId: binding.recipeId,
        name: binding.name,
        intendedJobId: ids.jobId,
        intendedAttemptId: ids.attemptId,
      };
      const effectContext = { ...context, now: boundaryAt };
      try {
        await this.persistRenderedInputEvidence(workUnit, binding);
        const launched = await this.execution.executeLocal(localRequest);
        if (!launched.ok) {
          const outcome = await this.execution.reconcileLocal(ids.jobId, ids.attemptId);
          return workExecutionFromReconciliation(
            workUnit.id,
            await this.applyReconciliation(operation, outcome, effectContext),
          );
        }
        operation = await this.acknowledgeOperation(
          operation,
          {
            jobId: launched.jobId,
            attemptId: launched.attemptId,
            ...(launched.pid === undefined ? {} : { pid: launched.pid }),
            ...(launched.command === undefined
              ? {}
              : { commandDigest: digestCanonical(launched.command) }),
          },
          boundaryAt,
        );
        if (launched.status && launched.status !== "running") {
          const outcome = await this.execution.reconcileLocal(ids.jobId, ids.attemptId);
          return workExecutionFromReconciliation(
            workUnit.id,
            await this.applyReconciliation(operation, outcome, effectContext),
          );
        }
        return {
          status: "progressed",
          workUnitId: workUnit.id,
          detail: `Local effect acknowledged as ${operation.id}; reconciliation owns completion`,
        };
      } catch (error) {
        operation = await this.markOperationAmbiguous(operation, boundaryAt);
        await this.settleOperationBudget(operation, "ambiguous", boundaryAt);
        return {
          status: "waiting",
          workUnitId: workUnit.id,
          detail: `Local launch outcome is ambiguous and will not be replayed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    } catch (error) {
      return {
        status: "failed",
        workUnitId: workUnit.id,
        detail: error instanceof Error ? error.message : String(error),
        retryable: false,
      };
    }
  }

  async reconcileOperation(
    operationInput: ExternalOperation,
    context: { ownerId: string; now: string; signal?: AbortSignal },
  ): Promise<MissionOperationReconciliation> {
    let operation = (await this.store.getExternalOperation(operationInput.id)) ?? operationInput;
    let existingReceipt = await this.persistedReceipt(operation);
    if (
      operation.kind === "md_stage_execution" &&
      !existingReceipt &&
      ["effect_started", "acknowledged", "ambiguous"].includes(operation.state) &&
      this.md?.collectResult
    ) {
      const result = await this.md.collectResult(operation.id, context.signal);
      if (result.status === "collected") {
        operation = (await this.store.getExternalOperation(operation.id)) ?? operation;
        existingReceipt = await this.persistedReceipt(operation);
      } else if (result.status === "conflict") {
        // A verified contradiction must remain visible with the original effect
        // and reservation intact. Observe-only recovery cannot resolve result
        // integrity and may otherwise mask the collection conflict.
        return { status: "ambiguous", operationId: operation.id, detail: result.detail };
      } else {
        // Observation remains useful while the terminal result is pending: it
        // recovers lost ACK identity and persists bounded uncertainty diagnostics.
        const recovery = await reconcileMdDelivery({
          store: this.store,
          operation,
          gateway: this.md,
          now: this.now,
          signal: context.signal,
        });
        return { ...recovery, detail: `${result.detail}; ${recovery.detail}` };
      }
    }
    if (
      operation.kind === "md_stage_execution" &&
      (!existingReceipt || !["confirmed", "failed"].includes(operation.state))
    ) {
      return reconcileMdDelivery({
        store: this.store,
        operation,
        gateway: this.md,
        now: this.now,
        signal: context.signal,
      });
    }
    if (existingReceipt) {
      if (context.signal?.aborted)
        return {
          status: "waiting",
          operationId: operation.id,
          detail: "Receipt settlement deferred for graceful shutdown",
        };
      const ids =
        operation.kind === "md_stage_execution"
          ? mdStageEffectIdentity(operation)
          : operationEffectIdentity(operation);
      if (!ids.jobId || !ids.attemptId) {
        return {
          status: "failed",
          operationId: operation.id,
          detail: "Terminal operation receipt lacks a stable job/attempt identity",
          retryable: false,
        };
      }
      const externalStatus = asRecord(existingReceipt.externalIdentity).status;
      const outcome =
        operation.state === "confirmed"
          ? "completed"
          : externalStatus === "cancelled"
            ? "cancelled"
            : "failed";
      const retryable =
        operation.kind !== "md_stage_execution" &&
        outcome === "failed" &&
        (await this.retryableWorkUnit(operation.workUnitId));
      await this.effectPersistence.reconcileWorkUnitEffect({
        operationId: operation.id,
        workUnitId: operation.workUnitId,
        jobId: ids.jobId,
        attemptId: ids.attemptId,
        outcome,
        retryable,
        at: context.now,
      });
      await this.persistReceiptEvidence(operation, existingReceipt);
      // A canonical terminal MD receipt proves this reservation was used.
      // Observation/absence never consumes or releases it. The terminal scanner
      // retains pending MD reservations across a crash before this settlement.
      if (operation.kind === "md_stage_execution")
        await this.settleOperationBudget(operation, "consumed", context.now);
      if (operation.kind === "md_stage_execution" && outcome === "completed") {
        if (this.md?.postprocessResult) {
          const result = await this.md.postprocessResult(
            operation.id,
            context.ownerId,
            context.signal,
          );
          return {
            status: result.status === "advanced" ? "reconciled" : "waiting",
            operationId: operation.id,
            detail: result.detail,
          };
        }
        // The terminal receipt settles execution into observing. It does not
        // authorize the legacy local collect/parser path or scientific PASS.
        return {
          status: "waiting",
          operationId: operation.id,
          detail:
            "Canonical MD receipt settled execution; authorized MD collection and scientific QC remain pending",
        };
      }
      return {
        status: "reconciled",
        operationId: operation.id,
        detail: `Existing canonical receipt ${existingReceipt.id} settled the work unit`,
      };
    }
    if (operation.state === "failed" || operation.state === "abandoned") {
      return {
        status: "failed",
        operationId: operation.id,
        detail: `Operation is terminal in ${operation.state} without a usable receipt`,
        retryable: false,
      };
    }
    if (operation.state === "intent") {
      return {
        status: "waiting",
        operationId: operation.id,
        detail: "Persisted intent has not crossed the effect-start boundary",
      };
    }
    if (context.signal?.aborted) {
      return {
        status: "waiting",
        operationId: operation.id,
        detail: "Reconciliation deferred for graceful shutdown",
      };
    }

    const ids = operationEffectIdentity(operation);
    if (!ids.jobId || !ids.attemptId) {
      operation = await this.markOperationAmbiguous(operation, context.now);
      await this.settleOperationBudget(operation, "ambiguous", context.now);
      return {
        status: "ambiguous",
        operationId: operation.id,
        detail: "Persisted effect lacks a stable job/attempt identity; replay is forbidden",
      };
    }
    try {
      return await this.applyReconciliation(
        operation,
        await this.execution.reconcileLocal(ids.jobId, ids.attemptId),
        context,
      );
    } catch (error) {
      operation = await this.markOperationAmbiguous(operation, context.now);
      await this.settleOperationBudget(operation, "ambiguous", context.now);
      return {
        status: "ambiguous",
        operationId: operation.id,
        detail: `Reconciliation failed without proving effect absence: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * P1-03's one-shot MD dispatch bridge. The durable operation/admission is
   * still owned by mission-runtime; the signer/session owns protected site
   * authority; the only external action here is one authenticated socket RPC.
   * Every uncertainty remains waiting/ambiguous and is delegated to P1-04.
   */
  private async executeMdClaimedWorkUnit(
    workUnit: WorkUnit,
    context: {
      ownerId: string;
      claimOwner: string;
      now: string;
      signal?: AbortSignal;
    },
  ): Promise<MissionWorkExecution> {
    const gateway = this.md;
    if (!gateway) {
      return {
        status: "failed",
        workUnitId: workUnit.id,
        detail: "MD execution gateway is not configured; production dispatch remains closed",
        retryable: false,
      };
    }
    if (gateway.database._provider !== "postgres") {
      return {
        status: "failed",
        workUnitId: workUnit.id,
        detail: "MD execution requires PostgreSQL; SQLite is not a production fallback",
        retryable: false,
      };
    }

    let operation: ExternalOperation | undefined;
    let boundaryAt = context.now;
    try {
      // An unbound/historical mission is not allowed to reach even the
      // read-only CAS reconstruction adapter. Its immutable owner/project
      // authority is a prerequisite for the production MD route.
      const association = await this.resolveMdMissionAssociation(workUnit);
      // This rehashes/reconstructs before any mission transaction. The request
      // below is extracted solely from the verified bundle manifest.
      const bundle = await gateway.prepareBundle(workUnit);
      const request = requestFromVerifiedAmberBundle(workUnit, bundle);
      const ids = mdDriverOperationIdentity(workUnit, request);
      const exactRequestDigest = digestCanonical(request);
      const intentPolicyDigest = await this.currentPolicyDigestFor(workUnit);
      if (!intentPolicyDigest)
        throw new Error(`No current policy digest is available for MD work unit ${workUnit.id}`);

      operation = (await this.store.getExternalOperation(ids.operationId)) ?? undefined;
      if (operation && operation.requestDigest !== exactRequestDigest) {
        throw new Error(
          `Persisted MD operation ${operation.id} does not match the exact verified stage request`,
        );
      }
      if (!operation) {
        const budget = await this.store.getMissionBudget(workUnit.missionId);
        try {
          await this.store.reserveBudget({
            missionId: workUnit.missionId,
            expectedBudgetRevision: budget.revision,
            reservation: BudgetReservationSchema.parse({
              id: ids.reservationId,
              kind: "external_operation",
              amount: 1,
              state: "reserved",
              workUnitId: workUnit.id,
              operationId: ids.operationId,
              createdAt: workUnit.createdAt,
              updatedAt: workUnit.createdAt,
            }),
          });
        } catch (error) {
          // The winner can be between reservation and intent persistence. It
          // is not safe for this caller to manufacture a second reservation or
          // assume effect absence merely because no operation is visible yet.
          const existing = await this.store.getExternalOperation(ids.operationId);
          if (existing && existing.requestDigest === exactRequestDigest) operation = existing;
          else {
            return {
              status: "waiting",
              workUnitId: workUnit.id,
              detail: `MD reservation is concurrently or uncertainly owned; no submit was attempted: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
        }
      }
      if (!operation) {
        const intent = ExternalOperationSchema.parse({
          id: ids.operationId,
          missionId: workUnit.missionId,
          workUnitId: workUnit.id,
          idempotencyKey: ids.idempotencyKey,
          kind: "md_stage_execution",
          state: "intent",
          request,
          requestDigest: exactRequestDigest,
          policyDigest: intentPolicyDigest,
          budgetReservationId: ids.reservationId,
          revision: 1,
          createdAt: workUnit.createdAt,
          updatedAt: workUnit.createdAt,
        });
        try {
          operation = await this.store.createOperationIntent(intent, {
            claimOwner: context.claimOwner,
            now: context.now,
          });
        } catch (error) {
          // A concurrent creator may have committed the exact deterministic
          // intent. Re-read once; do not create another reservation/operation.
          const existing = await this.store.getExternalOperation(ids.operationId);
          if (!existing || existing.requestDigest !== exactRequestDigest) throw error;
          operation = existing;
        }
      }
      if (operation.state !== "intent") {
        return {
          status: "waiting",
          workUnitId: workUnit.id,
          detail: `MD operation ${operation.id} is already ${operation.state}; TERRA-P1-04 owns observe-only recovery`,
        };
      }

      // Shutdown after preparation/reservation must never cross the durable
      // effect boundary. The persisted intent remains safe to resume under a
      // later claim; after the boundary, uncertainty is deliberately P1-04.
      if (context.signal?.aborted) {
        return {
          status: "waiting",
          workUnitId: workUnit.id,
          detail: "MD effect was not started because shutdown was requested before admission",
        };
      }

      const boundaryPolicyDigest = await this.currentPolicyDigestFor(workUnit);
      if (!boundaryPolicyDigest)
        throw new Error(`No current policy digest is available for MD work unit ${workUnit.id}`);
      boundaryAt = iso(this.now());
      const identity = mdStageEffectIdentity(operation);
      try {
        const begun = await this.effectPersistence.beginWorkUnitEffect({
          operationId: operation.id,
          expectedOperationRevision: operation.revision,
          workUnitId: workUnit.id,
          expectedWorkUnitRevision: workUnit.revision,
          claimOwner: context.claimOwner,
          jobId: identity.jobId,
          attemptId: identity.attemptId,
          currentPolicyDigest: boundaryPolicyDigest,
          at: boundaryAt,
        });
        operation = begun.operation;
      } catch (error) {
        const existing = await this.store.getExternalOperation(ids.operationId);
        if (existing && existing.requestDigest === exactRequestDigest) {
          return {
            status: "waiting",
            workUnitId: workUnit.id,
            detail: `MD effect boundary is concurrently or uncertainly owned by ${existing.state}; no submit was attempted by this caller`,
          };
        }
        throw error;
      }

      // The protected session rereads site authority, creates the one immutable
      // delivery, signs it, then revalidates PG + site authority immediately
      // before revealing the socket target for this one RPC.
      const session = gateway.siteAuthority.createAmberDeliverySession(
        gateway.database,
        association,
        bundle,
        this.now,
      );
      const prepared = await session.prepare({
        operationId: operation.id,
        claimOwner: context.claimOwner,
      });
      if (prepared.action !== "submit") {
        return {
          status: "waiting",
          workUnitId: workUnit.id,
          detail: `MD delivery ${prepared.delivery.deliveryDigest} already exists; it is observe-only and will not be submitted again`,
        };
      }
      const target = await session.authorizeSubmitRpc({
        prepared,
        claimOwner: context.claimOwner,
      });
      const rawResponse = await (gateway.callSubmitter ?? callSubmitter)(
        target.socketPath,
        target.wire,
      );
      // `target` is a private session snapshot. Never reuse the caller-facing
      // PreparedMdCapability after the async authorization boundary: it is a
      // continuation token, not authoritative transport metadata.
      const body = parseAmberSlurmDelivery(target.delivery);
      const response = decodeSubmitterResponse(rawResponse, {
        operationId: operation.id,
        action: "submit",
        binding: body.binding,
      });
      if (
        (response.status === "consumed" || response.status === "already_consumed") &&
        response.receipt?.status === "acknowledged"
      ) {
        operation = await this.acknowledgeOperation(
          operation,
          mdTransportIdentity(operation, {
            deliveryDigest: target.delivery.deliveryDigest,
            capabilityRequestId: target.capabilityRequestId,
            status: response.status,
            receipt: response.receipt,
          }),
          boundaryAt,
        );
        return {
          status: "progressed",
          workUnitId: workUnit.id,
          detail: `MD submitter acknowledged Slurm JobID ${response.receipt.jobId}; receipt/collection/QC remain authoritative future stages`,
        };
      }
      const classification =
        response.status === "rejected"
          ? "rejected"
          : response.status === "observation"
            ? "unexpected-observation"
            : "indeterminate";
      await this.markMdOperationAmbiguous(operation, boundaryAt);
      return {
        status: "waiting",
        workUnitId: workUnit.id,
        detail: `MD submitter outcome is ${classification}; no resubmission is permitted`,
      };
    } catch (error) {
      if (operation) await this.markMdOperationAmbiguous(operation, boundaryAt);
      if (operation) {
        return {
          status: "waiting",
          workUnitId: workUnit.id,
          detail: `MD delivery/submit outcome is ambiguous and will not be replayed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      // Another admitted caller can make the pre-effect preparation resolver
      // reject this stale claim while it hashes the bundle. That is not a new
      // scientific failure and cannot authorize another submit.
      try {
        const current = await this.store.getWorkUnit(workUnit.id);
        if (
          current &&
          current.missionId === workUnit.missionId &&
          current.planId === workUnit.planId &&
          current.planVersion === workUnit.planVersion &&
          [
            "executing",
            "observing",
            "cancel_requested",
            "cancelling",
            "succeeded",
            "failed",
          ].includes(current.state) &&
          digestCanonical(current.protocolFragment) === digestCanonical(workUnit.protocolFragment)
        ) {
          const candidates = (
            await this.store.getMissionProvenance(workUnit.missionId)
          ).operations.filter(
            (candidate) =>
              candidate.workUnitId === workUnit.id && candidate.kind === "md_stage_execution",
          );
          if (candidates.length === 1) {
            const existing = candidates[0]!;
            const identity = mdDriverOperationIdentity(current, existing.request);
            if (
              identity.operationId === existing.id &&
              existing.requestDigest === digestCanonical(existing.request) &&
              ["effect_started", "acknowledged", "ambiguous", "confirmed", "failed"].includes(
                existing.state,
              )
            )
              return {
                status: "waiting",
                workUnitId: workUnit.id,
                detail:
                  "A concurrent canonical MD effect already owns this WorkUnit; its durable state was preserved without resubmission",
              };
          }
        }
      } catch {
        // Failure to prove an exact existing effect must not conceal a real
        // pre-admission preparation error or manufacture an execution identity.
      }
      return {
        status: "failed",
        workUnitId: workUnit.id,
        detail: error instanceof Error ? error.message : String(error),
        retryable: false,
      };
    }
  }

  private async resolveMdMissionAssociation(
    workUnit: WorkUnit,
  ): Promise<{ subject: string; projectId: string }> {
    const association = await this.store.getMissionProjectAssociation(workUnit.missionId);
    if (!association) {
      throw new Error(
        `Production MD work unit ${workUnit.id} has no immutable mission-project association`,
      );
    }
    const provenance = await this.store.getMissionProvenance(workUnit.missionId);
    const mission = provenance.mission;
    if (
      mission.id !== workUnit.missionId ||
      mission.requestedBy.kind !== "human" ||
      mission.requestedBy.id !== association.ownerUserId
    ) {
      throw new Error(
        "MD mission/project association does not match its durable human mission owner",
      );
    }
    return { subject: association.ownerUserId, projectId: association.projectId };
  }

  /** Preserve uncertainty even when PostgreSQL is itself interrupted after an
   * RPC. A later P1-04 observer reads the original effect/delivery; this helper
   * never converts inability to record ambiguity into permission to retry. */
  private async markMdOperationAmbiguous(operation: ExternalOperation, at: string): Promise<void> {
    try {
      const updated = await this.markOperationAmbiguous(operation, at);
      await this.settleOperationBudget(updated, "ambiguous", at);
    } catch {
      // The durable effect is still non-terminal/unknown. Do not mask it with a
      // local completion/failure or make another RPC from this process.
    }
  }

  private async applyReconciliation(
    operationInput: ExternalOperation,
    outcome: ReconcileLocalOutcome,
    context: { ownerId: string; now: string },
  ): Promise<MissionOperationReconciliation> {
    let operation = (await this.store.getExternalOperation(operationInput.id)) ?? operationInput;
    const externalIdentity = {
      jobId: outcome.jobId,
      ...(outcome.attemptId === undefined ? {} : { attemptId: outcome.attemptId }),
      status: outcome.status,
    };

    if (outcome.status === "safely-unknown") {
      operation = await this.markOperationAmbiguous(operation, context.now);
      await this.settleOperationBudget(operation, "ambiguous", context.now);
      return { status: "ambiguous", operationId: operation.id, detail: outcome.message };
    }
    if (outcome.status === "running") {
      await this.acknowledgeOperation(operation, externalIdentity, context.now);
      return { status: "waiting", operationId: operation.id, detail: outcome.message };
    }

    const terminal: TerminalReconciliation = {
      status: outcome.status,
      jobId: outcome.jobId,
      attemptId: outcome.attemptId,
      ...(outcome.receipt === undefined ? {} : { receipt: outcome.receipt }),
      ...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
      message: outcome.message,
    };
    if (terminal.status === "completed") {
      operation = await this.acknowledgeOperation(operation, externalIdentity, context.now);
    }
    const receipt = await this.finalizeReceipt(operation, terminal, context.now);
    operation = (await this.store.getExternalOperation(operation.id)) ?? operation;
    await this.settleOperationBudget(operation, "consumed", context.now);
    await this.persistReceiptEvidence(operation, receipt);
    const ids = operationEffectIdentity(operation);
    if (!ids.jobId || !ids.attemptId) {
      return {
        status: "failed",
        operationId: operation.id,
        detail: "Terminal reconciliation lost its stable effect identity",
        retryable: false,
      };
    }
    const retryable =
      terminal.status === "failed" && (await this.retryableWorkUnit(operation.workUnitId));
    await this.effectPersistence.reconcileWorkUnitEffect({
      operationId: operation.id,
      workUnitId: operation.workUnitId,
      jobId: ids.jobId,
      attemptId: ids.attemptId,
      outcome: terminal.status,
      retryable,
      at: context.now,
    });
    return {
      status: "reconciled",
      operationId: operation.id,
      detail: `Canonical receipt ${receipt.id} settled ${terminal.status}: ${terminal.message}`,
    };
  }

  private async acknowledgeOperation(
    operationInput: ExternalOperation,
    externalIdentity: UnknownRecord,
    at: string,
  ): Promise<ExternalOperation> {
    const operation = (await this.store.getExternalOperation(operationInput.id)) ?? operationInput;
    if (operation.state === "acknowledged" || operation.state === "confirmed") return operation;
    if (operation.state === "ambiguous") {
      return this.store.reconcileAmbiguousOperation({
        operationId: operation.id,
        expectedRevision: operation.revision,
        resolution: "acknowledged",
        at,
        externalIdentity,
      });
    }
    if (operation.state === "effect_started") {
      return this.store.transitionExternalOperation({
        operationId: operation.id,
        expectedRevision: operation.revision,
        to: "acknowledged",
        at,
        externalIdentity,
      });
    }
    return operation;
  }

  private async markOperationAmbiguous(
    operationInput: ExternalOperation,
    at: string,
  ): Promise<ExternalOperation> {
    const operation = (await this.store.getExternalOperation(operationInput.id)) ?? operationInput;
    if (
      operation.state === "ambiguous" ||
      operation.state === "confirmed" ||
      operation.state === "failed"
    ) {
      return operation;
    }
    if (operation.state === "effect_started" || operation.state === "acknowledged") {
      return this.store.transitionExternalOperation({
        operationId: operation.id,
        expectedRevision: operation.revision,
        to: "ambiguous",
        at,
      });
    }
    return operation;
  }

  private async finalizeReceipt(
    operationInput: ExternalOperation,
    outcome: TerminalReconciliation,
    at: string,
  ): Promise<OperationReceipt> {
    let operation = (await this.store.getExternalOperation(operationInput.id)) ?? operationInput;
    const existing = await this.persistedReceipt(operation);
    if (existing) return existing;
    if (outcome.status === "completed" && operation.state === "effect_started") {
      operation = await this.acknowledgeOperation(
        operation,
        { jobId: outcome.jobId, attemptId: outcome.attemptId, status: outcome.status },
        at,
      );
    }
    const ids = operationEffectIdentity(operation);
    const receipt = OperationReceiptSchema.parse({
      id: `receipt-${operation.id}`,
      operationId: operation.id,
      requestDigest: operation.requestDigest,
      status: outcome.status === "completed" ? "confirmed" : "failed",
      externalIdentity: {
        jobId: outcome.jobId,
        attemptId: outcome.attemptId,
        status: outcome.status,
      },
      jobId: ids.jobId ?? outcome.jobId,
      attemptId: ids.attemptId ?? outcome.attemptId,
      detailDigest: digestCanonical({
        status: outcome.status,
        message: outcome.message,
        exitCode: outcome.exitCode,
        receipt: outcome.receipt ?? null,
      }),
      recordedAt: at,
    });
    if (operation.state === "ambiguous") {
      await this.store.reconcileAmbiguousOperation({
        operationId: operation.id,
        expectedRevision: operation.revision,
        resolution: "receipt",
        receipt,
      });
      return receipt;
    }
    return (await this.store.finalizeOperationReceipt(operation.id, operation.revision, receipt))
      .receipt;
  }

  private async persistedReceipt(
    operation: ExternalOperation,
  ): Promise<OperationReceipt | undefined> {
    if (!operation.receiptId) return undefined;
    const provenance = await this.store.getMissionProvenance(operation.missionId);
    return provenance.receipts.find((receipt) => receipt.id === operation.receiptId);
  }

  private async persistReceiptEvidence(
    operation: ExternalOperation,
    receipt: OperationReceipt,
  ): Promise<void> {
    await this.store.createEvidence(
      EvidenceReferenceSchema.parse({
        id: `evidence-${receipt.id}`,
        missionId: operation.missionId,
        workUnitId: operation.workUnitId,
        kind: "operation_receipt",
        uri: `eigengrid-operation-receipt://${receipt.id}`,
        contentDigest: digestCanonical(receipt),
        mediaType: "application/vnd.eigengrid.operation-receipt+json",
        immutable: true,
        sourceId: operation.id,
        createdAt: receipt.recordedAt,
      }),
    );
  }

  private async persistRenderedInputEvidence(
    workUnit: WorkUnit,
    binding: LocalScientificExecutionBinding,
  ): Promise<void> {
    await this.store.createEvidence(
      EvidenceReferenceSchema.parse({
        id: renderedInputEvidenceId(workUnit, binding),
        missionId: workUnit.missionId,
        workUnitId: workUnit.id,
        kind: "rendered_input",
        uri: `eigengrid-rendered-input://${workUnit.id}/${binding.inputEvidenceId}`,
        contentDigest: binding.inputContentDigest,
        mediaType: "application/vnd.eigengrid.rendered-input",
        immutable: true,
        sourceId: binding.inputEvidenceId,
        createdAt: workUnit.createdAt,
      }),
    );
  }

  private async settleOperationBudget(
    operation: ExternalOperation,
    state: "consumed" | "released" | "ambiguous",
    at: string,
  ): Promise<void> {
    if (!operation.budgetReservationId) return;
    const budget = await this.store.getMissionBudget(operation.missionId);
    await this.store.settleBudgetReservation({
      missionId: operation.missionId,
      reservationId: operation.budgetReservationId,
      expectedBudgetRevision: budget.revision,
      state,
      at,
    });
  }

  private async retryableWorkUnit(workUnitId: string): Promise<boolean> {
    const workUnit = await this.store.getWorkUnit(workUnitId);
    return Boolean(workUnit && workUnit.retryPolicy.maximumAttempts > 1);
  }
}
