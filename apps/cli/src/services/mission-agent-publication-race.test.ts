import { test, expect } from "bun:test";
import { Pool } from "pg";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgresDatabase } from "@eigengrid/db";
import {
  ContentAddressedArtifactStore,
  MdPreparationPublicationStore,
  MdPreparationManifestSchema,
} from "@eigengrid/mission-runtime";
import { MdExecutionBindingParametersSchema, digestCanonical } from "@eigengrid/scientific-schema";
import {
  createAmberMdStageOperationRequest,
  renderCanonicalAmberStage,
} from "@eigengrid/amber-adapter";
import {
  signedMapping,
  unsignedMapping,
} from "../../../../packages/amber-adapter/src/canonical-stage.fixture";
import { startEphemeralPostgres, canRunPostgres } from "../../../../tests/ts/helpers/postgres";
import {
  seedCanonicalMdAuthority,
  MD_FIXTURE_NOW,
  MD_FIXTURE_POLICY,
} from "../../../../tests/e2e/helpers/canonical-md-authority";
import { fixtureEnvironment } from "../../../../tests/e2e/helpers/md-protected-site";
import { publishAmberStageBundle } from "./amber-stage-bundle";

test.skipIf(!canRunPostgres)(
  "MD stage publication rechecks cancellation after async CAS staging before durable publication",
  async () => {
    const cluster = await startEphemeralPostgres();
    const database = new PostgresDatabase(cluster.url);
    const root = await mkdtemp(join(tmpdir(), "eg-agent-md-race-"));
    const cas = new ContentAddressedArtifactStore(root);
    try {
      await database.init();
      await cas.init();
      // Explicit synthetic molecular fixture, only to establish the production authorization boundary.
      const seeded = await seedCanonicalMdAuthority(database, cas, [
        "work-unit-agent-publication-race",
      ]);
      const work = seeded.workUnits[0]!;
      const binding = MdExecutionBindingParametersSchema.parse(work.protocolFragment.parameters);
      const base = unsignedMapping(seeded.stage, binding);
      const mapping = signedMapping({
        ...base,
        canonicalAtomMap: {
          id: seeded.atomMap.id,
          revision: seeded.atomMap.revision,
          mapDigest: seeded.atomMap.mapDigest,
          viewVersion: "1.0.0",
        },
        environment: fixtureEnvironment,
        artifactPaths: {
          ...base.artifactPaths,
          inputs: seeded.stage.inputs.map((input) => ({
            artifactId: input.artifactId,
            role: input.role,
            contentDigest: input.contentDigest,
            logicalPath: input.role === "topology" ? "inputs/system.prmtop" : "inputs/system.rst7",
          })),
        },
      });
      const rendered = renderCanonicalAmberStage(seeded.stage, mapping, binding, seeded.atomMap);
      const request = createAmberMdStageOperationRequest(rendered, fixtureEnvironment, {
        workUnitId: work.id,
        bindingDigest: digestCanonical(binding),
        outputContractDigest: digestCanonical(work.outputContract),
      });
      const publications = new MdPreparationPublicationStore(
        database,
        () => new Date(MD_FIXTURE_NOW),
      );
      await publications.authorize(work.id, {
        request,
        at: MD_FIXTURE_NOW,
        currentPolicyDigest: MD_FIXTURE_POLICY,
      });
      const bundle = await publishAmberStageBundle(cas, {
        stage: seeded.stage,
        mapping,
        executionBinding: binding,
        atomMap: seeded.atomMap,
        request,
      });
      const mission = (await seeded.store.getMission(work.missionId))!;
      await seeded.store.transitionMission({
        missionId: mission.id,
        expectedRevision: mission.revision,
        to: "cancel_requested",
        reason: "Operator cancels while async staging completes",
        actor: { id: seeded.ownerId, kind: "human", role: "scientific_reviewer" },
        at: MD_FIXTURE_NOW,
      });
      await expect(
        publications.publish({
          workUnitId: work.id,
          bundle: bundle.reference,
          manifest: MdPreparationManifestSchema.parse(bundle.manifest),
          at: MD_FIXTURE_NOW,
          currentPolicyDigest: MD_FIXTURE_POLICY,
        }),
      ).rejects.toThrow("active plan");
      const pool = new Pool({ connectionString: cluster.url });
      try {
        const rows = await pool.query(
          "SELECT work_unit_id FROM scientific_md_preparation_publications WHERE work_unit_id = $1",
          [work.id],
        );
        expect(rows.rows).toHaveLength(0);
      } finally {
        await pool.end();
      }
      const provenance = await seeded.store.getMissionProvenance(mission.id);
      expect(provenance.operations.filter((op) => op.workUnitId === work.id)).toHaveLength(0);
      expect((await seeded.store.getWorkUnit(work.id))?.state).toBe("claimed");
    } finally {
      await cas.close();
      await database.close();
      await cluster.cleanup();
      await rm(root, { recursive: true, force: true });
    }
  },
  20000,
);
