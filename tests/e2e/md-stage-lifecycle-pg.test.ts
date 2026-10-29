import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgresDatabase } from "@eigengrid/db";
import {
  ContentAddressedArtifactStore,
  MdResultCollectionStore,
  MdStageLifecycleStore,
  type MdResultCollection,
  type MdPostprocessingLease,
} from "@eigengrid/mission-runtime";
import { canonicalJson, computeMdStageResultDigest } from "@eigengrid/scientific-schema";
import { canRunPostgres, startEphemeralPostgres } from "../ts/helpers/postgres";
import { MD_FIXTURE_NOW, seedCanonicalMdAuthority } from "./helpers/canonical-md-authority";
import { finalizationFixture } from "./helpers/md-finalization-fixture";
import { consumeCanonicalMdFixtureDelivery } from "./helpers/canonical-md-delivery";

/** Real PostgreSQL concurrency, synthetic engine evidence: never AMBER/site qualification. */
describe.skipIf(!canRunPostgres)("mission runtime terminal MD lease and crash recovery", () => {
  let cluster: Awaited<ReturnType<typeof startEphemeralPostgres>>;
  let database: PostgresDatabase, cas: ContentAddressedArtifactStore, directory: string;
  let seeded: Awaited<ReturnType<typeof seedCanonicalMdAuthority>>;
  let lifecycle: MdStageLifecycleStore, collections: MdResultCollectionStore;
  const names = [
    "adopted",
    "uncollected",
    "failed",
    "rollback",
    "finalize",
    "finalize-rollback",
    "revoked",
  ] as const;
  const operations = new Map<string, string>();
  const inventories = new Map<string, MdResultCollection>();
  const deliveries = new Map<
    string,
    Awaited<ReturnType<typeof consumeCanonicalMdFixtureDelivery>>
  >();
  const now = "2026-08-23T00:07:00.000Z",
    expiry = "2026-08-23T00:09:00.000Z";
  let won: MdPostprocessingLease;
  beforeAll(async () => {
    cluster = await startEphemeralPostgres();
    database = new PostgresDatabase(cluster.url);
    await database.init();
    directory = mkdtempSync(join(tmpdir(), "eigengrid-md-lifecycle-"));
    cas = new ContentAddressedArtifactStore(directory);
    await cas.init();
    seeded = await seedCanonicalMdAuthority(
      database,
      cas,
      names.map((n) => `work-unit-md-${n}`),
      { workUnitLeaseExpiresAt: "2026-08-23T00:06:00.000Z" },
    );
    lifecycle = new MdStageLifecycleStore(database, cas);
    collections = new MdResultCollectionStore(database, cas);
    for (const [index, name] of names.entries()) {
      const delivery = await consumeCanonicalMdFixtureDelivery(
        database,
        cas,
        seeded,
        seeded.workUnits[index]!,
      );
      operations.set(name, delivery.operation.id);
      deliveries.set(name, delivery);
      if (name === "uncollected") continue;
      const artifacts: MdResultCollection["artifacts"] = [];
      for (const role of [
        "publication",
        "accounting",
        "worker_receipt",
        "output_stage_mdout",
        "output_stage_mdinfo",
        "output_stage_restart",
        "output_stage_trajectory",
      ]) {
        const stored = await cas.put(
          Buffer.from(canonicalJson({ testOnly: true, role, operationId: delivery.operation.id })),
        );
        const output = seeded.stage.outputs.find((o) => `output_stage_${o.role}` === role);
        artifacts.push({
          role,
          kind:
            role === "worker_receipt"
              ? "operation_receipt"
              : output
                ? (output.role as "mdout" | "mdinfo" | "restart" | "trajectory")
                : "artifact",
          sha256: stored.digest,
          sizeBytes: stored.sizeBytes,
          mediaType: output?.mediaType ?? "application/json",
        });
      }
      const inventory: MdResultCollection = {
        schemaVersion: "eigengrid.md-result-collection/v1",
        operationId: delivery.operation.id,
        deliveryDigest: delivery.delivery.deliveryDigest,
        bindingDigest: delivery.delivery.bindingDigest,
        publicationDigest: artifacts[0]!.sha256,
        accountingDigest: artifacts[1]!.sha256,
        workerReceiptDigest: artifacts[2]!.sha256,
        slurmJobId: "9001",
        slurmCluster: delivery.profile.transport.cluster,
        submittedAt: MD_FIXTURE_NOW,
        uid: 2101,
        outcome: name === "failed" ? "failed" : "completed",
        artifacts,
        artifactStatus: "complete",
        durability: "pending_replication",
        scientificVerdict: "not_evaluated",
        collectedAt: MD_FIXTURE_NOW,
      };
      inventories.set(name, inventory);
      await collections.adopt(inventory);
    }
  }, 30_000);
  afterAll(async () => {
    await cas?.close();
    await database?.close();
    await cluster?.cleanup();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  test("a confirmed but unprocessed MD receipt is rediscovered after a Head restart", async () => {
    const scan = await seeded.store.listOperationsForReconciliation("mission-md-1");
    expect(scan.some((o) => o.id === operations.get("adopted") && o.state === "confirmed")).toBe(
      true,
    );
    expect(
      scan.some((o) => o.id === operations.get("uncollected") && o.state === "acknowledged"),
    ).toBe(true);
    expect(scan.some((o) => o.id === operations.get("failed"))).toBe(false);
  });
  test("an active engine lease is not stolen even after terminal collection", async () => {
    expect(
      await lifecycle.acquire({
        operationId: operations.get("adopted")!,
        ownerId: "head-analysis-1",
        now: MD_FIXTURE_NOW,
        expiresAt: "2026-08-23T00:06:00.000Z",
      }),
    ).toMatchObject({ acquired: false, reason: "lease_active" });
  });
  test("two Heads racing after expiration acquire exactly one postprocessing claim, never resubmit", async () => {
    const operationId = operations.get("adopted")!;
    const before = await seeded.store.getExternalOperation(operationId);
    const workBefore = await seeded.store.getWorkUnit("work-unit-md-adopted");
    const claims = await Promise.all(
      ["head-analysis-1", "head-analysis-2"].map((ownerId) =>
        lifecycle.acquire({ operationId, ownerId, now, expiresAt: expiry }),
      ),
    );
    expect(claims.filter((c) => c.acquired)).toHaveLength(1);
    const winner = claims.find((c) => c.acquired)!;
    if (!winner.acquired) throw new Error("missing winner");
    won = winner.lease;
    expect(winner.workUnit.state).toBe("observing");
    expect(winner.workUnit.jobId).toBe(workBefore!.jobId);
    expect(winner.workUnit.attemptId).toBe(workBefore!.attemptId);
    expect(await seeded.store.getExternalOperation(operationId)).toEqual(before);
  });
  test("old/wrong claim tokens and expired heartbeats cannot mutate the winner", async () => {
    await expect(
      lifecycle.release({ ...won, claimId: "wrong-claim" }, "2026-08-23T00:08:00.000Z"),
    ).rejects.toThrow(/Stale/);
    await expect(
      lifecycle.renew(
        { ...won, ownerId: "stranger" },
        "2026-08-23T00:08:00.000Z",
        "2026-08-23T00:10:00.000Z",
      ),
    ).rejects.toThrow(/Stale/);
    await lifecycle.renew(won, "2026-08-23T00:08:00.000Z", "2026-08-23T00:10:00.000Z");
    await expect(
      lifecycle.renew(won, "2026-08-23T00:11:00.000Z", "2026-08-23T00:12:00.000Z"),
    ).rejects.toThrow(/Stale/);
  });
  test("an expired analyzer can be recovered; the old token stays fenced even with the same owner", async () => {
    const next = await lifecycle.acquire({
      operationId: won.operationId,
      ownerId: won.ownerId,
      now: "2026-08-23T00:11:00.000Z",
      expiresAt: "2026-08-23T00:13:00.000Z",
    });
    expect(next.acquired).toBe(true);
    if (!next.acquired) throw new Error("missing claim");
    expect(next.lease.claimId).not.toBe(won.claimId);
    await expect(lifecycle.release(won, "2026-08-23T00:11:30.000Z")).rejects.toThrow(/Stale/);
    await lifecycle.release(next.lease, "2026-08-23T00:11:30.000Z");
    expect(await seeded.store.getWorkUnit(won.workUnitId)).toMatchObject({
      state: "observing",
      claimOwner: null,
      claimExpiresAt: null,
    });
    expect((await seeded.store.getExternalOperation(won.operationId))!.state).toBe("confirmed");
  });
  test("uncollected, failed and unconsumed effects never acquire an analysis lease", async () => {
    for (const name of ["uncollected", "failed"])
      await expect(
        lifecycle.acquire({
          operationId: operations.get(name)!,
          ownerId: "head",
          now,
          expiresAt: expiry,
        }),
      ).rejects.toThrow(/complete adopted terminal/);
    await expect(
      lifecycle.acquire({ operationId: "absent", ownerId: "head", now, expiresAt: expiry }),
    ).rejects.toThrow();
    await expect(
      lifecycle.acquire({
        operationId: operations.get("adopted")!,
        ownerId: "head",
        now,
        expiresAt: "2026-08-25T00:00:00.000Z",
      }),
    ).rejects.toThrow(/ten minutes/);
  });
  test("claim-write failure rolls both canonical WorkUnit and active lease back", async () => {
    const operationId = operations.get("rollback")!,
      before = await seeded.store.getWorkUnit("work-unit-md-rollback");
    await database.query(
      `CREATE FUNCTION test_only_md_claim_crash() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id LIKE 'claim-md-postprocess-%' THEN RAISE EXCEPTION 'MD injected crash'; END IF; RETURN NEW; END $$`,
    );
    await database.query(
      `CREATE TRIGGER test_only_md_claim BEFORE INSERT ON scientific_work_unit_claims FOR EACH ROW EXECUTE FUNCTION test_only_md_claim_crash()`,
    );
    try {
      await expect(
        lifecycle.acquire({ operationId, ownerId: "head", now, expiresAt: expiry }),
      ).rejects.toThrow("MD injected crash");
    } finally {
      await database.query("DROP TRIGGER test_only_md_claim ON scientific_work_unit_claims");
      await database.query("DROP FUNCTION test_only_md_claim_crash()");
    }
    expect(await seeded.store.getWorkUnit("work-unit-md-rollback")).toEqual(before);
    expect(
      (await lifecycle.acquire({ operationId, ownerId: "head", now, expiresAt: expiry })).acquired,
    ).toBe(true);
  });
  async function finalization(name: string) {
    const delivery = deliveries.get(name)!;
    const claim = await lifecycle.acquire({
      operationId: delivery.operation.id,
      ownerId: "head-finalizer",
      now,
      expiresAt: expiry,
    });
    if (!claim.acquired) throw new Error("Expected finalization lease");
    return finalizationFixture({
      cas,
      collection: inventories.get(name)!,
      stage: seeded.stage,
      protocol: seeded.protocol,
      lease: claim.lease,
      engine: delivery.bundle.manifest.mapping.environment.canonicalSnapshot.engine,
      now,
    });
  }
  const finalContext = { now, currentPolicyDigest: "f".repeat(64) };
  test("result, validation, analysis receipt and assessment commit atomically and replay exactly", async () => {
    const input = await finalization("finalize");
    const finalized = await lifecycle.finalize(input, finalContext);
    expect(finalized.created).toBe(true);
    expect(finalized.record).toMatchObject({
      status: "accepted",
      durability: "pending_replication",
    });
    expect((await seeded.mdStore.getStageResult(input.result.id))!.resultDigest).toBe(
      input.result.resultDigest,
    );
    expect((await seeded.mdStore.getAssessment(input.assessment.id, 1))!.assessmentDigest).toBe(
      input.assessment.assessmentDigest,
    );
    expect(await lifecycle.get(input.lease.operationId)).toEqual(finalized.record);
    expect(
      (await lifecycle.finalize(input, { ...finalContext, now: "2026-08-23T00:07:30.000Z" }))
        .created,
    ).toBe(false);
    // Replaying with changed immutable content is rejected, not promoted as a second result.
    const changed = {
      ...input.result,
      warnings: [
        {
          code: "changed",
          severity: "warning" as const,
          message: "tampered result",
          sourceEvidenceRefs: [],
        },
      ],
    };
    changed.resultDigest = computeMdStageResultDigest(changed);
    await expect(lifecycle.finalize({ ...input, result: changed }, finalContext)).rejects.toThrow();
    expect((await seeded.store.getWorkUnit(input.result.workUnitId))!.state).toBe("observing");
  });
  test("failure after StageResult insertion rolls all new analysis records back; retry is safe", async () => {
    const input = await finalization("finalize-rollback");
    await database.query(
      `CREATE FUNCTION test_only_md_finalize_crash() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'MD injected assessment crash'; END $$`,
    );
    await database.query(
      `CREATE TRIGGER test_only_md_finalize BEFORE INSERT ON scientific_md_assessments FOR EACH ROW EXECUTE FUNCTION test_only_md_finalize_crash()`,
    );
    try {
      await expect(lifecycle.finalize(input, finalContext)).rejects.toThrow();
    } finally {
      await database.query("DROP TRIGGER test_only_md_finalize ON scientific_md_assessments");
      await database.query("DROP FUNCTION test_only_md_finalize_crash()");
    }
    expect(await seeded.mdStore.getStageResult(input.result.id)).toBeNull();
    expect(await lifecycle.get(input.lease.operationId)).toBeNull();
    expect(
      (await seeded.store.getMissionProvenance(input.result.missionId)).operations.filter(
        (o) => o.workUnitId === input.result.workUnitId && o.kind === "trajectory_analysis",
      ),
    ).toHaveLength(0);
    expect((await lifecycle.finalize(input, finalContext)).created).toBe(true);
  });
  test("membership revocation and policy change during inspection forbid finalization", async () => {
    const input = await finalization("revoked");
    await expect(
      lifecycle.finalize(input, { ...finalContext, currentPolicyDigest: "a".repeat(64) }),
    ).rejects.toThrow(/current active mission, plan and policy/);
    await database.query("UPDATE users SET status='disabled' WHERE id='scientist-1'");
    try {
      await expect(lifecycle.finalize(input, finalContext)).rejects.toThrow(/membership/);
    } finally {
      await database.query("UPDATE users SET status='active' WHERE id='scientist-1'");
    }
    expect(await seeded.mdStore.getStageResult(input.result.id)).toBeNull();
    expect((await lifecycle.finalize(input, finalContext)).created).toBe(true);
  });
});
