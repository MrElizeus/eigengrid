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
} from "@eigengrid/mission-runtime";
import type { HeadMdSiteAuthorityReader } from "./head-md-site-authority";
const id = z.string().min(1).max(256),
  digest = z.string().regex(/^[a-f0-9]{64}$/);
/** Operator provisioning after a stopped, locked transport-journal audit. Never a receipt. */
export const MdNoSubmitReviewSchema = z
  .object({
    schemaVersion: z.literal("eigengrid.md-no-submit-operator-review/v1"),
    projectId: id,
    missionId: id,
    operationId: id,
    workUnitId: id,
    requestDigest: digest,
    ownerUserId: id,
    scientificUid: z.number().int().positive(),
    journalId: id,
    journalSha256: digest,
    claimCount: z.literal(0),
    receiptCount: z.literal(0),
    previousRecoveryEpoch: id,
    newRecoveryEpoch: id,
    reason: z.literal("gateway_never_initialized_no_transport_claim"),
    reviewedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    proofDigest: digest,
  })
  .strict();
export type MdNoSubmitReview = z.infer<typeof MdNoSubmitReviewSchema>;
export const MdNoSubmitRequestSchema = z
  .object({
    projectId: id,
    missionId: id,
    operationId: id,
    requestDigest: digest,
    reviewDigest: digest,
  })
  .strict();
export function assertNoSubmitReview(
  review: MdNoSubmitReview,
  input: z.infer<typeof MdNoSubmitRequestSchema>,
  live: { ownerUserId: string; uid: number; epoch: string; deliveryExpiresAt: string; now: string },
) {
  if (
    digestCanonical(review) !== input.reviewDigest ||
    review.projectId !== input.projectId ||
    review.missionId !== input.missionId ||
    review.operationId !== input.operationId ||
    review.requestDigest !== input.requestDigest ||
    review.ownerUserId !== live.ownerUserId ||
    review.scientificUid !== live.uid ||
    review.newRecoveryEpoch !== live.epoch ||
    review.previousRecoveryEpoch === live.epoch ||
    Date.parse(review.reviewedAt) > Date.parse(live.now) ||
    Date.parse(review.expiresAt) <= Date.parse(live.now) ||
    Date.parse(live.deliveryExpiresAt) >= Date.parse(review.reviewedAt)
  )
    throw new Error("No-submit review is stale, unfenced or outside exact authority");
}
export async function reconcileReviewedNoSubmit(
  value: unknown,
  deps: {
    store: ScientificStore;
    effects: ScientificEffectReconciliationStore;
    artifacts: ContentAddressedArtifactStore;
    site: Pick<HeadMdSiteAuthorityReader, "resolvePublication">;
    reviews: readonly MdNoSubmitReview[];
    actor: import("@eigengrid/scientific-schema").ActorIdentity;
    roles: readonly string[];
    access: (address: { projectId: string; missionId: string }) => Promise<void>;
  },
) {
  const input = MdNoSubmitRequestSchema.parse(value);
  const address = { projectId: input.projectId, missionId: input.missionId };
  await deps.access(address);
  if (!deps.roles.includes("scientific_reviewer"))
    throw new Error("Operator reconciliation requires scientific reviewer role");
  const review = deps.reviews.find((r) => digestCanonical(r) === input.reviewDigest);
  if (!review) throw new Error("No exact root-provisioned no-submit review");
  const now = new Date().toISOString(),
    p = await deps.store.getMissionProvenance(input.missionId);
  const operation = p.operations.find((o) => o.id === input.operationId),
    work = p.workUnits.find((w) => w.id === review.workUnitId);
  if (
    !operation ||
    !work ||
    operation.kind !== "md_stage_execution" ||
    !["ambiguous", "abandoned"].includes(operation.state) ||
    operation.requestDigest !== input.requestDigest ||
    operation.workUnitId !== work.id ||
    operation.receiptId ||
    operation.externalIdentity ||
    !operation.budgetReservationId ||
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
    throw new Error("Only an expired, unacknowledged, reviewed MD effect can be abandoned");
  const authority = deps.site.resolvePublication({
    subject: review.ownerUserId,
    projectId: input.projectId,
  });
  const delivery = await deps.effects.readMdSubmissionDelivery(
    operation.id,
    authority.grant.principal,
  );
  if (!delivery) throw new Error("Exact immutable delivery is required");
  assertNoSubmitReview(review, input, {
    ownerUserId: deps.actor.id,
    uid: authority.grant.principal.uid,
    epoch: authority.grant.recoveryEpoch,
    deliveryExpiresAt: delivery.expiresAt,
    now,
  });
  const proof = await deps.artifacts.get(review.proofDigest);
  if (!proof.bytes.length) throw new Error("Operator proof artifact missing");
  const evidenceId = "evidence-md-no-submit-review-" + input.reviewDigest;
  const saved = await deps.artifacts.put(Buffer.from(canonicalJson(review)));
  await deps.store.createEvidence(
    EvidenceReferenceSchema.parse({
      id: evidenceId,
      missionId: input.missionId,
      workUnitId: work.id,
      kind: "human_review",
      uri: saved.uri,
      contentDigest: saved.digest,
      sizeBytes: saved.sizeBytes,
      mediaType: "application/json",
      immutable: true,
      sourceId: operation.id,
      createdAt: review.reviewedAt,
    }),
  );
  await deps.store.createDecision(
    ScientificDecisionSchema.parse({
      id: "decision-md-no-submit-" + input.reviewDigest,
      missionId: input.missionId,
      planId: work.planId,
      category: "operational",
      question: "Did this exact expired delivery reach a durable submitter claim?",
      selectedOption: "abandon_never_submitted_delivery_after_root_journal_review",
      alternatives: [
        {
          option: "replay_original_delivery",
          reasonNotSelected:
            "Forbidden: original delivery remains immutable and is never replayed.",
        },
      ],
      rationale: canonicalJson({
        reviewDigest: input.reviewDigest,
        proofDigest: review.proofDigest,
        receiptCreated: false,
        scientificPass: false,
        newPlanApprovalRequired: true,
      }),
      skillRefs: [],
      evidenceRefs: [evidenceId],
      confidence: {
        level: "high",
        basis:
          "Root-reviewed empty transport journal, expired delivery and rotated protected epoch; not inferred from RPC rejection or scheduler absence.",
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
    throw new Error("Site authority changed during reconciliation");
  let mission = (await deps.store.getMission(input.missionId))!;
  if (mission.state === "executing")
    mission = await deps.store.transitionMission({
      missionId: mission.id,
      expectedRevision: mission.revision,
      to: "paused",
      reason: "reviewed_never_submitted_delivery:" + input.reviewDigest,
      actor: deps.actor,
      at: now,
    });
  if (operation.state !== "abandoned")
    await deps.store.transitionExternalOperation({
      operationId: operation.id,
      expectedRevision: operation.revision,
      to: "abandoned",
      at: now,
    });
  const budget = await deps.store.getMissionBudget(input.missionId);
  if (budget.reservations.find((r) => r.id === operation.budgetReservationId)?.state !== "released")
    await deps.store.settleBudgetReservation({
      missionId: input.missionId,
      reservationId: operation.budgetReservationId,
      expectedBudgetRevision: budget.revision,
      state: "released",
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
      reason: "new_exact_plan_required_after_no_submit_review",
      actor: deps.actor,
      at: now,
    });
  return {
    missionId: mission.id,
    operationId: operation.id,
    state: "abandoned",
    missionState: mission.state,
    reviewDigest: input.reviewDigest,
    receiptCreated: false,
    resubmitAllowed: false,
    newPlanApprovalRequired: true,
  };
}
