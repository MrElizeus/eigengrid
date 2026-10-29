import { randomUUID } from "node:crypto";
import {
  AgentWorkResultSchema,
  CorrectionOrderSchema,
  VerificationRequestSchema,
  VerificationResultSchema,
  canonicalJson,
  validateCorrectionBinding,
  validateVerificationBinding,
  validateWorkResultBinding,
  verifyContractDigest,
  type VerificationResult,
} from "@eigengrid/colony-contracts";
import {
  ColonyUsageSchema,
  ZERO_COLONY_USAGE,
  addUsage,
  assertUsageWithin,
  contractBudgetToColonyBudget,
  contractUsageToColonyUsage,
  type ColonyUsage,
} from "./budget";
import {
  EMPTY_CHECKPOINT_CURSOR,
  JsonlCheckpointStore,
  type CheckpointCursor,
} from "./checkpoint-store";
import { SpeciesRegistry } from "./species-registry";
import {
  CHECKPOINT_SCHEMA_ID,
  ColonyEventSchema,
  FencedLeaseSchema,
  initialUnitState,
  parseCampaignDefinition,
  type CampaignDefinition,
  type CampaignSnapshot,
  type CheckpointRecord,
  type ColonyEvent,
  type FencedLease,
  type UnitRuntimeState,
} from "./state";

export type ColonyStateErrorCode =
  | "EMPTY_CHECKPOINT"
  | "CAMPAIGN_EXISTS"
  | "INVALID_TRANSITION"
  | "UNKNOWN_UNIT"
  | "DEPENDENCIES_INCOMPLETE"
  | "PARALLELISM_LIMIT"
  | "LEASE_CONFLICT"
  | "STALE_LEASE"
  | "DEADLINE_EXCEEDED"
  | "RESULT_CONFLICT"
  | "VERIFIER_REQUIRED"
  | "CORRECTION_LIMIT"
  | "NO_PROGRESS"
  | "TERMINAL_CAMPAIGN";

export class ColonyStateError extends Error {
  constructor(
    readonly code: ColonyStateErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ColonyStateError";
  }
}

export interface CreateSupervisorInput {
  readonly definition: unknown;
  readonly registry: SpeciesRegistry;
  readonly store: JsonlCheckpointStore;
  readonly at: string;
}

export interface RecoverSupervisorInput {
  readonly campaignId: string;
  readonly registry: SpeciesRegistry;
  readonly store: JsonlCheckpointStore;
  readonly at: string;
}

export type ResultDisposition = "accepted" | "duplicate" | "stale" | "conflict" | "escalated";

function assertNever(value: never): never {
  throw new TypeError(`Unhandled colony event: ${canonicalJson(value)}`);
}

function unitOf(snapshot: CampaignSnapshot, unitId: string): UnitRuntimeState {
  const unit = snapshot.units[unitId];
  if (!unit) throw new ColonyStateError("UNKNOWN_UNIT", `Unknown work unit ${unitId}`);
  return unit;
}

function campaignIsTerminal(snapshot: CampaignSnapshot): boolean {
  return ["completed", "blocked", "cancelled"].includes(snapshot.status);
}

function dependenciesComplete(snapshot: CampaignSnapshot, unit: UnitRuntimeState): boolean {
  return unit.definition.dependencies.every(
    (dependency) => unitOf(snapshot, dependency).status === "completed",
  );
}

function activateJoinBarriers(snapshot: CampaignSnapshot): void {
  for (const unit of Object.values(snapshot.units)) {
    if (unit.status === "pending" && dependenciesComplete(snapshot, unit)) unit.status = "ready";
  }
}

function blockCampaign(snapshot: CampaignSnapshot): void {
  snapshot.status = "blocked";
  for (const unit of Object.values(snapshot.units)) {
    if (unit.status !== "completed") {
      unit.status = "blocked";
      unit.activeLease = undefined;
    }
  }
}

function refreshCampaignStatus(snapshot: CampaignSnapshot): void {
  if (campaignIsTerminal(snapshot) || snapshot.status === "admitted") return;
  const statuses = Object.values(snapshot.units).map((unit) => unit.status);
  if (statuses.includes("blocked")) blockCampaign(snapshot);
  else if (
    statuses.some((status) => status === "correction_required" || status === "correction_ready")
  ) {
    snapshot.status = "correcting";
  } else if (statuses.includes("awaiting_verification")) snapshot.status = "verifying";
  else snapshot.status = "active";
}

function assertLeaseTimeline(lease: FencedLease): void {
  const acquired = Date.parse(lease.acquiredAt);
  const heartbeat = Date.parse(lease.heartbeatAt);
  const expires = Date.parse(lease.expiresAt);
  const deadline = Date.parse(lease.hardDeadline);
  if (!(acquired <= heartbeat && heartbeat < expires && expires <= deadline)) {
    throw new ColonyStateError(
      "INVALID_TRANSITION",
      `Lease ${lease.leaseId} has an invalid timeline`,
    );
  }
}

function assertSpeciesBudget(
  definition: CampaignDefinition,
  species: ReturnType<SpeciesRegistry["resolve"]>,
): void {
  const speciesLimit = {
    ...contractBudgetToColonyBudget(species.budgetPolicy),
    frontierCalls: species.frontierEscalation.maximumCalls,
  };
  assertUsageWithin(
    ColonyUsageSchema.parse(definition.budget),
    speciesLimit,
    `campaign ${definition.campaignId} species allocation`,
  );
}

function applyUsage(
  snapshot: CampaignSnapshot,
  unit: UnitRuntimeState,
  incrementInput: ColonyUsage,
): void {
  const increment = ColonyUsageSchema.parse(incrementInput);
  const unitUsage = addUsage(unit.usage, increment);
  const campaignUsage = addUsage(snapshot.usage, increment);
  assertUsageWithin(unitUsage, unit.definition.budget, `work unit ${unit.definition.id}`);
  assertUsageWithin(
    campaignUsage,
    snapshot.definition.budget,
    `campaign ${snapshot.definition.campaignId}`,
  );
  unit.usage = unitUsage;
  snapshot.usage = campaignUsage;
}

/** Replay one already integrity-checked record and enforce semantic invariants. */
export function reduceCheckpointRecord(
  current: CampaignSnapshot | undefined,
  record: CheckpointRecord,
): CampaignSnapshot {
  const event = ColonyEventSchema.parse(record.event);
  if (!current) {
    if (event.type !== "campaign_admitted" || record.sequence !== 1) {
      throw new ColonyStateError(
        "INVALID_TRANSITION",
        "First checkpoint event must admit a campaign",
      );
    }
    const definition = parseCampaignDefinition(event.definition);
    if (definition.campaignId !== record.campaignId) {
      throw new ColonyStateError(
        "INVALID_TRANSITION",
        "Admission campaign ID does not match record",
      );
    }
    return {
      definition,
      status: "admitted",
      sequence: record.sequence,
      lastRecordDigest: record.recordDigest,
      lastEventAt: record.at,
      units: Object.fromEntries(
        definition.workUnits.map((unit) => [unit.id, initialUnitState(unit)]),
      ),
      usage: ColonyUsageSchema.parse(ZERO_COLONY_USAGE),
      recoveryCount: 0,
    };
  }

  const snapshot = current;
  if (record.campaignId !== snapshot.definition.campaignId) {
    throw new ColonyStateError("INVALID_TRANSITION", "Checkpoint campaign changed during replay");
  }
  if (
    record.sequence !== snapshot.sequence + 1 ||
    record.previousDigest !== snapshot.lastRecordDigest
  ) {
    throw new ColonyStateError(
      "INVALID_TRANSITION",
      "Checkpoint record is not the next state transition",
    );
  }

  switch (event.type) {
    case "campaign_admitted":
      throw new ColonyStateError("CAMPAIGN_EXISTS", "Campaign was admitted more than once");
    case "campaign_started":
      if (snapshot.status !== "admitted") {
        throw new ColonyStateError("INVALID_TRANSITION", "Only an admitted campaign can start");
      }
      snapshot.status = "active";
      break;
    case "lease_acquired": {
      const unit = unitOf(snapshot, event.unitId);
      if (unit.status !== "ready" && unit.status !== "correction_ready") {
        throw new ColonyStateError("INVALID_TRANSITION", `${event.unitId} is not lease-ready`);
      }
      if (!dependenciesComplete(snapshot, unit)) {
        throw new ColonyStateError(
          "DEPENDENCIES_INCOMPLETE",
          `${event.unitId} join barrier is closed`,
        );
      }
      assertLeaseTimeline(event.lease);
      const expectedHardDeadline = Math.min(
        Date.parse(unit.definition.workOrder.cancellation.deadline),
        Date.parse(snapshot.definition.createdAt) + snapshot.definition.budget.wallTimeMs,
      );
      if (
        event.lease.unitId !== event.unitId ||
        event.lease.fencingToken !== unit.lastFencingToken + 1 ||
        Date.parse(event.lease.hardDeadline) !== expectedHardDeadline ||
        Date.parse(event.lease.expiresAt) - Date.parse(event.lease.acquiredAt) >
          snapshot.definition.leaseDurationMs
      ) {
        throw new ColonyStateError(
          "INVALID_TRANSITION",
          "Lease exceeds its fencing, duration, or hard-deadline authority",
        );
      }
      unit.lastFencingToken = event.lease.fencingToken;
      unit.activeLease = event.lease;
      unit.status = "leased";
      break;
    }
    case "lease_renewed": {
      const unit = unitOf(snapshot, event.unitId);
      const lease = unit.activeLease;
      if (
        unit.status !== "leased" ||
        !lease ||
        lease.ownerId !== event.ownerId ||
        lease.fencingToken !== event.fencingToken
      ) {
        throw new ColonyStateError("STALE_LEASE", `Cannot renew stale lease for ${event.unitId}`);
      }
      const renewed = FencedLeaseSchema.parse({
        ...lease,
        heartbeatAt: event.heartbeatAt,
        expiresAt: event.expiresAt,
      });
      assertLeaseTimeline(renewed);
      if (Date.parse(event.heartbeatAt) < Date.parse(lease.heartbeatAt)) {
        throw new ColonyStateError("INVALID_TRANSITION", "Lease heartbeat regressed");
      }
      if (
        Date.parse(event.expiresAt) < Date.parse(lease.expiresAt) ||
        Date.parse(event.expiresAt) - Date.parse(event.heartbeatAt) >
          snapshot.definition.leaseDurationMs
      ) {
        throw new ColonyStateError("INVALID_TRANSITION", "Lease renewal has an invalid extension");
      }
      unit.activeLease = renewed;
      break;
    }
    case "lease_expired": {
      const unit = unitOf(snapshot, event.unitId);
      if (!unit.activeLease || unit.activeLease.fencingToken !== event.fencingToken) {
        throw new ColonyStateError("STALE_LEASE", `Cannot expire stale lease for ${event.unitId}`);
      }
      if (Date.parse(record.at) < Date.parse(unit.activeLease.expiresAt)) {
        throw new ColonyStateError("INVALID_TRANSITION", `Lease ${event.unitId} expired early`);
      }
      unit.activeLease = undefined;
      unit.status = unit.corrections.length > 0 ? "correction_ready" : "ready";
      break;
    }
    case "result_accepted": {
      const unit = unitOf(snapshot, event.unitId);
      if (
        unit.status !== "leased" ||
        !unit.activeLease ||
        unit.activeLease.fencingToken !== event.fencingToken ||
        Date.parse(record.at) >= Date.parse(unit.activeLease.expiresAt)
      ) {
        throw new ColonyStateError("STALE_LEASE", `Result used a stale lease for ${event.unitId}`);
      }
      validateWorkResultBinding(unit.definition.workOrder, event.result);
      applyUsage(snapshot, unit, contractUsageToColonyUsage(event.result.usage));
      unit.acceptedResult = event.result;
      unit.acceptedFencingToken = event.fencingToken;
      unit.activeLease = undefined;
      unit.verificationRequest = undefined;
      unit.verificationResult = undefined;
      unit.status = "awaiting_verification";
      break;
    }
    case "result_duplicate": {
      const unit = unitOf(snapshot, event.unitId);
      if (
        unit.acceptedFencingToken !== event.fencingToken ||
        unit.acceptedResult?.resultDigest !== event.resultDigest
      ) {
        throw new ColonyStateError(
          "INVALID_TRANSITION",
          "Duplicate result is not the accepted result",
        );
      }
      unit.duplicateResultDigests.push(event.resultDigest);
      break;
    }
    case "result_stale": {
      const unit = unitOf(snapshot, event.unitId);
      if (
        unit.activeLease?.fencingToken === event.fencingToken &&
        Date.parse(record.at) < Date.parse(unit.activeLease.expiresAt)
      ) {
        throw new ColonyStateError("INVALID_TRANSITION", "Current live lease result is not stale");
      }
      unit.staleResultDigests.push(event.resultDigest);
      break;
    }
    case "result_conflict": {
      const unit = unitOf(snapshot, event.unitId);
      if (
        unit.acceptedFencingToken !== event.fencingToken ||
        unit.acceptedResult?.resultDigest !== event.acceptedDigest
      ) {
        throw new ColonyStateError(
          "INVALID_TRANSITION",
          "Conflict does not name the accepted result",
        );
      }
      unit.conflictingResultDigests.push(event.conflictingDigest);
      unit.status = "blocked";
      unit.activeLease = undefined;
      blockCampaign(snapshot);
      break;
    }
    case "verification_accepted": {
      const unit = unitOf(snapshot, event.unitId);
      if (unit.status !== "awaiting_verification" || !unit.acceptedResult) {
        throw new ColonyStateError(
          "VERIFIER_REQUIRED",
          `${event.unitId} has no candidate to verify`,
        );
      }
      if (!verifyContractDigest(event.request) || !verifyContractDigest(event.result)) {
        throw new TypeError("Verification contracts must have valid canonical digests");
      }
      validateVerificationBinding(event.request, event.result);
      if (
        event.request.verifierCaste !== "verifier" ||
        event.request.workResultDigest !== unit.acceptedResult.resultDigest ||
        event.request.workOrderId !== unit.definition.workOrder.workOrderId ||
        canonicalJson(event.request.species) !== canonicalJson(snapshot.definition.species) ||
        !unit.acceptedResult.candidates.some(
          (candidate) => candidate.digest === event.request.candidate.digest,
        )
      ) {
        throw new ColonyStateError(
          "VERIFIER_REQUIRED",
          "Verification is not bound to the accepted candidate",
        );
      }
      applyUsage(snapshot, unit, contractUsageToColonyUsage(event.result.usage));
      unit.verificationRequest = event.request;
      unit.verificationResult = event.result;
      if (event.result.verdict === "pass") unit.status = "completed";
      else if (event.result.verdict === "fail") unit.status = "correction_required";
      else unit.status = "blocked";
      break;
    }
    case "correction_issued": {
      const unit = unitOf(snapshot, event.unitId);
      if (
        unit.status !== "correction_required" ||
        !unit.acceptedResult ||
        !unit.verificationResult
      ) {
        throw new ColonyStateError(
          "INVALID_TRANSITION",
          `${event.unitId} does not require correction`,
        );
      }
      if (event.order.attempt !== unit.corrections.length + 1) {
        throw new ColonyStateError("INVALID_TRANSITION", "Correction attempt is not sequential");
      }
      if (unit.corrections.length >= snapshot.definition.maxCorrectionsPerUnit) {
        throw new ColonyStateError("CORRECTION_LIMIT", `${event.unitId} correction limit reached`);
      }
      validateCorrectionBinding(
        event.order,
        unit.definition.workOrder,
        unit.acceptedResult,
        unit.verificationResult,
      );
      applyUsage(snapshot, unit, ColonyUsageSchema.parse({ ...ZERO_COLONY_USAGE, corrections: 1 }));
      unit.corrections.push(event.order);
      unit.status = "correction_ready";
      break;
    }
    case "frontier_usage_recorded":
      applyUsage(snapshot, unitOf(snapshot, event.unitId), event.usage);
      break;
    case "unit_escalated": {
      const unit = unitOf(snapshot, event.escalation.unitId);
      unit.escalation = event.escalation;
      unit.status = "blocked";
      unit.activeLease = undefined;
      blockCampaign(snapshot);
      break;
    }
    case "campaign_recovered":
      snapshot.recoveryCount += 1;
      break;
    case "campaign_completed":
      if (!Object.values(snapshot.units).every((unit) => unit.status === "completed")) {
        throw new ColonyStateError(
          "INVALID_TRANSITION",
          "Campaign cannot complete before every join is verified",
        );
      }
      snapshot.status = "completed";
      break;
    case "campaign_cancelled":
      if (snapshot.status === "completed") {
        throw new ColonyStateError("TERMINAL_CAMPAIGN", "A completed campaign cannot be cancelled");
      }
      snapshot.status = "cancelled";
      for (const unit of Object.values(snapshot.units)) {
        if (unit.status !== "completed") {
          unit.status = "cancelled";
          unit.activeLease = undefined;
        }
      }
      break;
    default:
      assertNever(event);
  }

  activateJoinBarriers(snapshot);
  refreshCampaignStatus(snapshot);
  snapshot.sequence = record.sequence;
  snapshot.lastRecordDigest = record.recordDigest;
  snapshot.lastEventAt = record.at;
  return snapshot;
}

function replay(records: readonly CheckpointRecord[]): CampaignSnapshot {
  let snapshot: CampaignSnapshot | undefined;
  for (const record of records) snapshot = reduceCheckpointRecord(snapshot, record);
  if (!snapshot)
    throw new ColonyStateError("EMPTY_CHECKPOINT", "Checkpoint has no admitted campaign");
  return snapshot;
}

function cursorOf(snapshot: CampaignSnapshot): CheckpointCursor {
  return { sequence: snapshot.sequence, digest: snapshot.lastRecordDigest };
}

export class ColonySupervisor {
  private constructor(
    readonly registry: SpeciesRegistry,
    readonly store: JsonlCheckpointStore,
    private state: CampaignSnapshot,
  ) {}

  static create(input: CreateSupervisorInput): ColonySupervisor {
    const definition = parseCampaignDefinition(input.definition);
    const species = input.registry.assertAdmissible(definition.species, definition.executionMode);
    if (
      definition.maxCorrectionsPerUnit > Math.min(2, species.correctionTopology.maximumCorrections)
    ) {
      throw new ColonyStateError(
        "CORRECTION_LIMIT",
        "Campaign correction limit exceeds species policy",
      );
    }
    if (definition.budget.frontierCalls > species.frontierEscalation.maximumCalls) {
      throw new TypeError("Campaign frontier-call budget exceeds the species policy");
    }
    assertSpeciesBudget(definition, species);
    if (definition.executionMode === "shadow" && definition.budget.effects !== 0) {
      throw new TypeError("Shadow campaigns must have a zero-effects budget");
    }
    input.store.repairTornTail();
    const existing = input.store.load(definition.campaignId);
    if (existing.records.length > 0) {
      throw new ColonyStateError(
        "CAMPAIGN_EXISTS",
        `Campaign ${definition.campaignId} already exists`,
      );
    }
    const admitted = input.store.append(
      definition.campaignId,
      input.at,
      { type: "campaign_admitted", definition },
      EMPTY_CHECKPOINT_CURSOR,
    );
    let state = reduceCheckpointRecord(undefined, admitted);
    const started = input.store.append(
      definition.campaignId,
      input.at,
      { type: "campaign_started" },
      cursorOf(state),
    );
    state = reduceCheckpointRecord(state, started);
    return new ColonySupervisor(input.registry, input.store, state);
  }

  static recover(input: RecoverSupervisorInput): ColonySupervisor {
    const tornTailRepaired = input.store.repairTornTail();
    const loaded = input.store.load(input.campaignId);
    const state = replay(loaded.records);
    const species = input.registry.assertAdmissible(
      state.definition.species,
      state.definition.executionMode,
    );
    if (
      state.definition.maxCorrectionsPerUnit >
      Math.min(2, species.correctionTopology.maximumCorrections)
    ) {
      throw new ColonyStateError(
        "CORRECTION_LIMIT",
        "Persisted campaign exceeds species correction policy",
      );
    }
    assertSpeciesBudget(state.definition, species);
    const supervisor = new ColonySupervisor(input.registry, input.store, state);
    const expiredLeaseCount = supervisor.expireLeases(input.at);
    const campaignDeadline =
      Date.parse(state.definition.createdAt) + state.definition.budget.wallTimeMs;
    if (Date.parse(input.at) > campaignDeadline) {
      for (const unit of Object.values(supervisor.state.units)) {
        if (unit.status !== "completed" && unit.status !== "blocked") {
          supervisor.escalate(
            unit.definition.id,
            "blocked",
            "Campaign wall-time budget elapsed before restart recovery",
            input.at,
          );
        }
      }
    }
    supervisor.append(input.at, {
      type: "campaign_recovered",
      expiredLeaseCount,
      tornTailRepaired,
    });
    return supervisor;
  }

  snapshot(): CampaignSnapshot {
    return structuredClone(this.state);
  }

  claim(
    unitId: string,
    ownerId: string,
    at: string,
    leaseId = randomUUID(),
  ): { lease: FencedLease; duplicate: boolean } {
    this.assertLive(at);
    this.expireLeases(at);
    const unit = unitOf(this.state, unitId);
    if (unit.activeLease) {
      if (unit.activeLease.ownerId === ownerId)
        return { lease: structuredClone(unit.activeLease), duplicate: true };
      throw new ColonyStateError(
        "LEASE_CONFLICT",
        `${unitId} is leased by ${unit.activeLease.ownerId}`,
      );
    }
    if (unit.status !== "ready" && unit.status !== "correction_ready") {
      throw new ColonyStateError("INVALID_TRANSITION", `${unitId} is not ready`);
    }
    if (!dependenciesComplete(this.state, unit)) {
      throw new ColonyStateError("DEPENDENCIES_INCOMPLETE", `${unitId} join barrier is closed`);
    }
    const active = Object.values(this.state.units).filter(
      (candidate) => candidate.activeLease,
    ).length;
    if (active >= this.state.definition.maximumParallelism) {
      throw new ColonyStateError("PARALLELISM_LIMIT", "Campaign parallelism limit reached");
    }
    const acquired = Date.parse(at);
    const hardDeadline = Math.min(
      Date.parse(unit.definition.workOrder.cancellation.deadline),
      Date.parse(this.state.definition.createdAt) + this.state.definition.budget.wallTimeMs,
    );
    if (acquired >= hardDeadline) {
      throw new ColonyStateError("DEADLINE_EXCEEDED", `${unitId} hard deadline has elapsed`);
    }
    const lease = FencedLeaseSchema.parse({
      leaseId,
      unitId,
      ownerId,
      fencingToken: unit.lastFencingToken + 1,
      acquiredAt: at,
      heartbeatAt: at,
      expiresAt: new Date(
        Math.min(acquired + this.state.definition.leaseDurationMs, hardDeadline),
      ).toISOString(),
      hardDeadline: new Date(hardDeadline).toISOString(),
    });
    assertLeaseTimeline(lease);
    this.append(at, { type: "lease_acquired", unitId, lease });
    return { lease: structuredClone(lease), duplicate: false };
  }

  heartbeat(unitId: string, ownerId: string, fencingToken: number, at: string): FencedLease {
    this.assertLive(at);
    this.expireLeases(at);
    const unit = unitOf(this.state, unitId);
    const lease = unit.activeLease;
    if (
      !lease ||
      lease.ownerId !== ownerId ||
      lease.fencingToken !== fencingToken ||
      Date.parse(at) >= Date.parse(lease.expiresAt)
    ) {
      throw new ColonyStateError("STALE_LEASE", `Heartbeat rejected for stale lease on ${unitId}`);
    }
    const expiresAt = new Date(
      Math.min(
        Date.parse(at) + this.state.definition.leaseDurationMs,
        Date.parse(lease.hardDeadline),
      ),
    ).toISOString();
    if (Date.parse(at) >= Date.parse(expiresAt)) {
      throw new ColonyStateError("DEADLINE_EXCEEDED", `${unitId} hard deadline has elapsed`);
    }
    this.append(at, {
      type: "lease_renewed",
      unitId,
      ownerId,
      fencingToken,
      heartbeatAt: at,
      expiresAt,
    });
    return structuredClone(unitOf(this.state, unitId).activeLease!);
  }

  submitResult(
    unitId: string,
    fencingToken: number,
    resultInput: unknown,
    at: string,
  ): ResultDisposition {
    // Results are authoritative state transitions. Reject submissions after
    // campaign termination or the global wall-time deadline before parsing or
    // appending any result/duplicate/stale event.
    this.assertLive(at);
    const result = AgentWorkResultSchema.parse(resultInput);
    if (!verifyContractDigest(result)) throw new TypeError("Work result canonical digest mismatch");
    const unit = unitOf(this.state, unitId);
    validateWorkResultBinding(unit.definition.workOrder, result);

    if (unit.acceptedFencingToken === fencingToken && unit.acceptedResult) {
      if (unit.acceptedResult.resultDigest === result.resultDigest) {
        this.append(at, {
          type: "result_duplicate",
          unitId,
          fencingToken,
          resultDigest: result.resultDigest,
        });
        return "duplicate";
      }
      this.append(at, {
        type: "result_conflict",
        unitId,
        fencingToken,
        acceptedDigest: unit.acceptedResult.resultDigest,
        conflictingDigest: result.resultDigest,
      });
      return "conflict";
    }

    const lease = unit.activeLease;
    if (
      !lease ||
      lease.fencingToken !== fencingToken ||
      Date.parse(at) >= Date.parse(lease.expiresAt)
    ) {
      if (lease?.fencingToken === fencingToken && Date.parse(at) >= Date.parse(lease.expiresAt)) {
        this.append(at, {
          type: "lease_expired",
          unitId,
          fencingToken,
          reason: "Result arrived at or after lease expiry",
        });
      }
      this.append(at, {
        type: "result_stale",
        unitId,
        fencingToken,
        resultDigest: result.resultDigest,
      });
      return "stale";
    }

    this.append(at, { type: "result_accepted", unitId, fencingToken, result });
    if (unit.corrections.length > 0) {
      const priorDigest = unit.corrections.at(-1)!.previousCandidateDigest;
      const progressed = result.candidates.some((candidate) => candidate.digest !== priorDigest);
      if (!progressed) {
        this.escalate(unitId, "owner", "Correction produced no candidate digest delta", at);
        return "escalated";
      }
    }
    return "accepted";
  }

  submitVerification(
    unitId: string,
    requestInput: unknown,
    resultInput: unknown,
    at: string,
  ): VerificationResult["verdict"] {
    this.assertLive(at);
    const request = VerificationRequestSchema.parse(requestInput);
    const result = VerificationResultSchema.parse(resultInput);
    if (!verifyContractDigest(request) || !verifyContractDigest(result)) {
      throw new TypeError("Verification contract canonical digest mismatch");
    }
    const unit = unitOf(this.state, unitId);
    if (!unit.acceptedResult) {
      throw new ColonyStateError("VERIFIER_REQUIRED", `${unitId} has no accepted candidate`);
    }
    validateVerificationBinding(request, result);
    assertUsageWithin(
      contractBudgetToColonyBudget(request.budget),
      unit.definition.budget,
      `verification allocation for ${unitId}`,
    );
    this.append(at, { type: "verification_accepted", unitId, request, result });
    if (
      result.verdict === "fail" &&
      unitOf(this.state, unitId).corrections.length >= this.state.definition.maxCorrectionsPerUnit
    ) {
      this.escalate(
        unitId,
        "owner",
        "Independent verification failed after the correction limit",
        at,
      );
    }
    this.completeIfReady(at);
    return result.verdict;
  }

  issueCorrection(unitId: string, orderInput: unknown, at: string): "issued" | "escalated" {
    this.assertLive(at);
    const unit = unitOf(this.state, unitId);
    if (unit.corrections.length >= this.state.definition.maxCorrectionsPerUnit) {
      this.escalate(
        unitId,
        "owner",
        "A further correction would exceed the two-attempt ceiling",
        at,
      );
      return "escalated";
    }
    const order = CorrectionOrderSchema.parse(orderInput);
    if (!verifyContractDigest(order))
      throw new TypeError("Correction order canonical digest mismatch");
    if (!unit.acceptedResult || !unit.verificationResult) {
      throw new ColonyStateError(
        "INVALID_TRANSITION",
        `${unitId} lacks failed verification evidence`,
      );
    }
    validateCorrectionBinding(
      order,
      unit.definition.workOrder,
      unit.acceptedResult,
      unit.verificationResult,
    );
    this.append(at, { type: "correction_issued", unitId, order });
    return "issued";
  }

  recordFrontierUsage(unitId: string, usageInput: ColonyUsage, at: string): void {
    this.assertLive(at);
    const usage = ColonyUsageSchema.parse(usageInput);
    if (usage.frontierCalls === 0)
      throw new TypeError("Frontier usage must record at least one call");
    this.append(at, { type: "frontier_usage_recorded", unitId, usage });
  }

  cancel(reason: string, at: string): void {
    if (this.state.status === "completed") {
      throw new ColonyStateError("TERMINAL_CAMPAIGN", "Completed campaign cannot be cancelled");
    }
    if (this.state.status === "cancelled") return;
    this.append(at, { type: "campaign_cancelled", reason });
  }

  private append(at: string, event: ColonyEvent): CheckpointRecord {
    const preview = reduceCheckpointRecord(structuredClone(this.state), {
      schema: CHECKPOINT_SCHEMA_ID,
      eventId: "preflight",
      campaignId: this.state.definition.campaignId,
      sequence: this.state.sequence + 1,
      at,
      previousDigest: this.state.lastRecordDigest,
      event,
      recordDigest: this.state.lastRecordDigest,
    });
    const record = this.store.append(
      this.state.definition.campaignId,
      at,
      event,
      cursorOf(this.state),
    );
    preview.sequence = record.sequence;
    preview.lastRecordDigest = record.recordDigest;
    preview.lastEventAt = record.at;
    this.state = preview;
    return record;
  }

  private expireLeases(at: string): number {
    let expired = 0;
    for (const unit of Object.values(this.state.units)) {
      const lease = unit.activeLease;
      if (lease && Date.parse(at) >= Date.parse(lease.expiresAt)) {
        this.append(at, {
          type: "lease_expired",
          unitId: unit.definition.id,
          fencingToken: lease.fencingToken,
          reason: "Lease expired during reconciliation",
        });
        expired += 1;
      }
    }
    return expired;
  }

  private escalate(
    unitId: string,
    destination: "frontier" | "human" | "owner" | "blocked",
    reason: string,
    at: string,
  ): void {
    const unit = unitOf(this.state, unitId);
    if (unit.status === "blocked") return;
    this.append(at, { type: "unit_escalated", escalation: { unitId, destination, reason } });
  }

  private completeIfReady(at: string): void {
    if (
      this.state.status !== "completed" &&
      Object.values(this.state.units).every((unit) => unit.status === "completed")
    ) {
      this.append(at, { type: "campaign_completed" });
    }
  }

  private assertLive(at: string): void {
    if (campaignIsTerminal(this.state)) {
      throw new ColonyStateError("TERMINAL_CAMPAIGN", `Campaign is ${this.state.status}`);
    }
    const campaignDeadline =
      Date.parse(this.state.definition.createdAt) + this.state.definition.budget.wallTimeMs;
    if (Date.parse(at) > campaignDeadline) {
      throw new ColonyStateError("DEADLINE_EXCEEDED", "Campaign wall-time budget has elapsed");
    }
  }
}
