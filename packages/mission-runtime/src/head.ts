import {
  MissionCheckpointSchema,
  digestCanonical,
  type ExternalOperation,
  type MissionCheckpoint,
  type ScientificMission,
  type WorkUnit,
} from "@eigengrid/scientific-schema";
import type { MissionProvenance, OperationIntentContext, WorkUnitClaimResult } from "./types";

export type MissionHeadLogLevel = "debug" | "info" | "warn" | "error";

export interface MissionHeadLogger {
  log(
    level: MissionHeadLogLevel,
    event: string,
    attributes: Readonly<Record<string, unknown>>,
  ): void;
}

export interface ScientificMissionHeadStore {
  listRecoverableMissions(): Promise<ScientificMission[]>;
  listOperationsForReconciliation(missionId: string): Promise<ExternalOperation[]>;
  listRunnableWorkUnits(missionId: string, now: string): Promise<WorkUnit[]>;
  claimWorkUnit(input: {
    workUnitId: string;
    ownerId: string;
    now: string;
    expiresAt: string;
    claimId?: string;
    policyDigest?: string;
  }): Promise<WorkUnitClaimResult>;
  renewWorkUnitClaim(input: {
    workUnitId: string;
    claimId: string;
    ownerId: string;
    now: string;
    expiresAt: string;
    expectedRevision?: number;
  }): Promise<WorkUnit>;
  getMissionProvenance(missionId: string): Promise<MissionProvenance>;
  createCheckpoint(checkpoint: MissionCheckpoint): Promise<MissionCheckpoint>;
}

export type MissionOperationReconciliation =
  | {
      status: "reconciled";
      operationId: string;
      detail: string;
    }
  | {
      status: "waiting" | "ambiguous";
      operationId: string;
      detail: string;
    }
  | {
      status: "failed";
      operationId: string;
      detail: string;
      retryable: boolean;
    };

export type MissionWorkExecution =
  | {
      status: "completed" | "progressed" | "waiting";
      workUnitId: string;
      detail: string;
    }
  | {
      status: "failed";
      workUnitId: string;
      detail: string;
      retryable: boolean;
    }
  | {
      status: "claim_lost";
      workUnitId: string;
      detail: string;
      retryable: false;
    };

/**
 * Narrow application-owned driver. It may call typed mission services and the
 * canonical ExecutionCoordinator, but the head itself receives no runner,
 * process, scheduler, shell, SQL, SSH, Slurm, or model authority.
 */
export interface ScientificMissionWorkDriver {
  reconcileOperation(
    operation: ExternalOperation,
    context: {
      ownerId: string;
      now: string;
      signal?: AbortSignal;
    },
  ): Promise<MissionOperationReconciliation>;

  executeClaimedWorkUnit(
    workUnit: WorkUnit,
    context: OperationIntentContext & {
      ownerId: string;
      signal?: AbortSignal;
    },
  ): Promise<MissionWorkExecution>;
}

/**
 * Resolves the policy digest that is authoritative at execution time. The
 * resolver may return undefined when no current policy is configured; callers
 * must treat that as a fail-closed result for new work.
 */
export type ScientificMissionPolicyDigestResolver = (
  workUnit: WorkUnit,
) => Promise<string | undefined> | string | undefined;

export interface ScientificMissionHeadOptions {
  ownerId: string;
  store: ScientificMissionHeadStore;
  driver: ScientificMissionWorkDriver;
  policyDigestFor: ScientificMissionPolicyDigestResolver;
  now?: () => Date;
  leaseMilliseconds?: number;
  leaseHeartbeatMilliseconds?: number;
  leaseSafetyMarginMilliseconds?: number;
  maximumClaimsPerMissionTick?: number;
  logger?: MissionHeadLogger;
}

export interface MissionHeadMissionResult {
  missionId: string;
  initialState: ScientificMission["state"];
  reconciliations: MissionOperationReconciliation[];
  claims: Array<
    | {
        claimed: true;
        workUnitId: string;
        claimId: string;
        execution: MissionWorkExecution;
      }
    | {
        claimed: false;
        workUnitId: string;
        reason: WorkUnitClaimResult extends { claimed: false; reason: infer R } ? R : string;
        detail: string;
      }
  >;
  blockedByReconciliation: boolean;
  checkpointId?: string;
  error?: string;
}

export interface MissionHeadTickResult {
  ownerId: string;
  startedAt: string;
  finishedAt: string;
  missions: MissionHeadMissionResult[];
  totals: {
    missions: number;
    reconciled: number;
    unresolvedOperations: number;
    claimsWon: number;
    claimsLost: number;
    completedWorkUnits: number;
    failedWorkUnits: number;
    claimLostWorkUnits: number;
  };
}

export interface MissionHeadRunOptions {
  signal: AbortSignal;
  idleDelayMilliseconds?: number;
  onTick?: (result: MissionHeadTickResult) => void | Promise<void>;
}

export interface MissionHeadHealth {
  status: "healthy" | "degraded";
  ready: boolean;
  ownerId: string;
  running: boolean;
  lastTickStartedAt?: string;
  lastTickFinishedAt?: string;
  lastError?: string;
}

const DEFAULT_LEASE_MILLISECONDS = 60_000;
const DEFAULT_MAXIMUM_CLAIMS = 1;
const DEFAULT_IDLE_DELAY_MILLISECONDS = 1_000;

const quietLogger: MissionHeadLogger = {
  log: () => undefined,
};

function iso(date: Date): string {
  if (!Number.isFinite(date.getTime()))
    throw new TypeError("Mission-head clock returned an invalid date");
  return date.toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function checkpointContextDigest(provenance: MissionProvenance): string {
  return digestCanonical({
    mission: {
      id: provenance.mission.id,
      revision: provenance.mission.revision,
      state: provenance.mission.state,
      activePlanId: provenance.mission.activePlanId,
    },
    plans: provenance.plans.map((plan) => ({
      id: plan.id,
      version: plan.version,
      revision: plan.revision,
      status: plan.status,
      planDigest: plan.planDigest,
      protocolDigest: plan.protocol.protocolDigest,
      skillGraphDigest: plan.skillResolution.graphDigest,
    })),
    workUnits: provenance.workUnits.map((workUnit) => ({
      id: workUnit.id,
      revision: workUnit.revision,
      state: workUnit.state,
      claimOwner: workUnit.claimOwner,
      claimExpiresAt: workUnit.claimExpiresAt,
      jobId: workUnit.jobId,
      attemptId: workUnit.attemptId,
    })),
    approvals: provenance.approvals.map((approval) => ({
      id: approval.id,
      state: approval.state,
      subjectId: approval.subjectId,
      subjectVersion: approval.subjectVersion,
      subjectRevision: approval.subjectRevision,
      payloadDigest: approval.payloadDigest,
      policyDigest: approval.policyDigest,
    })),
    operations: provenance.operations.map((operation) => ({
      id: operation.id,
      revision: operation.revision,
      state: operation.state,
      requestDigest: operation.requestDigest,
      receiptId: operation.receiptId,
    })),
    evidence: provenance.evidence.map((reference) => ({
      id: reference.id,
      kind: reference.kind,
      contentDigest: reference.contentDigest,
    })),
  });
}

function nextCheckpoint(
  provenance: MissionProvenance,
  at: string,
  activity: boolean,
): MissionCheckpoint | null {
  const planId = provenance.mission.activePlanId;
  if (!planId) return null;
  const sequence =
    Math.max(0, ...provenance.checkpoints.map((checkpoint) => checkpoint.sequence)) + 1;
  const contextDigest = checkpointContextDigest(provenance);
  const runnableWorkUnits = provenance.workUnits
    .filter((workUnit) => workUnit.state === "ready")
    .map((workUnit) => workUnit.id)
    .sort();
  const blockedWorkUnits = provenance.workUnits
    .filter((workUnit) =>
      ["awaiting_approval", "blocked", "retryable_failed", "failed"].includes(workUnit.state),
    )
    .map((workUnit) => workUnit.id)
    .sort();
  const pendingApprovals = provenance.approvals
    .filter((approval) => approval.state === "pending")
    .map((approval) => approval.id)
    .sort();
  const evidenceFrontier = provenance.evidence.map((reference) => reference.id).sort();
  return MissionCheckpointSchema.parse({
    id: `checkpoint-${digestCanonical({
      missionId: provenance.mission.id,
      planId,
      sequence,
      contextDigest,
    }).slice(0, 32)}`,
    missionId: provenance.mission.id,
    planId,
    sequence,
    reason: activity ? "step_completed" : "interrupt",
    runnableWorkUnits,
    blockedWorkUnits,
    pendingApprovals,
    evidenceFrontier,
    contextDigest,
    createdAt: at,
  });
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    const stop = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", stop, { once: true });
  });
}

/**
 * Persistent mission owner. Durable state remains in ScientificStore; a CLI,
 * model provider, or process may disappear and a new head can resume by
 * running the same deterministic reconciliation-first tick.
 */
export class ScientificMissionHead {
  private readonly store: ScientificMissionHeadStore;
  private readonly driver: ScientificMissionWorkDriver;
  private readonly policyDigestFor: ScientificMissionHeadOptions["policyDigestFor"];
  private readonly ownerId: string;
  private readonly now: () => Date;
  private readonly leaseMilliseconds: number;
  private readonly leaseHeartbeatMilliseconds: number;
  private readonly leaseSafetyMarginMilliseconds: number;
  private readonly maximumClaimsPerMissionTick: number;
  private readonly logger: MissionHeadLogger;
  private running = false;
  private ready = false;
  private lastTickStartedAt?: string;
  private lastTickFinishedAt?: string;
  private lastError?: string;

  constructor(options: ScientificMissionHeadOptions) {
    if (!options.ownerId.trim()) throw new TypeError("Mission-head ownerId is required");
    this.ownerId = options.ownerId;
    this.store = options.store;
    this.driver = options.driver;
    this.policyDigestFor = options.policyDigestFor;
    this.now = options.now ?? (() => new Date());
    this.leaseMilliseconds = options.leaseMilliseconds ?? DEFAULT_LEASE_MILLISECONDS;
    if (!Number.isInteger(this.leaseMilliseconds) || this.leaseMilliseconds <= 0) {
      throw new TypeError("leaseMilliseconds must be a positive integer");
    }
    this.leaseSafetyMarginMilliseconds =
      options.leaseSafetyMarginMilliseconds ??
      Math.min(5_000, Math.floor(this.leaseMilliseconds / 4));
    this.leaseHeartbeatMilliseconds =
      options.leaseHeartbeatMilliseconds ??
      Math.max(1, Math.floor((this.leaseMilliseconds - this.leaseSafetyMarginMilliseconds) / 2));
    this.maximumClaimsPerMissionTick =
      options.maximumClaimsPerMissionTick ?? DEFAULT_MAXIMUM_CLAIMS;
    this.logger = options.logger ?? quietLogger;
    if (
      !Number.isInteger(this.leaseSafetyMarginMilliseconds) ||
      this.leaseSafetyMarginMilliseconds < 0 ||
      this.leaseSafetyMarginMilliseconds >= this.leaseMilliseconds
    ) {
      throw new TypeError(
        "leaseSafetyMarginMilliseconds must be non-negative and smaller than leaseMilliseconds",
      );
    }
    if (
      !Number.isInteger(this.leaseHeartbeatMilliseconds) ||
      this.leaseHeartbeatMilliseconds <= 0 ||
      this.leaseHeartbeatMilliseconds >= this.leaseMilliseconds - this.leaseSafetyMarginMilliseconds
    ) {
      throw new TypeError("leaseHeartbeatMilliseconds must fit before the lease safety margin");
    }
    if (
      !Number.isInteger(this.maximumClaimsPerMissionTick) ||
      this.maximumClaimsPerMissionTick <= 0
    ) {
      throw new TypeError("maximumClaimsPerMissionTick must be a positive integer");
    }
  }

  health(): MissionHeadHealth {
    return {
      status: this.lastError ? "degraded" : "healthy",
      ready: this.ready,
      ownerId: this.ownerId,
      running: this.running,
      ...(this.lastTickStartedAt ? { lastTickStartedAt: this.lastTickStartedAt } : {}),
      ...(this.lastTickFinishedAt ? { lastTickFinishedAt: this.lastTickFinishedAt } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  async tick(signal?: AbortSignal): Promise<MissionHeadTickResult> {
    const startedAt = iso(this.now());
    this.lastTickStartedAt = startedAt;
    this.logger.log("debug", "scientific_head.tick_started", {
      ownerId: this.ownerId,
      startedAt,
    });
    const missionResults: MissionHeadMissionResult[] = [];

    try {
      const missions = await this.store.listRecoverableMissions();
      for (const mission of missions) {
        if (signal?.aborted) break;
        missionResults.push(await this.tickMission(mission, signal));
      }
      this.ready = true;
      this.lastError = missionResults.some((result) => result.error)
        ? missionResults
            .filter((result) => result.error)
            .map((result) => `${result.missionId}: ${result.error}`)
            .join("; ")
        : undefined;
    } catch (error) {
      this.lastError = errorMessage(error);
      this.logger.log("error", "scientific_head.tick_failed", {
        ownerId: this.ownerId,
        error: this.lastError,
      });
    }

    const finishedAt = iso(this.now());
    this.lastTickFinishedAt = finishedAt;
    const result: MissionHeadTickResult = {
      ownerId: this.ownerId,
      startedAt,
      finishedAt,
      missions: missionResults,
      totals: {
        missions: missionResults.length,
        reconciled: missionResults
          .flatMap((mission) => mission.reconciliations)
          .filter((item) => item.status === "reconciled").length,
        unresolvedOperations: missionResults
          .flatMap((mission) => mission.reconciliations)
          .filter((item) => item.status === "waiting" || item.status === "ambiguous").length,
        claimsWon: missionResults
          .flatMap((mission) => mission.claims)
          .filter((claim) => claim.claimed).length,
        claimsLost: missionResults
          .flatMap((mission) => mission.claims)
          .filter((claim) => !claim.claimed).length,
        completedWorkUnits: missionResults
          .flatMap((mission) => mission.claims)
          .filter((claim) => claim.claimed && claim.execution.status === "completed").length,
        failedWorkUnits: missionResults
          .flatMap((mission) => mission.claims)
          .filter((claim) => claim.claimed && claim.execution.status === "failed").length,
        claimLostWorkUnits: missionResults
          .flatMap((mission) => mission.claims)
          .filter((claim) => claim.claimed && claim.execution.status === "claim_lost").length,
      },
    };
    this.logger.log(this.lastError ? "warn" : "info", "scientific_head.tick_finished", {
      ownerId: this.ownerId,
      startedAt,
      finishedAt,
      totals: result.totals,
      ...(this.lastError ? { error: this.lastError } : {}),
    });
    return result;
  }

  private async tickMission(
    mission: ScientificMission,
    signal?: AbortSignal,
  ): Promise<MissionHeadMissionResult> {
    const result: MissionHeadMissionResult = {
      missionId: mission.id,
      initialState: mission.state,
      reconciliations: [],
      claims: [],
      blockedByReconciliation: false,
    };
    try {
      const pendingOperations = await this.store.listOperationsForReconciliation(mission.id);
      for (const operation of pendingOperations) {
        if (signal?.aborted) break;
        const reconciliation = await this.driver.reconcileOperation(operation, {
          ownerId: this.ownerId,
          now: iso(this.now()),
          signal,
        });
        result.reconciliations.push(reconciliation);
      }
      result.blockedByReconciliation = result.reconciliations.some(
        (item) => item.status !== "reconciled",
      );

      if (!result.blockedByReconciliation && !signal?.aborted) {
        const runnable = await this.store.listRunnableWorkUnits(mission.id, iso(this.now()));
        for (const workUnit of runnable.slice(0, this.maximumClaimsPerMissionTick)) {
          if (signal?.aborted) break;
          const policyDigest = await this.policyDigestFor(workUnit);
          const now = this.now();
          const nowText = iso(now);
          const expiresAt = iso(new Date(now.getTime() + this.leaseMilliseconds));
          const claim = await this.store.claimWorkUnit({
            workUnitId: workUnit.id,
            ownerId: this.ownerId,
            now: nowText,
            expiresAt,
            claimId: `claim-${digestCanonical({
              ownerId: this.ownerId,
              workUnitId: workUnit.id,
              revision: workUnit.revision,
              now: nowText,
            }).slice(0, 32)}`,
            policyDigest,
          });
          if (!claim.claimed) {
            result.claims.push({
              claimed: false,
              workUnitId: workUnit.id,
              reason: claim.reason,
              detail: claim.message,
            });
            continue;
          }
          const executionController = new AbortController();
          const abortExecution = (): void => {
            if (!executionController.signal.aborted) {
              executionController.abort(signal?.reason);
            }
          };
          if (signal?.aborted) abortExecution();
          else signal?.addEventListener("abort", abortExecution, { once: true });

          let claimLost = false;
          let heartbeatRunning = false;
          let heartbeatPromise: Promise<void> | undefined;
          const heartbeat = async (): Promise<void> => {
            if (heartbeatRunning || executionController.signal.aborted) return;
            heartbeatRunning = true;
            try {
              const heartbeatNow = this.now();
              const heartbeatNowText = iso(heartbeatNow);
              const heartbeatExpiry = iso(
                new Date(heartbeatNow.getTime() + this.leaseMilliseconds),
              );
              await this.store.renewWorkUnitClaim({
                workUnitId: claim.workUnit.id,
                claimId: claim.claimId,
                ownerId: this.ownerId,
                now: heartbeatNowText,
                expiresAt: heartbeatExpiry,
              });
            } catch (error) {
              claimLost = true;
              this.logger.log("error", "scientific_head.claim_lost", {
                ownerId: this.ownerId,
                missionId: mission.id,
                workUnitId: claim.workUnit.id,
                claimId: claim.claimId,
                error: errorMessage(error),
              });
              abortExecution();
            } finally {
              heartbeatRunning = false;
            }
          };
          const heartbeatTimer = setInterval(() => {
            heartbeatPromise = heartbeat();
          }, this.leaseHeartbeatMilliseconds);
          let execution: MissionWorkExecution;
          try {
            execution = await this.driver.executeClaimedWorkUnit(claim.workUnit, {
              ownerId: this.ownerId,
              claimOwner: this.ownerId,
              now: nowText,
              signal: executionController.signal,
            });
          } finally {
            clearInterval(heartbeatTimer);
            await heartbeatPromise;
            signal?.removeEventListener("abort", abortExecution);
          }
          if (claimLost) {
            execution = {
              status: "claim_lost",
              workUnitId: claim.workUnit.id,
              detail: "Work-unit lease renewal failed; execution was aborted fail-closed",
              retryable: false,
            };
          }
          result.claims.push({
            claimed: true,
            workUnitId: workUnit.id,
            claimId: claim.claimId,
            execution,
          });
        }
      }

      const provenance = await this.store.getMissionProvenance(mission.id);
      const checkpoint = nextCheckpoint(
        provenance,
        iso(this.now()),
        result.reconciliations.length > 0 || result.claims.length > 0,
      );
      if (checkpoint) {
        try {
          result.checkpointId = (await this.store.createCheckpoint(checkpoint)).id;
        } catch (error) {
          this.logger.log("warn", "scientific_head.checkpoint_conflict", {
            ownerId: this.ownerId,
            missionId: mission.id,
            checkpointId: checkpoint.id,
            error: errorMessage(error),
          });
        }
      }
      return result;
    } catch (error) {
      result.error = errorMessage(error);
      this.logger.log("error", "scientific_head.mission_failed", {
        ownerId: this.ownerId,
        missionId: mission.id,
        error: result.error,
      });
      return result;
    }
  }

  async run(options: MissionHeadRunOptions): Promise<void> {
    if (this.running) throw new Error("ScientificMissionHead is already running");
    this.running = true;
    const delay = options.idleDelayMilliseconds ?? DEFAULT_IDLE_DELAY_MILLISECONDS;
    if (!Number.isInteger(delay) || delay < 0) {
      this.running = false;
      throw new TypeError("idleDelayMilliseconds must be a non-negative integer");
    }
    try {
      while (!options.signal.aborted) {
        const result = await this.tick(options.signal);
        await options.onTick?.(result);
        if (!options.signal.aborted && delay > 0) {
          await abortableDelay(delay, options.signal);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
