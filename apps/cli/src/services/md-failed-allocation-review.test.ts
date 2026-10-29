import { test, expect } from "bun:test";
import { digestCanonical } from "@eigengrid/scientific-schema";
import {
  MdFailedAllocationReviewSchema,
  MdFailedAllocationRequestSchema,
  reconcileFailedAllocation,
} from "./md-failed-allocation-review";
const review = MdFailedAllocationReviewSchema.parse({
  schemaVersion: "eigengrid.md-failed-allocation-review/v1",
  projectId: "p",
  missionId: "m",
  operationId: "o",
  workUnitId: "w",
  requestDigest: "a".repeat(64),
  ownerUserId: "u",
  scientificUid: 2301,
  slurmJobId: "64",
  recoveryEpoch: "new",
  reason: "worker_scratch_root_absent_before_engine",
  workerScratchRootAbsent: true,
  workerFailureLogDigest: "b".repeat(64),
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
test("failed allocation review cannot be supplied by caller or substituted for a live/successful engine", async () => {
  expect(() => MdFailedAllocationRequestSchema.parse({ ...request, review })).toThrow();
  expect(() =>
    MdFailedAllocationReviewSchema.parse({ ...review, workerScratchRootAbsent: false }),
  ).toThrow();
  expect(() =>
    MdFailedAllocationReviewSchema.parse({ ...review, reason: "ignore_scientific_qc" }),
  ).toThrow();
  let accessed = false;
  const deps = {
    access: async () => {
      accessed = true;
    },
    roles: ["scientific_reviewer"],
    reviews: [],
  } as unknown as Parameters<typeof reconcileFailedAllocation>[1];
  await expect(reconcileFailedAllocation(request, deps)).rejects.toThrow("root-provisioned");
  expect(accessed).toBe(true);
  await expect(reconcileFailedAllocation(request, { ...deps, roles: [] })).rejects.toThrow(
    "reviewer",
  );
  await expect(
    reconcileFailedAllocation(request, {
      ...deps,
      access: async () => {
        throw new Error("revoked");
      },
    }),
  ).rejects.toThrow("revoked");
});
for (const reason of [
  "worker_scratch_root_absent_before_engine",
  "worker_failed_before_workspace_after_input_preflight",
] as const)
  test("real PostgreSQL review retires a real-shaped failed allocation without inventing an engine receipt", async () => {
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
        to: "acknowledged",
        externalIdentity: { slurmJobId: "64", slurmCluster: "test-cluster" },
        at: MD_FIXTURE_NOW,
      });
      const phases = [
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
      const preflight = await artifacts.put(
        Buffer.from(
          phases
            .map((phase) => JSON.stringify({ phase, passed: true }))
            .concat(JSON.stringify({ passed: true, engineExecuted: false }))
            .join("\n"),
        ),
      );
      const proof = await artifacts.put(
        Buffer.from(
          JSON.stringify({
            operationId: op.id,
            slurmJobId: "64",
            workerScratchRootAbsent: reason === "worker_scratch_root_absent_before_engine",
            workerWorkspaceAbsent: true,
            readOnlyPreflightDigest: preflight.digest,
            workerFailureLogDigest: review.workerFailureLogDigest,
          }),
        ),
      );
      const now = Date.now();
      const common = Object.fromEntries(
        Object.entries(review).filter(
          ([key]) => !["reason", "workerScratchRootAbsent"].includes(key),
        ),
      );
      const r = MdFailedAllocationReviewSchema.parse({
        ...common,
        ...(reason === "worker_scratch_root_absent_before_engine"
          ? { reason, workerScratchRootAbsent: true }
          : { reason, workerWorkspaceAbsent: true, readOnlyPreflightDigest: preflight.digest }),
        projectId: MD_FIXTURE_PROJECT,
        missionId: mission.id,
        operationId: op.id,
        workUnitId: work.id,
        ownerUserId: mission.requestedBy.id,
        requestDigest: op.requestDigest,
        proofDigest: proof.digest,
        reviewedAt: new Date(now - 1000).toISOString(),
        expiresAt: new Date(now + 3600000).toISOString(),
      });
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
        effects: {
          readMdSubmissionDelivery: async () => ({
            requestDigest: op.requestDigest,
            expiresAt: MD_FIXTURE_NOW,
          }),
        },
        site: {
          resolvePublication: () => ({ grant: { principal: { uid: 2301 }, recoveryEpoch: "new" } }),
        },
        accounting: async () => ({
          observation: { status: "matched", identity: { jobId: "64", uid: 2301 } },
          accounting: {
            state: "FAILED",
            exitCode: 74,
            signal: 0,
            slurmJobId: "64",
            uid: 2301,
            cluster: "test-cluster",
          },
        }),
      } as unknown as Parameters<typeof reconcileFailedAllocation>[1];
      for (const change of [
        { state: "COMPLETED" },
        { state: "UNKNOWN" },
        { exitCode: 0 },
        { signal: 9 },
        { slurmJobId: "65" },
        { uid: 2302 },
        { cluster: "wrong-cluster" },
      ]) {
        const result = await deps.accounting({} as never);
        await expect(
          reconcileFailedAllocation(req, {
            ...deps,
            accounting: async () => ({
              ...result,
              accounting: { ...result.accounting, ...change } as typeof result.accounting,
            }),
          }),
        ).rejects.toThrow("Authenticated accounting");
        expect((await store.getExternalOperation(op.id))?.state).toBe("acknowledged");
      }
      expect((await reconcileFailedAllocation(req, deps)).resubmitAllowed).toBe(false);
      expect((await reconcileFailedAllocation(req, deps)).missionState).toBe("replanning");
      const after = await store.getMissionProvenance(mission.id);
      expect(after.operations.find((o) => o.id === op.id)?.state).toBe("abandoned");
      expect(after.workUnits.find((w) => w.id === work.id)?.state).toBe("cancelled");
      expect(after.receipts).toHaveLength(before.receipts.length);
      expect(after.budgetReservations.find((r) => r.id === reservationId)?.state).toBe("consumed");
    } finally {
      await artifacts.close();
      await database.close();
      await cluster.cleanup();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);
