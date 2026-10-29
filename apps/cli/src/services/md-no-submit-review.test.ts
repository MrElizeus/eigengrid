import { test, expect } from "bun:test";
import { digestCanonical } from "@eigengrid/scientific-schema";
import {
  MdNoSubmitReviewSchema,
  MdNoSubmitRequestSchema,
  assertNoSubmitReview,
  reconcileReviewedNoSubmit,
} from "./md-no-submit-review";
const review = MdNoSubmitReviewSchema.parse({
  schemaVersion: "eigengrid.md-no-submit-operator-review/v1",
  projectId: "p",
  missionId: "m",
  operationId: "o",
  workUnitId: "w",
  requestDigest: "a".repeat(64),
  ownerUserId: "u",
  scientificUid: 2301,
  journalId: "j",
  journalSha256: "b".repeat(64),
  claimCount: 0,
  receiptCount: 0,
  previousRecoveryEpoch: "old",
  newRecoveryEpoch: "new",
  reason: "gateway_never_initialized_no_transport_claim",
  reviewedAt: "2026-10-04T06:00:00.000Z",
  expiresAt: "2026-10-04T07:00:00.000Z",
  proofDigest: "c".repeat(64),
});
const request = {
  projectId: "p",
  missionId: "m",
  operationId: "o",
  requestDigest: review.requestDigest,
  reviewDigest: digestCanonical(review),
};
const live = {
  ownerUserId: "u",
  uid: 2301,
  epoch: "new",
  deliveryExpiresAt: "2026-10-04T05:00:00.000Z",
  now: "2026-10-04T06:01:00.000Z",
};
test("root review must bind exact mission/effect and an expired delivery under a new epoch", () => {
  expect(() => assertNoSubmitReview(review, request, live)).not.toThrow();
  for (const change of [
    { ownerUserId: "other" },
    { uid: 2302 },
    { epoch: "old" },
    { deliveryExpiresAt: live.now },
    { now: "2026-10-04T08:00:00.000Z" },
    { now: "2026-10-04T05:00:00.000Z" },
  ])
    expect(() => assertNoSubmitReview(review, request, { ...live, ...change })).toThrow();
  for (const change of [
    { missionId: "other" },
    { projectId: "other" },
    { operationId: "other" },
    { requestDigest: "f".repeat(64) },
    { reviewDigest: "f".repeat(64) },
  ])
    expect(() => assertNoSubmitReview(review, { ...request, ...change }, live)).toThrow();
  for (const change of [{ claimCount: 1 }, { receiptCount: 1 }, { reason: "scheduler_is_empty" }])
    expect(() => MdNoSubmitReviewSchema.parse({ ...review, ...change })).toThrow();
  expect(() => MdNoSubmitRequestSchema.parse({ ...request, review })).toThrow();
});
test("root review cannot be supplied by the caller or read before access is checked", async () => {
  let accessed = false;
  const deps = {
    access: async () => {
      accessed = true;
    },
    roles: ["scientific_reviewer"],
    reviews: [],
  } as unknown as Parameters<typeof reconcileReviewedNoSubmit>[1];
  await expect(reconcileReviewedNoSubmit(request, deps)).rejects.toThrow("root-provisioned");
  expect(accessed).toBe(true);
  await expect(reconcileReviewedNoSubmit({ ...request, review }, deps)).rejects.toThrow();
  await expect(reconcileReviewedNoSubmit(request, { ...deps, roles: [] })).rejects.toThrow(
    "reviewer",
  );
  await expect(
    reconcileReviewedNoSubmit(request, {
      ...deps,
      access: async () => {
        throw new Error("revoked");
      },
    }),
  ).rejects.toThrow("revoked");
});

test("real PostgreSQL reconciliation abandons only reviewed unsubmitted work and creates no receipt", async () => {
  const { PostgresDatabase } = await import("@eigengrid/db");
  const { ContentAddressedArtifactStore } = await import("@eigengrid/mission-runtime");
  const { startEphemeralPostgres } = await import("../../../../tests/ts/helpers/postgres");
  const { seedCanonicalMdAuthority, MD_FIXTURE_NOW, MD_FIXTURE_POLICY, MD_FIXTURE_PROJECT } =
    await import("../../../../tests/e2e/helpers/canonical-md-authority");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const cluster = await startEphemeralPostgres(),
    database = new PostgresDatabase(cluster.url),
    dir = await mkdtemp(tmpdir() + "/md-review-"),
    artifacts = new ContentAddressedArtifactStore(dir);
  try {
    await database.init();
    await artifacts.init();
    const seeded = await seedCanonicalMdAuthority(database, artifacts, ["never-submitted"]);
    const store = seeded.store,
      work = seeded.workUnits[0]!;
    let mission = (await store.getMission(work.missionId))!;
    mission = await store.transitionMission({
      missionId: mission.id,
      expectedRevision: mission.revision,
      to: "executing",
      reason: "Synthetic pre-effect reconciliation test",
      actor: mission.requestedBy,
      at: MD_FIXTURE_NOW,
    });
    const budget = await store.getMissionBudget(mission.id),
      opId = "op-never-submitted",
      reservationId = "reservation-never-submitted";
    await store.reserveBudget({
      missionId: mission.id,
      expectedBudgetRevision: budget.revision,
      reservation: {
        id: reservationId,
        kind: "external_operation",
        amount: 1,
        state: "reserved",
        workUnitId: work.id,
        operationId: opId,
        createdAt: MD_FIXTURE_NOW,
        updatedAt: MD_FIXTURE_NOW,
      },
    });
    const payload = { fixture: "No real backend or engine is invoked" };
    let op = await store.createOperationIntent(
      {
        id: opId,
        missionId: mission.id,
        workUnitId: work.id,
        idempotencyKey: opId,
        kind: "md_stage_execution",
        state: "intent",
        request: payload,
        requestDigest: digestCanonical(payload),
        policyDigest: MD_FIXTURE_POLICY,
        budgetReservationId: reservationId,
        revision: 1,
        createdAt: MD_FIXTURE_NOW,
        updatedAt: MD_FIXTURE_NOW,
      },
      { claimOwner: work.claimOwner!, now: MD_FIXTURE_NOW },
    );
    op = await store.transitionExternalOperation({
      operationId: op.id,
      expectedRevision: op.revision,
      to: "effect_started",
      at: MD_FIXTURE_NOW,
    });
    op = await store.transitionExternalOperation({
      operationId: op.id,
      expectedRevision: op.revision,
      to: "ambiguous",
      at: MD_FIXTURE_NOW,
    });
    const proof = await artifacts.put(Buffer.from("synthetic root review proof"));
    const now = Date.now(),
      r = {
        ...review,
        projectId: MD_FIXTURE_PROJECT,
        missionId: mission.id,
        operationId: op.id,
        workUnitId: work.id,
        ownerUserId: mission.requestedBy.id,
        requestDigest: op.requestDigest,
        proofDigest: proof.digest,
        reviewedAt: new Date(now - 1000).toISOString(),
        expiresAt: new Date(now + 3600000).toISOString(),
      };
    const req = {
      projectId: r.projectId,
      missionId: r.missionId,
      operationId: r.operationId,
      requestDigest: r.requestDigest,
      reviewDigest: digestCanonical(r),
    };
    const before = await store.getMissionProvenance(mission.id);
    const deps = {
      store,
      artifacts,
      reviews: [r],
      actor: mission.requestedBy,
      roles: ["scientific_reviewer"],
      access: async () => {},
      effects: { readMdSubmissionDelivery: async () => ({ expiresAt: MD_FIXTURE_NOW }) },
      site: {
        resolvePublication: () => ({ grant: { principal: { uid: 2301 }, recoveryEpoch: "new" } }),
      },
    } as unknown as Parameters<typeof reconcileReviewedNoSubmit>[1];
    expect((await reconcileReviewedNoSubmit(req, deps)).resubmitAllowed).toBe(false);
    expect((await reconcileReviewedNoSubmit(req, deps)).missionState).toBe("replanning");
    const after = await store.getMissionProvenance(mission.id);
    expect(after.operations.find((o) => o.id === op.id)?.state).toBe("abandoned");
    expect(after.workUnits.find((w) => w.id === work.id)?.state).toBe("cancelled");
    expect(after.receipts).toHaveLength(before.receipts.length);
    expect(after.budgetReservations.find((r) => r.id === reservationId)?.state).toBe("released");
  } finally {
    await artifacts.close();
    await database.close();
    await cluster.cleanup();
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
