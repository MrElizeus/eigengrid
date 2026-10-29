import { z } from "zod";
import {
  canonicalJson,
  digestCanonical,
  EvidenceReferenceSchema,
  ScientificDecisionSchema,
} from "@eigengrid/scientific-schema";
import {
  ScientificStore,
  ScientificEffectReconciliationStore,
  ContentAddressedArtifactStore,
  type MdEffectDelivery,
} from "@eigengrid/mission-runtime";
import type { SubmitterAccountingResult } from "@eigengrid/slurm";
import type { HeadMdSiteAuthorityReader } from "./head-md-site-authority";
import { MdNoSubmitRequestSchema } from "./md-no-submit-review";
const id = z.string().min(1).max(256),
  digest = z.string().regex(/^[a-f0-9]{64}$/);
/** This root audit describes a real failed allocation, never an unsubmitted effect or MD PASS. */
const ReviewCommon = z
  .object({
    schemaVersion: z.literal("eigengrid.md-failed-allocation-review/v1"),
    projectId: id,
    missionId: id,
    operationId: id,
    workUnitId: id,
    requestDigest: digest,
    ownerUserId: id,
    scientificUid: z.number().int().positive(),
    slurmJobId: z.string().regex(/^[1-9][0-9]{0,19}$/),
    recoveryEpoch: id,
    workerFailureLogDigest: digest,
    reviewedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    proofDigest: digest,
  })
  .strict();
export const MdFailedAllocationReviewSchema = z.discriminatedUnion("reason", [
  ReviewCommon.extend({
    reason: z.literal("worker_scratch_root_absent_before_engine"),
    workerScratchRootAbsent: z.literal(true),
  }).strict(),
  ReviewCommon.extend({
    reason: z.literal("worker_failed_before_workspace_after_input_preflight"),
    workerWorkspaceAbsent: z.literal(true),
    readOnlyPreflightDigest: digest,
  }).strict(),
]);
export type MdFailedAllocationReview = z.infer<typeof MdFailedAllocationReviewSchema>;
export const MdFailedAllocationRequestSchema = MdNoSubmitRequestSchema;
export async function reconcileFailedAllocation(
  value: unknown,
  deps: {
    store: ScientificStore;
    effects: ScientificEffectReconciliationStore;
    artifacts: ContentAddressedArtifactStore;
    site: Pick<HeadMdSiteAuthorityReader, "resolvePublication">;
    reviews: readonly MdFailedAllocationReview[];
    actor: import("@eigengrid/scientific-schema").ActorIdentity;
    roles: readonly string[];
    access: (address: { projectId: string; missionId: string }) => Promise<void>;
    /** Internal composition port: authenticated submitter accounting, not a caller-supplied record. */
    accounting: (delivery: MdEffectDelivery) => Promise<SubmitterAccountingResult>;
  },
) {
  const input = MdFailedAllocationRequestSchema.parse(value),
    address = { projectId: input.projectId, missionId: input.missionId };
  await deps.access(address);
  if (!deps.roles.includes("scientific_reviewer"))
    throw new Error("Failed allocation review requires scientific reviewer role");
  const review = deps.reviews.find((r) => digestCanonical(r) === input.reviewDigest);
  if (!review) throw new Error("No exact root-provisioned failed-allocation review");
  const now = new Date().toISOString();
  if (
    review.projectId !== input.projectId ||
    review.missionId !== input.missionId ||
    review.operationId !== input.operationId ||
    review.requestDigest !== input.requestDigest ||
    review.ownerUserId !== deps.actor.id ||
    Date.parse(review.reviewedAt) > Date.parse(now) ||
    Date.parse(review.expiresAt) <= Date.parse(now)
  )
    throw new Error("Failed-allocation review is stale or outside exact authority");
  const p = await deps.store.getMissionProvenance(input.missionId),
    operation = p.operations.find((o) => o.id === input.operationId),
    work = p.workUnits.find((w) => w.id === review.workUnitId);
  if (
    !operation ||
    !work ||
    operation.kind !== "md_stage_execution" ||
    !["acknowledged", "ambiguous", "abandoned"].includes(operation.state) ||
    operation.requestDigest !== input.requestDigest ||
    operation.workUnitId !== work.id ||
    operation.receiptId ||
    !operation.budgetReservationId ||
    operation.externalIdentity?.slurmJobId !== review.slurmJobId ||
    p.mission.activePlanId !== work.planId ||
    !["executing", "paused", "replanning"].includes(p.mission.state) ||
    (work.claimExpiresAt && Date.parse(work.claimExpiresAt) > Date.parse(now)) ||
    p.operations.some(
      (o) =>
        o.id !== operation.id &&
        o.kind === "md_stage_execution" &&
        !["confirmed", "abandoned", "failed"].includes(o.state),
    )
  )
    throw new Error("Only the exact expired-claim failed allocation can be reviewed");
  const authority = deps.site.resolvePublication({
    subject: review.ownerUserId,
    projectId: input.projectId,
  });
  if (
    authority.grant.principal.uid !== review.scientificUid ||
    authority.grant.recoveryEpoch !== review.recoveryEpoch
  )
    throw new Error("Failed allocation review does not match protected site authority");
  const delivery = await deps.effects.readMdSubmissionDelivery(
    operation.id,
    authority.grant.principal,
  );
  if (
    !delivery ||
    delivery.requestDigest !== input.requestDigest ||
    Date.parse(delivery.expiresAt) >= Date.parse(review.reviewedAt)
  )
    throw new Error("Exact expired immutable delivery required");
  const proof = JSON.parse(
    Buffer.from((await deps.artifacts.get(review.proofDigest)).bytes).toString(),
  );
  if (
    proof.operationId !== operation.id ||
    proof.slurmJobId !== review.slurmJobId ||
    (review.reason === "worker_scratch_root_absent_before_engine"
      ? proof.workerScratchRootAbsent !== true
      : proof.workerWorkspaceAbsent !== true ||
        proof.readOnlyPreflightDigest !== review.readOnlyPreflightDigest) ||
    proof.workerFailureLogDigest !== review.workerFailureLogDigest
  )
    throw new Error("Root audit differs from exact failed allocation");
  if (review.reason === "worker_failed_before_workspace_after_input_preflight") {
    const text = Buffer.from(
      (await deps.artifacts.get(review.readOnlyPreflightDigest)).bytes,
    ).toString();
    const records = text
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line));
    const expected = [
      "protected_profile",
      "scientific_uid_worker_identity",
      "capsule",
      "protected_result_configuration",
      "scratch_root",
      "read_only_public_cas",
      "published_stage_bundle",
      "scratch_capacity",
      "engine_binary",
      "gpu_library_tree",
      "runner_binary",
    ];
    if (
      !expected.every((phase) => records.some((r) => r.phase === phase && r.passed === true)) ||
      records.some((r) => r.passed === false) ||
      !records.some((r) => r.passed === true && r.engineExecuted === false)
    )
      throw new Error("Read-only preflight proof is incomplete or failed");
  }
  const result = await deps.accounting(delivery);
  if (
    result.observation.status !== "matched" ||
    result.observation.identity.jobId !== review.slurmJobId ||
    result.observation.identity.uid !== review.scientificUid ||
    result.accounting?.state !== "FAILED" ||
    result.accounting.exitCode !== 74 ||
    result.accounting.signal !== 0 ||
    result.accounting.slurmJobId !== review.slurmJobId ||
    result.accounting.uid !== review.scientificUid ||
    result.accounting.cluster !== operation.externalIdentity.slurmCluster
  )
    throw new Error("Authenticated accounting must confirm exact terminal worker failure 74");
  const audit = await deps.artifacts.put(
      Buffer.from(
        canonicalJson({
          review,
          accounting: result,
          classification: "operational worker pre-engine failure; no engine result or QC receipt",
        }),
      ),
    ),
    evidenceId = "evidence-md-failed-allocation-" + input.reviewDigest;
  await deps.store.createEvidence(
    EvidenceReferenceSchema.parse({
      id: evidenceId,
      missionId: input.missionId,
      workUnitId: work.id,
      kind: "human_review",
      uri: audit.uri,
      contentDigest: audit.digest,
      sizeBytes: audit.sizeBytes,
      mediaType: "application/json",
      immutable: true,
      sourceId: operation.id,
      createdAt: review.reviewedAt,
    }),
  );
  await deps.store.createDecision(
    ScientificDecisionSchema.parse({
      id: "decision-md-failed-allocation-" + input.reviewDigest,
      missionId: input.missionId,
      planId: work.planId,
      category: "operational",
      question: "How should this exact terminal pre-engine worker failure be retired?",
      selectedOption: "abandon_failed_allocation_preserve_job_identity_and_require_new_plan",
      alternatives: [
        {
          option: "replay_original_delivery",
          reasonNotSelected:
            "Consumed delivery cannot be replayed; a new exact plan and approval are required.",
        },
      ],
      rationale: canonicalJson({
        reviewDigest: input.reviewDigest,
        proofDigest: review.proofDigest,
        actualSlurmJobId: review.slurmJobId,
        actualSchedulerFailure: 74,
        engineReceiptCreated: false,
        scientificPass: false,
        budgetConsumed: true,
      }),
      skillRefs: [],
      evidenceRefs: [evidenceId],
      confidence: {
        level: "high",
        basis:
          "Exact authenticated terminal accounting plus root-reviewed worker pre-engine filesystem and input preflight evidence.",
      },
      riskClass: 1,
      requiresApproval: false,
      actor: deps.actor,
      createdAt: review.reviewedAt,
    }),
  );
  await deps.access(address);
  if (
    digestCanonical(
      deps.site.resolvePublication({ subject: review.ownerUserId, projectId: input.projectId }),
    ) !== digestCanonical(authority)
  )
    throw new Error("Protected site authority changed during failed allocation review");
  let mission = (await deps.store.getMission(input.missionId))!;
  if (mission.state === "executing")
    mission = await deps.store.transitionMission({
      missionId: mission.id,
      expectedRevision: mission.revision,
      to: "paused",
      reason: "reviewed_failed_allocation:" + input.reviewDigest,
      actor: deps.actor,
      at: now,
    });
  let op = (await deps.store.getExternalOperation(operation.id))!;
  if (op.state === "acknowledged")
    op = await deps.store.transitionExternalOperation({
      operationId: op.id,
      expectedRevision: op.revision,
      to: "ambiguous",
      at: now,
    });
  if (op.state !== "abandoned")
    await deps.store.transitionExternalOperation({
      operationId: op.id,
      expectedRevision: op.revision,
      to: "abandoned",
      at: now,
    });
  const budget = await deps.store.getMissionBudget(input.missionId);
  if (budget.reservations.find((r) => r.id === op.budgetReservationId)?.state !== "consumed")
    await deps.store.settleBudgetReservation({
      missionId: input.missionId,
      reservationId: op.budgetReservationId!,
      expectedBudgetRevision: budget.revision,
      state: "consumed",
      at: now,
    });
  let unit = (await deps.store.getWorkUnit(work.id))!;
  if (!["cancel_requested", "cancelled"].includes(unit.state))
    unit = await deps.store.transitionWorkUnit({
      workUnitId: unit.id,
      expectedRevision: unit.revision,
      to: "cancel_requested",
      claimOwner: unit.claimOwner ?? undefined,
      at: now,
    });
  if (unit.state !== "cancelled")
    await deps.store.transitionWorkUnit({
      workUnitId: unit.id,
      expectedRevision: unit.revision,
      to: "cancelled",
      at: now,
    });
  if (mission.state !== "replanning")
    mission = await deps.store.transitionMission({
      missionId: mission.id,
      expectedRevision: mission.revision,
      to: "replanning",
      reason: "new_plan_after_actual_failed_allocation",
      actor: deps.actor,
      at: now,
    });
  return {
    missionId: mission.id,
    operationId: op.id,
    slurmJobId: review.slurmJobId,
    actualSchedulerState: "FAILED",
    state: "abandoned",
    missionState: mission.state,
    budgetConsumed: true,
    receiptCreated: false,
    resubmitAllowed: false,
    newPlanApprovalRequired: true,
  };
}
