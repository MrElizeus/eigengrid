import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgresDatabase } from "@eigengrid/db";
import {
  ContentAddressedArtifactStore,
  MdResultCollectionStore,
  MdStageLifecycleStore,
  MdReplicaVerifier,
  replicateMdArtifactManifest,
  mdPostprocessingIds,
  type MdResultCollection,
  type MdReplicaReceipt,
  type MdStageFinalizationInput,
} from "@eigengrid/mission-runtime";
import {
  canonicalJson,
  digestCanonical,
  computeMdEnvironmentCapabilitySnapshotDigest,
} from "@eigengrid/scientific-schema";
import { computeMdCompilerPolicyDigest, type MdCompilerPolicy } from "@eigengrid/protocol-core";
import { reviewedSander26Environment } from "../../packages/amber-adapter/src/canonical-stage.fixture";
import { canRunPostgres, startEphemeralPostgres } from "../ts/helpers/postgres";
import { seedCanonicalMdAuthority } from "./helpers/canonical-md-authority";
import { consumeCanonicalMdFixtureDelivery } from "./helpers/canonical-md-delivery";
import { finalizationFixture } from "./helpers/md-finalization-fixture";

const capability = { id: "amber.production-md", version: "1.0.0", contractDigest: "3".repeat(64) };
const p = {
  id: "md-reviewed-test-policy",
  version: "1.0.0",
  minimumApprovalRole: "scientific_reviewer",
  capabilityByStageKind: {
    minimization: capability,
    heating: capability,
    equilibration: capability,
    production: capability,
  },
  riskByStageKind: { minimization: 3, heating: 3, equilibration: 3, production: 3 },
  retryPolicy: { maximumAttempts: 1, ambiguityRequiresReconciliation: true as const },
};
const policy = { ...p, policyDigest: computeMdCompilerPolicyDigest(p) } as MdCompilerPolicy;
const e = { ...reviewedSander26Environment().canonicalSnapshot, capabilities: [capability] };
const environment = { ...e, environmentDigest: computeMdEnvironmentCapabilitySnapshotDigest(e) };
const NOW = "2026-08-23T00:07:00.000Z";

/** Actual PostgreSQL + two fixture CAS namespaces + real Ed25519 readback signatures.
 * These namespaces are NOT claimed to be physically independent production storage.
 */
describe.skipIf(!canRunPostgres)(
  "mission runtime atomic completion/continuation and replica-before-advance",
  () => {
    let cluster: Awaited<ReturnType<typeof startEphemeralPostgres>>, database: PostgresDatabase;
    let primary: ContentAddressedArtifactStore,
      replica: ContentAddressedArtifactStore,
      root: string;
    let seeded: Awaited<ReturnType<typeof seedCanonicalMdAuthority>>,
      lifecycle: MdStageLifecycleStore;
    const inputs = new Map<string, MdStageFinalizationInput>(),
      receipts = new Map<string, MdReplicaReceipt>();
    const names = ["advance", "rollback", "missing", "revoked", "candidate"];
    const keys = generateKeyPairSync("ed25519"),
      identity = {
        keyId: "replica-fixture-key",
        primaryFailureDomain: "fixture-primary",
        replicaFailureDomain: "fixture-secondary",
        storageProfileDigest: "b".repeat(64),
      };
    beforeAll(async () => {
      cluster = await startEphemeralPostgres();
      database = new PostgresDatabase(cluster.url);
      await database.init();
      root = mkdtempSync(join(tmpdir(), "eigengrid-md-continuation-"));
      primary = new ContentAddressedArtifactStore(join(root, "primary"));
      replica = new ContentAddressedArtifactStore(join(root, "replica"));
      await primary.init();
      await replica.init();
      seeded = await seedCanonicalMdAuthority(
        database,
        primary,
        names.map((n) => `md-${n}`),
        {
          policyDigest: policy.policyDigest,
          environmentDigest: environment.environmentDigest,
          downstreamKind: "equilibration",
          workUnitLeaseExpiresAt: "2026-08-23T00:06:00.000Z",
        },
      );
      // The real application persists this exact reviewed candidate on plan import.
      const mdProtocol = (await seeded.mdStore.getProtocol(seeded.protocol.id, 1))!;
      const candidate = {
        schemaVersion: "eigengrid.mission-candidate/v1",
        plan: seeded.plan,
        decisions: [],
        evidence: [],
        md: {
          protocol: mdProtocol,
          system: seeded.manifest,
          decisionRefs: seeded.manifest.decisionRefs.filter((d) =>
            mdProtocol.decisionRefs.includes(d.id),
          ),
          stageSkillBindings: seeded.stageSkillBindings,
        },
      };
      const stored = await primary.put(Buffer.from(canonicalJson(candidate)));
      await seeded.store.createEvidence({
        id: `candidate-${digestCanonical({ planId: seeded.plan.id }).slice(0, 32)}`,
        missionId: "mission-md-1",
        kind: "human_review",
        uri: stored.uri,
        contentDigest: stored.digest,
        immutable: true,
        sourceId: seeded.plan.id,
        createdAt: seeded.plan.createdAt,
      });
      lifecycle = new MdStageLifecycleStore(database, primary, {
        replicaVerifier: new MdReplicaVerifier({
          identity,
          replicaPublicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
          readReceipt: async (op) => receipts.get(op) ?? null,
        }),
      });
      for (const [i, name] of names.entries()) {
        const delivery = await consumeCanonicalMdFixtureDelivery(
          database,
          primary,
          seeded,
          seeded.workUnits[i]!,
          undefined,
          { policyDigest: policy.policyDigest },
        );
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
          const object = await primary.put(
            Buffer.from(
              canonicalJson({ role, operationId: delivery.operation.id, synthetic: true }),
            ),
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
            sha256: object.digest,
            sizeBytes: object.sizeBytes,
            mediaType: output?.mediaType ?? "application/json",
          });
        }
        const collection: MdResultCollection = {
          schemaVersion: "eigengrid.md-result-collection/v1",
          operationId: delivery.operation.id,
          deliveryDigest: delivery.delivery.deliveryDigest,
          bindingDigest: delivery.delivery.bindingDigest,
          publicationDigest: artifacts[0]!.sha256,
          accountingDigest: artifacts[1]!.sha256,
          workerReceiptDigest: artifacts[2]!.sha256,
          slurmJobId: "9001",
          slurmCluster: delivery.profile.transport.cluster,
          submittedAt: "2026-08-23T00:05:00.000Z",
          uid: 2101,
          outcome: "completed",
          artifacts,
          artifactStatus: "complete",
          durability: "pending_replication",
          scientificVerdict: "not_evaluated",
          collectedAt: "2026-08-23T00:05:00.000Z",
        };
        await new MdResultCollectionStore(database, primary).adopt(collection);
        const claim = await lifecycle.acquire({
          operationId: delivery.operation.id,
          ownerId: "head-advance",
          now: NOW,
          expiresAt: "2026-08-23T00:09:00.000Z",
        });
        if (!claim.acquired) throw new Error("fixture lease unavailable");
        const input = await finalizationFixture({
          cas: primary,
          collection,
          stage: seeded.stage,
          protocol: seeded.protocol,
          lease: claim.lease,
          engine: environment.engine,
          now: NOW,
        });
        await lifecycle.finalize(input, { now: NOW, currentPolicyDigest: policy.policyDigest });
        inputs.set(name, input);
      }
    }, 30_000);
    afterAll(async () => {
      await primary?.close();
      await replica?.close();
      await database?.close();
      await cluster?.cleanup();
      if (root) rmSync(root, { recursive: true, force: true });
    });
    const context = (name: string) => ({
      lease: inputs.get(name)!.lease,
      now: NOW,
      policy,
      environment,
    });
    async function replicate(name: string) {
      const manifest = await lifecycle.prepareReplication(inputs.get(name)!.lease.operationId);
      const receipt = await replicateMdArtifactManifest({
        manifest,
        source: primary,
        replica,
        identity,
        replicaPrivateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        now: NOW,
      });
      receipts.set(manifest.operationId, receipt);
      return { manifest, receipt };
    }
    test("missing independent receipt keeps observing, preserves exact result and emits no successor", async () => {
      const output = await lifecycle.advance(context("missing"));
      expect(output.status).toBe("pending_replication");
      expect((await seeded.store.getWorkUnit("md-missing"))!.state).toBe("observing");
      expect(
        (await seeded.store.getMissionProvenance("mission-md-1")).workUnits.filter((w) =>
          w.dependencies.includes("md-missing"),
        ),
      ).toHaveLength(0);
    });
    test("two concurrent Heads create exactly one deterministic successor after verified readback", async () => {
      const { manifest } = await replicate("advance");
      for (const object of manifest.objects)
        expect((await replica.verify(object.digest)).sizeBytes).toBe(object.sizeBytes);
      const outcomes = await Promise.all([
        lifecycle.advance(context("advance")),
        lifecycle.advance(context("advance")),
      ]);
      expect(outcomes.every((o) => o.status === "advanced")).toBe(true);
      expect(outcomes.filter((o) => o.status === "advanced" && o.created)).toHaveLength(1);
      const first = outcomes[0];
      if (first.status !== "advanced") throw new Error("not advanced");
      expect(first.canonicalAcknowledged).toBe(false); // no database RPO0 or site qualification claim
      expect(first.workUnitIds).toHaveLength(1);
      expect((await seeded.store.getWorkUnit(first.workUnitIds[0]!))!).toMatchObject({
        state: "ready",
        dependencies: ["md-advance"],
      });
      expect((await seeded.store.getWorkUnit("md-advance"))!).toMatchObject({
        state: "succeeded",
        claimOwner: null,
      });
      expect(await lifecycle.advance(context("advance"))).toMatchObject({
        status: "advanced",
        created: false,
      });
    });
    test("crash during successor insert rolls back parent completion and can safely resume", async () => {
      await replicate("rollback");
      const before = await seeded.store.getWorkUnit("md-rollback");
      await database.query(
        `CREATE FUNCTION test_only_md_next_crash() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id LIKE 'wu-md-%' THEN RAISE EXCEPTION 'injected next-stage crash'; END IF; RETURN NEW; END $$`,
      );
      await database.query(
        `CREATE TRIGGER test_only_md_next BEFORE INSERT ON scientific_work_units FOR EACH ROW EXECUTE FUNCTION test_only_md_next_crash()`,
      );
      try {
        await expect(lifecycle.advance(context("rollback"))).rejects.toThrow(
          "Scientific persistence constraint failed during create work units",
        );
      } finally {
        await database.query("DROP TRIGGER test_only_md_next ON scientific_work_units");
        await database.query("DROP FUNCTION test_only_md_next_crash()");
      }
      expect(await seeded.store.getWorkUnit("md-rollback")).toEqual(before);
      const tx = await database.beginTransaction();
      try {
        expect(
          await tx.queryRows!(
            "SELECT work_unit_id FROM scientific_md_work_unit_completion_gates WHERE work_unit_id=$1",
            ["md-rollback"],
          ),
        ).toHaveLength(0);
      } finally {
        await tx.rollback();
      }
      expect(await lifecycle.advance(context("rollback"))).toMatchObject({
        status: "advanced",
        created: true,
      });
    });
    test("revocation after accepted finalization still prevents successor creation", async () => {
      await replicate("revoked");
      await database.query("UPDATE users SET status='disabled' WHERE id='scientist-1'");
      try {
        await expect(lifecycle.advance(context("revoked"))).rejects.toThrow(/membership/);
      } finally {
        await database.query("UPDATE users SET status='active' WHERE id='scientist-1'");
      }
      expect((await seeded.store.getWorkUnit("md-revoked"))!.state).toBe("observing");
    });
    test("a forged signed-receipt body does not pass by recomputing its checksum", async () => {
      const { receipt } = await replicate("candidate");
      receipts.set(inputs.get("candidate")!.lease.operationId, {
        ...receipt,
        body: { ...receipt.body, storageProfileDigest: "c".repeat(64) },
      } as typeof receipt);
      await expect(lifecycle.advance(context("candidate"))).rejects.toThrow();
      receipts.set(inputs.get("candidate")!.lease.operationId, receipt);
      await expect(
        lifecycle.advance({
          ...context("candidate"),
          policy: { ...policy, retryPolicy: { ...policy.retryPolicy, maximumAttempts: 9 } },
        }),
      ).rejects.toThrow(/compiler policy/);
      expect((await seeded.store.getWorkUnit("md-candidate"))!.state).toBe("observing");
      expect(
        mdPostprocessingIds(inputs.get("candidate")!.lease.operationId).advancementId,
      ).toBeTruthy();
    });
  },
);
