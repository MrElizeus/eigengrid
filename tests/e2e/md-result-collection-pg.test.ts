import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgresDatabase } from "@eigengrid/db";
import {
  ContentAddressedArtifactStore,
  MdResultCollectionStore,
  type MdResultCollection,
} from "@eigengrid/mission-runtime";
import { canonicalJson } from "@eigengrid/scientific-schema";
import { canRunPostgres, startEphemeralPostgres } from "../ts/helpers/postgres";
import { MD_FIXTURE_NOW, seedCanonicalMdAuthority } from "./helpers/canonical-md-authority";
import { consumeCanonicalMdFixtureDelivery } from "./helpers/canonical-md-delivery";

/** PostgreSQL adoption tests; raw bytes are synthetic storage fixtures, never
 * terminal scheduler proof, executable molecular inputs or scientific QC. */
describe.skipIf(!canRunPostgres)("MD result collection atomic PostgreSQL boundary", () => {
  let cluster: Awaited<ReturnType<typeof startEphemeralPostgres>>;
  let database: PostgresDatabase;
  let cas: ContentAddressedArtifactStore;
  let directory: string;
  let seeded: Awaited<ReturnType<typeof seedCanonicalMdAuthority>>;
  let collections: MdResultCollectionStore;
  const names = ["completed", "failed", "cancelled", "rollback", "missing", "identity"] as const;
  const deliveries = new Map<
    string,
    Awaited<ReturnType<typeof consumeCanonicalMdFixtureDelivery>>
  >();
  const inventories = new Map<string, MdResultCollection>();
  beforeAll(async () => {
    cluster = await startEphemeralPostgres();
    database = new PostgresDatabase(cluster.url);
    await database.init();
    directory = mkdtempSync(join(tmpdir(), "eigengrid-md-collection-"));
    cas = new ContentAddressedArtifactStore(directory);
    await cas.init();
    seeded = await seedCanonicalMdAuthority(
      database,
      cas,
      names.map((name) => `work-unit-collection-${name}`),
    );
    collections = new MdResultCollectionStore(database, cas);
    for (const [index, name] of names.entries()) {
      const admitted = await consumeCanonicalMdFixtureDelivery(
        database,
        cas,
        seeded,
        seeded.workUnits[index]!,
      );
      deliveries.set(name, admitted);
      const artifacts: MdResultCollection["artifacts"] = [];
      for (const role of ["publication", "accounting", "worker_receipt", "output_mdout"]) {
        const value = await cas.put(
          Buffer.from(
            canonicalJson({
              testOnlyRawCollection: true,
              operationId: admitted.operation.id,
              role,
            }),
          ),
        );
        artifacts.push({
          role,
          kind:
            role === "worker_receipt"
              ? "operation_receipt"
              : role === "output_mdout"
                ? "mdout"
                : "artifact",
          sha256: value.digest,
          sizeBytes: value.sizeBytes,
          mediaType: "application/json",
        });
      }
      inventories.set(name, {
        schemaVersion: "eigengrid.md-result-collection/v1",
        operationId: admitted.operation.id,
        deliveryDigest: admitted.delivery.deliveryDigest,
        bindingDigest: admitted.delivery.bindingDigest,
        publicationDigest: artifacts[0]!.sha256,
        accountingDigest: artifacts[1]!.sha256,
        workerReceiptDigest: artifacts[2]!.sha256,
        slurmJobId: "9001",
        slurmCluster: admitted.profile.transport.cluster,
        submittedAt: MD_FIXTURE_NOW,
        uid: 2101,
        outcome: name === "failed" ? "failed" : name === "cancelled" ? "cancelled" : "completed",
        artifacts,
        artifactStatus: "complete",
        durability: "pending_replication",
        scientificVerdict: "not_evaluated",
        collectedAt: MD_FIXTURE_NOW,
      });
    }
  }, 30_000);
  afterAll(async () => {
    await cas?.close();
    await database?.close();
    await cluster?.cleanup();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });
  const inventory = (name: string) => structuredClone(inventories.get(name)!);
  async function snapshot(name: string) {
    const admitted = deliveries.get(name)!;
    const provenance = await seeded.store.getMissionProvenance(admitted.operation.missionId);
    const operation = await seeded.store.getExternalOperation(admitted.operation.id);
    const workUnit = await seeded.store.getWorkUnit(admitted.operation.workUnitId);
    const budget = await seeded.store.getMissionBudget(admitted.operation.missionId);
    return {
      operation,
      workUnit,
      reservation: budget.reservations.find((item) => item.operationId === admitted.operation.id),
      receipts: provenance.receipts.filter((item) => item.operationId === admitted.operation.id),
      evidence: provenance.evidence.filter(
        (item) => item.workUnitId === admitted.operation.workUnitId,
      ),
      observations: provenance.observations.filter(
        (item) => item.workUnitId === admitted.operation.workUnitId,
      ),
    };
  }
  test("concurrent adoption commits one receipt/inventory, work unit and budget; remains unqualified", async () => {
    const value = inventory("completed");
    const results = await Promise.all([
      collections.adopt(value),
      collections.adopt({ ...value, collectedAt: "2026-08-23T00:06:00.000Z" }),
    ]);
    expect(results.map((result) => result.created).sort()).toEqual([false, true]);
    expect(results.every((result) => result.canonicalAcknowledged === false)).toBe(true);
    const durable = await collections.get(value.operationId);
    expect(durable).toMatchObject({
      scientificVerdict: "not_evaluated",
      durability: "pending_replication",
    });
    const state = await snapshot("completed");
    expect(state.operation).toMatchObject({ state: "confirmed", receiptId: state.receipts[0]!.id });
    expect(state.workUnit).toMatchObject({ state: "observing" });
    expect(state.reservation).toMatchObject({ state: "consumed" });
    expect(state.receipts).toHaveLength(1);
    expect(state.evidence).toHaveLength(4);
    expect(state.observations).toHaveLength(1);
    expect(state.observations[0]).toMatchObject({
      type: "artifact_integrity",
      qualityFlags: ["scientific_not_evaluated", "pending_replication"],
    });
    expect((await collections.adopt(value)).created).toBe(false);
    expect(await snapshot("completed")).toEqual(state);
  });
  test("an adopted inventory cannot be replaced by a later conflicting result", async () => {
    const previous = await snapshot("completed");
    await expect(
      collections.adopt({ ...inventory("completed"), outcome: "failed" }),
    ).rejects.toThrow(/cannot be replaced/);
    expect(await snapshot("completed")).toEqual(previous);
  });
  for (const name of ["failed", "cancelled"] as const)
    test(`${name} consumes its reservation without scientific acceptance`, async () => {
      await collections.adopt(inventory(name));
      const state = await snapshot(name);
      expect(state.operation?.state).toBe("failed");
      expect(state.receipts[0]?.status).toBe("failed");
      expect(state.reservation?.state).toBe("consumed");
      expect(["failed", "cancelled"]).toContain(state.workUnit?.state);
      expect(state.observations[0]?.payload).toMatchObject({
        outcome: name,
        scientificVerdict: "not_evaluated",
        durability: "pending_replication",
      });
    });
  test("missing CAS bytes leave all metadata, receipt and reservation unchanged", async () => {
    const before = await snapshot("missing");
    const value = inventory("missing");
    value.artifacts[3]!.sha256 = "0".repeat(64);
    await expect(collections.adopt(value)).rejects.toThrow();
    expect(await snapshot("missing")).toEqual(before);
    expect(await collections.get(value.operationId)).toBeNull();
  });
  test("conflicting delivery, scheduler UID or submitted time never adopts raw bytes", async () => {
    const before = await snapshot("identity");
    const value = inventory("identity");
    for (const mutation of [
      { deliveryDigest: "f".repeat(64) },
      { bindingDigest: "e".repeat(64) },
      { uid: 2102 },
      { slurmJobId: "9002" },
      { submittedAt: "2026-08-23T00:05:01.000Z" },
    ])
      await expect(collections.adopt({ ...value, ...mutation })).rejects.toThrow();
    expect(await snapshot("identity")).toEqual(before);
  });
  test("PostgreSQL failure after evidence and receipt writes rolls the entire adoption back", async () => {
    const value = inventory("rollback");
    const before = await snapshot("rollback");
    await database.query(
      `CREATE FUNCTION test_only_fail_md_collection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id LIKE 'md-collection-%' THEN RAISE EXCEPTION 'test-only collection crash after receipt'; END IF; RETURN NEW; END $$`,
    );
    await database.query(
      `CREATE TRIGGER test_only_md_collection_crash BEFORE INSERT ON scientific_observations FOR EACH ROW EXECUTE FUNCTION test_only_fail_md_collection()`,
    );
    try {
      await expect(collections.adopt(value)).rejects.toThrow(
        "Scientific persistence constraint failed during create scientific observation",
      );
    } finally {
      await database.query("DROP TRIGGER test_only_md_collection_crash ON scientific_observations");
      await database.query("DROP FUNCTION test_only_fail_md_collection()");
    }
    expect(await snapshot("rollback")).toEqual(before);
    expect(await collections.get(value.operationId)).toBeNull();
    expect((await collections.adopt(value)).created).toBe(true);
    expect((await snapshot("rollback")).reservation?.state).toBe("consumed");
    expect((await collections.adopt(value)).created).toBe(false);
  });
});
