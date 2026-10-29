import { expect } from "bun:test";
import type { DatabaseLike } from "@eigengrid/db";
import {
  MdExecutionBindingParametersSchema,
  canonicalJson,
  computeMdEnvironmentCapabilitySnapshotDigest,
  MdEnvironmentCapabilitySnapshotSchema,
  digestCanonical,
  type AtomMap,
  type MdStageOperationRequest,
  type MdStageSpec,
  type WorkUnit,
} from "@eigengrid/scientific-schema";
import {
  MdPreparationPublicationStore,
  ScientificStore,
  type MdPreparationManifest,
  type ScientificTransaction,
} from "@eigengrid/mission-runtime";

/** Metadata-only fixture: tests durable DB authority, never Amber rendering,
 * CAS byte integrity, an engine invocation or scientific acceptance. */
export async function exerciseMdPreparationPublication(input: {
  database: DatabaseLike;
  workUnit: WorkUnit;
  stage: MdStageSpec;
  atomMap: AtomMap;
  request: MdStageOperationRequest;
  policyDigest: string;
  at: string;
}): Promise<void> {
  const { database, workUnit, stage, atomMap } = input;
  const store = new MdPreparationPublicationStore(database, () => new Date(input.at));
  const context = { at: input.at, currentPolicyDigest: input.policyDigest };
  const request = structuredClone(input.request);
  const binding = MdExecutionBindingParametersSchema.parse(workUnit.protocolFragment.parameters);
  const rawSnapshot = {
    schemaVersion: "eigengrid.md-environment-capability-snapshot/v1",
    id: request.environment.canonicalSnapshotId,
    environmentDigest: "0".repeat(64),
    engine: request.environment.engine,
    capabilities: [{ id: "amber.production-md", version: "1.0.0", contractDigest: "3".repeat(64) }],
    targetCompatibility: {
      family: "amber",
      versionRange: ">=24",
      compatible: true,
      evaluatorVersion: "1.0.0",
      evidenceDigest: "4".repeat(64),
    },
    observedAt: input.at,
  };
  const snapshot = MdEnvironmentCapabilitySnapshotSchema.parse({
    ...rawSnapshot,
    environmentDigest: computeMdEnvironmentCapabilitySnapshotDigest(rawSnapshot),
  });
  request.environment.canonicalSnapshotDigest = snapshot.environmentDigest;
  const unsignedEnvironment = {
    schemaVersion: "eigengrid.fixture-environment-binding/v1",
    bindingVersion: request.environment.bindingVersion,
    canonicalSnapshot: snapshot,
  };
  const environment = {
    ...unsignedEnvironment,
    bindingDigest: digestCanonical(unsignedEnvironment),
  };
  request.environment.bindingDigest = environment.bindingDigest;
  const unsignedMapping = {
    schemaVersion: "eigengrid.fixture-stage-mapping/v1",
    canonicalStage: {
      id: stage.id,
      revision: stage.revision,
      kind: stage.kind,
      stageDigest: stage.stageDigest,
      rendererCompatibilityVersion: stage.rendererCompatibilityVersion,
    },
    canonicalWorkUnit: {
      bindingDigest: digestCanonical(binding),
      plan: binding.plan,
      system: binding.system,
      protocol: binding.protocol,
    },
    canonicalAtomMap: { id: atomMap.id, revision: atomMap.revision, mapDigest: atomMap.mapDigest },
    environment,
  };
  const mapping = { ...unsignedMapping, mappingDigest: digestCanonical(unsignedMapping) };
  request.render.mapperDigest = mapping.mappingDigest;
  const manifest: MdPreparationManifest = {
    schemaVersion: "eigengrid.amber-stage-bundle/v1",
    stage,
    executionBinding: binding,
    request,
    mapping,
    atomMap: {
      sha256: digestCanonical(atomMap),
      sizeBytes: Buffer.byteLength(canonicalJson(atomMap)),
    },
    inputs: [
      {
        role: "topology.prmtop",
        logicalPath: "input/system.prmtop",
        mediaType: "application/octet-stream",
        sha256: atomMap.topologyDigest,
        sizeBytes: 8,
      },
      {
        role: "coordinates.input",
        logicalPath: "input/system.rst7",
        mediaType: "application/octet-stream",
        sha256: atomMap.coordinateDigest,
        sizeBytes: 11,
      },
      {
        role: "stage.mdin",
        logicalPath: "input/stage.mdin",
        mediaType: "text/plain",
        sha256: request.render.mdinDigest,
        sizeBytes: 16,
      },
    ],
  };
  const publishInput = {
    ...context,
    workUnitId: workUnit.id,
    manifest,
    bundle: {
      sha256: digestCanonical(manifest),
      sizeBytes: Buffer.byteLength(canonicalJson(manifest)),
    },
  };
  expect(await store.resolve(workUnit.id, context)).toBeNull();
  const authority = await store.authorize(workUnit.id, { ...context, request });
  expect(authority.association.ownerUserId).toBe("scientist-1");
  expect(authority.stage).toEqual(stage);
  // The Head reads the published bundle after mission start and WorkUnit claim.
  const missions = new ScientificStore(database);
  let active = await missions.getMission(workUnit.missionId);
  if (!active || active.state !== "ready") throw new Error("Publication fixture must begin ready");
  active = await missions.transitionMission({
    missionId: active.id,
    expectedRevision: active.revision,
    to: "executing",
    reason: "Exercise actual Head preparation state",
    actor: active.requestedBy,
    at: input.at,
  });
  expect((await store.authorize(workUnit.id, { ...context, request })).stage).toEqual(stage);
  active = await missions.transitionMission({
    missionId: active.id,
    expectedRevision: active.revision,
    to: "paused",
    reason: "Test stopped mission must reject publication",
    actor: active.requestedBy,
    at: input.at,
  });
  await expect(store.authorize(workUnit.id, { ...context, request })).rejects.toThrow("pre-effect");
  await missions.transitionMission({
    missionId: active.id,
    expectedRevision: active.revision,
    to: "ready",
    reason: "Restore remaining authority negative tests",
    actor: active.requestedBy,
    at: input.at,
  });

  const attempts = await Promise.all([
    store.publish(publishInput),
    new MdPreparationPublicationStore(database, () => new Date(input.at)).publish(publishInput),
  ]);
  expect(attempts.map((item) => item.created).sort()).toEqual([false, true]);
  expect(attempts[0]!.publication).toEqual(attempts[1]!.publication);
  const publication = attempts[0]!.publication;
  expect(await store.resolve(workUnit.id, context)).toEqual(publication);
  expect(publication.manifest).toEqual(manifest);
  expect(publication.inputEvidenceRefs).toEqual([...workUnit.inputRefs].sort());
  expect(JSON.stringify(publication)).not.toContain('"uid"');
  expect(JSON.stringify(publication)).not.toContain('"root"');
  // A new read time cannot replace the original append-only publication timestamp.
  expect((await store.publish({ ...publishInput, at: "2026-08-23T00:04:59.000Z" })).created).toBe(
    false,
  );

  for (const change of [
    (value: MdPreparationManifest) => {
      value.request.workUnitId = "different-work-unit";
    },
    (value: MdPreparationManifest) => {
      value.executionBinding.plan.revision += 1;
    },
    (value: MdPreparationManifest) => {
      value.atomMap.sha256 = "0".repeat(64);
    },
    (value: MdPreparationManifest) => {
      value.inputs[0]!.sha256 = "1".repeat(64);
    },
    (value: MdPreparationManifest) => {
      value.inputs[0]!.sizeBytes += 1;
    },
    (value: MdPreparationManifest) => {
      value.inputs[0]!.logicalPath = "../escape.prmtop";
    },
    (value: MdPreparationManifest) => {
      value.mapping.environment = {};
    },
  ]) {
    const changed = structuredClone(manifest);
    change(changed);
    await expect(
      store.publish({
        ...publishInput,
        manifest: changed,
        bundle: {
          sha256: digestCanonical(changed),
          sizeBytes: Buffer.byteLength(canonicalJson(changed)),
        },
      }),
    ).rejects.toThrow();
  }
  await expect(
    store.publish({
      ...publishInput,
      bundle: { ...publishInput.bundle, sizeBytes: publishInput.bundle.sizeBytes + 1 },
    }),
  ).rejects.toThrow();
  await expect(
    store.resolve(workUnit.id, { ...context, currentPolicyDigest: "0".repeat(64) }),
  ).rejects.toThrow();

  async function query(sql: string, values: unknown[] = []) {
    const tx = (await database.beginTransaction()) as ScientificTransaction;
    try {
      const rows = await tx.queryRows(sql, values);
      await tx.commit();
      return rows;
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }
  for (const statement of [
    "UPDATE scientific_md_preparation_publications SET bundle_digest = bundle_digest WHERE work_unit_id = $1",
    "DELETE FROM scientific_md_preparation_publications WHERE work_unit_id = $1",
    "TRUNCATE scientific_md_preparation_publications",
  ])
    await expect(query(statement, statement.includes("$1") ? [workUnit.id] : [])).rejects.toThrow(
      /append.only/i,
    );

  await database.removeProjectMember(publication.projectId, publication.ownerUserId);
  try {
    await expect(store.authorize(workUnit.id, { ...context, request })).rejects.toThrow(
      /membership/i,
    );
    await expect(store.publish(publishInput)).rejects.toThrow(/membership/i);
    await expect(store.resolve(workUnit.id, context)).rejects.toThrow(/membership/i);
    const rows = await query(
      "SELECT publication_digest FROM scientific_md_preparation_publications WHERE work_unit_id = $1",
      [workUnit.id],
    );
    expect(rows).toEqual([{ publication_digest: publication.publicationDigest }]);
  } finally {
    await database.addProjectMember(publication.projectId, publication.ownerUserId, "member");
  }
  const [approval] = await query(
    "SELECT payload_json FROM scientific_approval_requests WHERE id = $1",
    [binding.plan.approvalRef],
  );
  const original = JSON.parse(String(approval!.payload_json));
  const revoked = { ...original, state: "superseded" };
  await query(
    "UPDATE scientific_approval_requests SET state = $1, payload_json = $2 WHERE id = $3",
    [revoked.state, canonicalJson(revoked), binding.plan.approvalRef],
  );
  try {
    await expect(store.resolve(workUnit.id, context)).rejects.toThrow(/revoked|policy/i);
    await expect(store.publish(publishInput)).rejects.toThrow(/revoked|policy/i);
  } finally {
    await query(
      "UPDATE scientific_approval_requests SET state = $1, payload_json = $2 WHERE id = $3",
      [original.state, canonicalJson(original), binding.plan.approvalRef],
    );
  }
  await expect(
    store.resolve(workUnit.id, { ...context, at: "2026-08-24T00:00:00.000Z" }),
  ).rejects.toThrow(/timestamp/);
  const mutable = structuredClone(publishInput);
  const snapshotReplay = store.publish(mutable);
  mutable.workUnitId = "caller-mutated-after-await";
  mutable.currentPolicyDigest = "0".repeat(64);
  mutable.manifest.mapping.environment = {};
  expect((await snapshotReplay).publication).toEqual(publication);

  // Exercise both an approval-lock wait and a later AtomMap-lock wait, using
  // a moving trusted clock. No timer delay is used as a substitute for a lock.
  for (const phase of ["approval", "atom-map"] as const) {
    const expiring = { ...original, expiresAt: "2026-08-23T00:05:01.000Z" };
    await query(
      "UPDATE scientific_approval_requests SET expires_at = $1, payload_json = $2 WHERE id = $3",
      [expiring.expiresAt, canonicalJson(expiring), binding.plan.approvalRef],
    );
    const blocker = (await database.beginTransaction()) as ScientificTransaction;
    const table =
      phase === "approval" ? "scientific_approval_requests" : "scientific_atom_map_revisions";
    await blocker.query(`SELECT id FROM ${table} WHERE id = $1 FOR UPDATE`, [
      phase === "approval" ? binding.plan.approvalRef : atomMap.id,
    ]);
    let live = input.at;
    const waitingStore = new MdPreparationPublicationStore(database, () => new Date(live));
    const pending = (
      phase === "approval"
        ? waitingStore.resolve(workUnit.id, context)
        : waitingStore.publish(publishInput)
    ).then(
      () => ({ rejected: false }),
      () => ({ rejected: true }),
    );
    let committed = false;
    try {
      const deadline = Date.now() + 3_000;
      let waiting = false;
      while (Date.now() < deadline) {
        await blocker.query("SELECT pg_stat_clear_snapshot()");
        const [row] = await blocker.queryRows<{ count: string }>(
          "SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1",
          [`%${table}%`],
        );
        if (Number(row?.count) > 0) {
          waiting = true;
          break;
        }
        await Bun.sleep(10);
      }
      expect(waiting).toBe(true);
      live = "2026-08-23T00:05:02.000Z";
      await blocker.commit();
      committed = true;
      expect((await pending).rejected).toBe(true);
    } finally {
      if (!committed) await blocker.rollback();
      await pending;
      await query(
        "UPDATE scientific_approval_requests SET expires_at = $1, payload_json = $2 WHERE id = $3",
        [original.expiresAt ?? null, canonicalJson(original), binding.plan.approvalRef],
      );
    }
  }
  const [effects] = await query(
    "SELECT count(*)::integer AS count FROM scientific_effect_admissions WHERE work_unit_id = $1",
    [workUnit.id],
  );
  expect(effects!.count).toBe(0);
  expect(await store.resolve(workUnit.id, context)).toEqual(publication);
}
