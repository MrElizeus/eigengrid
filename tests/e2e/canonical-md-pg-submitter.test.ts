import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { callSubmitter } from "@eigengrid/slurm";
import { PostgresDatabase } from "@eigengrid/db";
import {
  ContentAddressedArtifactStore,
  MdPreparationPublicationStore,
  ScientificEffectReconciliationStore,
} from "@eigengrid/mission-runtime";
import {
  MdExecutionBindingParametersSchema,
  digestCanonical,
  type WorkUnit,
} from "@eigengrid/scientific-schema";
import {
  createAmberMdStageOperationRequest,
  renderCanonicalAmberStage,
} from "@eigengrid/amber-adapter";
import {
  signedMapping,
  unsignedMapping,
} from "../../packages/amber-adapter/src/canonical-stage.fixture";
import { publishAmberStageBundle } from "../../apps/cli/src/services/amber-stage-bundle";
import {
  AmberPreparationPublicationService,
  createHeadMdExecutionGateway,
} from "../../apps/cli/src/services/amber-preparation-publication";
import { createHeadMdSiteAuthorityReader } from "../../apps/cli/src/services/head-md-site-authority";
import { CanonicalScientificExecutionDriver } from "../../apps/cli/src/services/scientific-mission-driver";
import { startEphemeralPostgres } from "../ts/helpers/postgres";
import {
  MD_FIXTURE_NOW,
  MD_FIXTURE_POLICY,
  MD_FIXTURE_PROJECT,
  MD_FIXTURE_SUBJECT,
  seedCanonicalMdAuthority,
} from "./helpers/canonical-md-authority";
import {
  FIXTURE_AUTHORITY,
  FIXTURE_CONTROL,
  FIXTURE_PUBLICATION,
  FIXTURE_PRIVATE_CAS,
  FIXTURE_SOCKET,
  fixtureEnvironment,
} from "./helpers/md-protected-site";

const inside = process.env.EIGENGRID_MD_BOUNDARY_CONTAINER === "1";
const enabled = Boolean(process.env.EIGENGRID_TEST_POSTGRES_URL);

if (!inside) {
  test.skipIf(!enabled)(
    "canonical MD: real PostgreSQL + protected rootless socket boundary",
    async () => {
      const runtime =
        process.env.EIGENGRID_TEST_CONTAINER_RUNTIME ?? Bun.which("podman") ?? "docker";
      const image =
        process.env.EIGENGRID_TEST_MD_IMAGE ??
        "docker.io/library/python@sha256:1aaa65a85fda306ffb8b910824d4e93bdce61e212c7e87168123ea3073b41a1a";
      // Deliberately fail if explicitly requested PG integration lacks its container
      // dependency. No silent mock/fallback and no privileged host filesystem writes.
      const processHandle = Bun.spawn(
        [
          runtime,
          "run",
          "--rm",
          "--network=host",
          "--security-opt=label=disable",
          "--mount",
          `type=bind,src=${resolve(import.meta.dir, "../..")},dst=/workspace,ro`,
          "--mount",
          `type=bind,src=${process.execPath},dst=/bun,ro`,
          "--workdir",
          "/workspace",
          "--env",
          "EIGENGRID_MD_BOUNDARY_CONTAINER=1",
          "--env",
          `EIGENGRID_TEST_POSTGRES_URL=${process.env.EIGENGRID_TEST_POSTGRES_URL}`,
          "--env",
          "PYTHONPATH=/workspace/python/src",
          image,
          "python",
          "tests/e2e/helpers/md-boundary-container.py",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [code, stdout, stderr] = await Promise.all([
        processHandle.exited,
        new Response(processHandle.stdout).text(),
        new Response(processHandle.stderr).text(),
      ]);
      if (code !== 0)
        throw new Error(`Isolated canonical MD integration failed (${code})\n${stdout}\n${stderr}`);
      expect(stdout + stderr).toContain("1 pass");
      console.log(stdout + stderr);
    },
    60_000,
  );
} else {
  test("real PG publication, concurrent delivery, lost ACK, CAS-free recovery, revocation and no claim", async () => {
    expect(process.getuid?.()).toBe(1000);
    expect(lstatSync(FIXTURE_AUTHORITY).uid).toBe(0);
    expect(lstatSync(FIXTURE_SOCKET).uid).toBe(0);
    for (let attempt = 0; !existsSync(`${FIXTURE_CONTROL}/ready`) && attempt < 50; attempt++)
      await Bun.sleep(20);
    expect(existsSync(`${FIXTURE_CONTROL}/ready`)).toBe(true);
    const cluster = await startEphemeralPostgres();
    const database = new PostgresDatabase(cluster.url);
    const cas = new ContentAddressedArtifactStore(FIXTURE_PUBLICATION);
    const now = () => new Date(MD_FIXTURE_NOW);
    try {
      await database.init();
      await cas.init();
      const seeded = await seedCanonicalMdAuthority(database, cas, [
        "work-unit-lost-ack",
        "work-unit-no-claim",
        "work-unit-revoked",
      ]);
      const reader = createHeadMdSiteAuthorityReader(FIXTURE_AUTHORITY);
      const publications = new AmberPreparationPublicationService(
        new MdPreparationPublicationStore(database, now),
        reader,
        MD_FIXTURE_POLICY,
        now,
      );
      for (const workUnit of seeded.workUnits) {
        const executionBinding = MdExecutionBindingParametersSchema.parse(
          workUnit.protocolFragment.parameters,
        );
        const base = unsignedMapping(seeded.stage, executionBinding);
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
              logicalPath:
                input.role === "topology" ? "inputs/system.prmtop" : "inputs/system.rst7",
            })),
            outputs: base.artifactPaths.outputs,
          },
        });
        const rendered = renderCanonicalAmberStage(
          seeded.stage,
          mapping,
          executionBinding,
          seeded.atomMap,
        );
        const request = createAmberMdStageOperationRequest(rendered, fixtureEnvironment, {
          workUnitId: workUnit.id,
          bindingDigest: mapping.canonicalWorkUnit.bindingDigest,
          outputContractDigest: digestCanonical(workUnit.outputContract),
        });
        const bundle = await publishAmberStageBundle(cas, {
          stage: seeded.stage,
          mapping,
          executionBinding,
          atomMap: seeded.atomMap,
          request,
        });
        await publications.registerPublished({
          workUnitId: workUnit.id,
          reference: bundle.reference,
          request,
        });
        expect((await publications.prepareBundle(workUnit)).manifest.request).toEqual(request);
      }
      const driver = () =>
        new CanonicalScientificExecutionDriver({
          store: seeded.store,
          execution: {} as never,
          effectPersistence: new ScientificEffectReconciliationStore(database, now),
          currentPolicyDigestFor: () => MD_FIXTURE_POLICY,
          md: createHeadMdExecutionGateway({
            database,
            siteAuthorityConfigPath: FIXTURE_AUTHORITY,
            currentPolicyDigest: MD_FIXTURE_POLICY,
            artifactRoot: FIXTURE_PRIVATE_CAS,
            now,
          }),
          now,
        });
      const execute = (workUnit: WorkUnit) =>
        driver().executeClaimedWorkUnit(workUnit, {
          ownerId: seeded.ownerId,
          claimOwner: seeded.ownerId,
          now: MD_FIXTURE_NOW,
        });
      const counts = () =>
        JSON.parse(readFileSync(`${FIXTURE_CONTROL}/counts.json`, "utf8")) as {
          submits: number;
          observations: number;
          claims: number;
        };
      const operations = async () =>
        (await seeded.store.getMissionProvenance("mission-md-1")).operations.filter(
          (operation) => operation.kind === "md_stage_execution",
        );
      const mode = (value: string) => writeFileSync(`${FIXTURE_CONTROL}/mode`, value);
      mode("lost_ack");
      const calls = await Promise.all([
        execute(seeded.workUnits[0]!),
        execute(seeded.workUnits[0]!),
      ]);
      expect(calls.every((result) => result.status === "waiting")).toBe(true);
      expect(counts()).toMatchObject({ submits: 1, claims: 1 });
      let lostAck = (await operations()).find(
        (operation) => operation.workUnitId === "work-unit-lost-ack",
      )!;
      expect(lostAck.state).toBe("ambiguous");
      expect(lostAck.receiptId).toBeUndefined();
      expect(await seeded.store.getWorkUnit(lostAck.workUnitId)).toMatchObject({
        state: "executing",
      });
      mode("no_claim");
      expect((await execute(seeded.workUnits[1]!)).status).toBe("waiting");
      const noClaim = (await operations()).find(
        (operation) => operation.workUnitId === "work-unit-no-claim",
      )!;
      expect(noClaim.state).toBe("ambiguous");
      expect(counts()).toMatchObject({ submits: 1, claims: 1 });
      // Physically remove all CAS availability. Existing durable delivery must be enough.
      await cas.close();
      chmodSync(FIXTURE_PUBLICATION, 0o000);
      expect(() => readdirSync(FIXTURE_PUBLICATION)).toThrow();
      mode("normal");
      await Promise.all([
        driver().reconcileOperation(lostAck, { ownerId: "restarted-head-a", now: MD_FIXTURE_NOW }),
        driver().reconcileOperation(lostAck, { ownerId: "restarted-head-b", now: MD_FIXTURE_NOW }),
      ]);
      lostAck = (await seeded.store.getExternalOperation(lostAck.id))!;
      expect(lostAck).toMatchObject({
        state: "acknowledged",
        externalIdentity: { slurmJobId: "9001" },
      });
      expect(lostAck.receiptId).toBeUndefined();
      await driver().reconcileOperation(noClaim, {
        ownerId: "restarted-head",
        now: MD_FIXTURE_NOW,
      });
      await driver().reconcileOperation(noClaim, {
        ownerId: "restarted-head",
        now: MD_FIXTURE_NOW,
      });
      const provenance = await seeded.store.getMissionProvenance("mission-md-1");
      const diagnostics = provenance.decisions.filter(
        (decision) =>
          decision.id.startsWith("decision-md-recovery-") &&
          JSON.parse(decision.rationale).operationId === noClaim.id,
      );
      expect(diagnostics).toHaveLength(1);
      expect(JSON.parse(diagnostics[0]!.rationale).outcome).toBe("rejected_or_no_claim");
      const observationSession = reader.createAmberObservationSession(
        database,
        { subject: MD_FIXTURE_SUBJECT, projectId: MD_FIXTURE_PROJECT },
        now,
      );
      const prepared = await observationSession.observe(lostAck.id);
      const target = await observationSession.authorizeObserveRpc({ prepared });
      const envelope = JSON.parse(Buffer.from(target.wire).toString("utf8"));
      const signature = Buffer.from(envelope.signature, "base64");
      signature[0] = signature[0]! ^ 1;
      envelope.signature = signature.toString("base64");
      const observed = counts().observations;
      expect(await callSubmitter(target.socketPath, Buffer.from(JSON.stringify(envelope)))).toEqual(
        { status: "rejected", resubmitAllowed: false },
      );
      expect(counts().observations).toBe(observed);
      await database.removeProjectMember(MD_FIXTURE_PROJECT, MD_FIXTURE_SUBJECT);
      await driver().reconcileOperation(lostAck, { ownerId: "revoked-head", now: MD_FIXTURE_NOW });
      expect(counts()).toMatchObject({ submits: 1, claims: 1, observations: observed });
      expect(await seeded.store.getExternalOperation(lostAck.id)).toMatchObject({
        state: "acknowledged",
      });
      chmodSync(FIXTURE_PUBLICATION, 0o770);
      expect((await execute(seeded.workUnits[2]!)).status).toBe("failed");
      expect(
        (await operations()).some((operation) => operation.workUnitId === "work-unit-revoked"),
      ).toBe(false);
      expect(counts().submits).toBe(1);
      const budget = await seeded.store.getMissionBudget("mission-md-1");
      expect(
        budget.reservations
          .filter((reservation) => reservation.kind === "external_operation")
          .every((reservation) => ["reserved", "ambiguous"].includes(reservation.state)),
      ).toBe(true);
      expect(
        provenance.receipts.filter((receipt) =>
          [lostAck.id, noClaim.id].includes(receipt.operationId),
        ),
      ).toHaveLength(0);
      expect(await seeded.store.getWorkUnit(lostAck.workUnitId)).toMatchObject({
        state: "executing",
      });
      expect(await seeded.store.getWorkUnit(noClaim.workUnitId)).toMatchObject({
        state: "executing",
      });
    } finally {
      await cas.close();
      await database.close();
      await cluster.cleanup();
    }
  }, 30_000);
}
