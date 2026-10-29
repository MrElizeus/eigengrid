import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContentAddressedArtifactStore, type MissionProvenance } from "@eigengrid/mission-runtime";
import {
  AtomMapSchema,
  ExternalOperationSchema,
  MdStageOperationRequestSchema,
  MdStageResultSchema,
  WorkUnitSchema,
  computeAtomMapDigest,
  computeMdStageResultDigest,
  computeMdStageSpecDigest,
  digestCanonical,
  type MdArtifactReference,
  type MdStageSpec,
} from "@eigengrid/scientific-schema";
import { TrajectoryInspectionSchemaVersion } from "@eigengrid/md-analysis";
import {
  canonicalAtomMap,
  executionBindingFor,
  explicitMinimization,
  snapshot,
  unsignedStage,
} from "../../../../packages/amber-adapter/src/canonical-stage.fixture";
import {
  CanonicalAmberArtifactInspector,
  type AmberArtifactInspectionLimits,
} from "./amber-artifact-inspector";
import { periodicAmberTrajectoryFixture } from "./amber-artifact-inspector.fixture";

const D = (character: string) => character.repeat(64);
const AT = "2026-09-22T00:00:00.000Z";
const smoke = join(process.cwd(), "tests/fixtures/amber");
const roots: string[] = [];
const stores: ContentAddressedArtifactStore[] = [];
process.env.PYTHONPATH = join(process.cwd(), "python/src");

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Real AmberTools 26 bytes; synthetic repository authority is deliberately
 * separate. This qualifies the adapter boundary, not a collected cluster run. */
async function fixture(
  options: {
    trajectory?: Buffer;
    swappedAtoms?: boolean;
    minimization?: boolean;
    periodic?: boolean;
    restart?: Buffer;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "eigengrid-inspector-test-"));
  roots.push(root);
  const objects = new ContentAddressedArtifactStore(join(root, "objects"));
  await objects.init();
  stores.push(objects);
  const base: MdStageSpec = options.minimization
    ? explicitMinimization().stage
    : { ...unsignedStage(), stageDigest: D("0") };
  async function artifact(
    role: MdArtifactReference["role"],
    filename: string,
    bytes?: Buffer,
  ): Promise<MdArtifactReference> {
    const stored = await objects.put(bytes ?? readFileSync(join(smoke, filename)));
    return {
      artifactId: `artifact-${role}`,
      evidenceRef: `evidence-${role}`,
      role,
      contentDigest: stored.digest,
      sizeBytes: stored.sizeBytes,
      mediaType:
        role === "topology"
          ? "application/vnd.amber.prmtop"
          : base.outputs.find((output) => output.role === role)!.mediaType,
    };
  }
  const topology = await artifact(
    "topology",
    "water.prmtop",
    options.periodic
      ? Buffer.from(
          readFileSync(join(smoke, "water.prmtop"), "ascii") +
            "%FLAG BOX_DIMENSIONS\n%FORMAT(5E16.8)\n  9.00000000E+01  2.00000000E+01  3.00000000E+01  4.00000000E+01\n",
        )
      : undefined,
  );
  const coordinate = await objects.put(readFileSync(join(smoke, "water.inpcrd")));
  const names = options.swappedAtoms ? ["H1", "O", "H2"] : ["O", "H1", "H2"];
  const mapBase = {
    ...canonicalAtomMap,
    atomCount: 3,
    topologyDigest: topology.contentDigest,
    coordinateDigest: coordinate.digest,
    entries: names.map((atomName, index) => ({
      systemAtomIndex: index + 1,
      componentId: "water",
      componentAtomIndex: index + 1,
      residueIndex: 1,
      residueName: "WAT",
      atomName,
      element: atomName === "O" ? "O" : "H",
    })),
  };
  const atomMap = AtomMapSchema.parse({ ...mapBase, mapDigest: computeAtomMapDigest(mapBase) });
  const stageBase = {
    ...base,
    ...(!options.minimization
      ? {
          steps: 5,
          timeStepPs: 0.001,
          simulatedTimePs: 0.005,
          checkpoint: { ...base.checkpoint, cadenceSteps: 5 },
          outputs: base.outputs.map((output) => ({
            ...output,
            ...(output.cadenceSteps !== undefined ? { cadenceSteps: 1 } : {}),
          })),
        }
      : {}),
    system: {
      ...base.system,
      topologyDigest: topology.contentDigest,
      coordinateDigest: coordinate.digest,
      atomMapDigest: atomMap.mapDigest,
    },
    inputs: [
      topology,
      ...(options.minimization
        ? [
            {
              artifactId: "artifact-coordinates",
              evidenceRef: "evidence-coordinates",
              role: "coordinates" as const,
              contentDigest: coordinate.digest,
              sizeBytes: coordinate.sizeBytes,
              mediaType: "application/vnd.amber.rst7",
            },
          ]
        : []),
    ],
  };
  const stage = { ...stageBase, stageDigest: computeMdStageSpecDigest(stageBase) };
  const binding = executionBindingFor(stage);
  const outputContract = {
    requiredEvidenceKinds: stage.outputs.filter((item) => item.required).map((item) => item.role),
    requiredObservationKinds: [],
  };
  const skill = {
    skillId: "amber.production-md",
    version: "1.0.0",
    contentDigest: D("1"),
    fragmentId: "fixture",
    fragmentDigest: D("2"),
    relativePath: "protocols/amber.md",
    selector: "fixture",
  };
  const workUnit = WorkUnitSchema.parse({
    id: "inspection-work",
    missionId: "inspection-mission",
    planId: binding.plan.id,
    planVersion: binding.plan.version,
    kind: "scientific_capability",
    state: "observing",
    reason: "Inspect recorded outputs",
    dependencies: [],
    inputRefs: [topology.evidenceRef],
    outputContract,
    skillRefs: [skill],
    protocolFragment: {
      schemaVersion: "eigengrid.scientific-capability-fragment/v1",
      id: "fixture-fragment",
      kind: "scientific_capability",
      capability: { id: "amber.production-md", version: "1.0.0", contractDigest: D("3") },
      reason: "Inspect recorded outputs",
      parameters: binding,
      sourceFragments: [skill],
      riskClass: 3,
    },
    retryPolicy: { maximumAttempts: 1, ambiguityRequiresReconciliation: true },
    approvalPolicy: { required: true, minimumRole: "scientific_reviewer" },
    executionPolicy: { capability: "amber.production-md", riskClass: 3 },
    revision: 1,
    claimOwner: null,
    claimExpiresAt: null,
    jobId: null,
    attemptId: null,
    createdAt: AT,
    updatedAt: AT,
  });
  const request = MdStageOperationRequestSchema.parse({
    schemaVersion: "eigengrid.md-stage-operation-request/v2",
    workUnitId: workUnit.id,
    bindingDigest: digestCanonical(binding),
    outputContractDigest: digestCanonical(outputContract),
    stage: { id: stage.id, revision: stage.revision, digest: stage.stageDigest, kind: stage.kind },
    environment: {
      canonicalSnapshotId: snapshot.id,
      canonicalSnapshotDigest: snapshot.environmentDigest,
      engineEnvironmentDigest: snapshot.engine.environmentDigest,
      bindingVersion: "1.0.0",
      bindingDigest: D("4"),
      engine: snapshot.engine,
      binaryDigest: snapshot.engine.buildDigest,
    },
    render: {
      schemaVersion: "fixture-render/v1",
      renderedStageDigest: D("5"),
      mapperVersion: "1.0.0",
      mapperDigest: D("6"),
      mdinDigest: D("7"),
      commandRequestDigest: D("8"),
    },
    outputs: {
      mappingVersion: "1.0.0",
      mappingDigest: D("9"),
      bindings: stage.outputs.map((item) => ({
        engineRole: item.role,
        canonicalRole: item.role,
        mediaType: item.mediaType,
        required: item.required,
      })),
    },
  });
  const operation = ExternalOperationSchema.parse({
    id: "inspection-operation",
    missionId: workUnit.missionId,
    workUnitId: workUnit.id,
    idempotencyKey: "inspection-operation",
    kind: "md_stage_execution",
    state: "confirmed",
    request,
    requestDigest: digestCanonical(request),
    policyDigest: D("a"),
    receiptId: "inspection-receipt",
    revision: 3,
    createdAt: AT,
    updatedAt: AT,
  });
  const receipt = {
    id: operation.receiptId!,
    operationId: operation.id,
    requestDigest: operation.requestDigest,
    status: "confirmed" as const,
    detailDigest: D("b"),
    recordedAt: AT,
  };
  const outputs = [
    await artifact(
      "restart",
      "md.rst7",
      options.restart ??
        (options.periodic
          ? Buffer.from(
              // A dynamic periodic restart must carry its absolute time AND
              // velocities. This is a synthetic, format-level fixture, not
              // a new Amber engine result or a physical velocity sample.
              readFileSync(join(smoke, "water.inpcrd"), "ascii").replace(
                /^\s*3\s*$/m,
                "     3  0.0050000",
              ) +
                "   0.0000000   0.0000000   0.0000000   0.0000000   0.0000000   0.0000000\n" +
                "   0.0000000   0.0000000   0.0000000\n" +
                " 20.0000000 30.0000000 40.0000000 90.0000000 90.0000000 90.0000000\n",
            )
          : undefined),
    ),
    await artifact("mdout", options.minimization ? "min.mdout" : "md.mdout"),
    await artifact("mdinfo", "md.mdinfo"),
    ...(options.minimization
      ? []
      : [
          await artifact(
            "trajectory",
            "md.nc",
            options.trajectory ?? (options.periodic ? periodicAmberTrajectoryFixture() : undefined),
          ),
        ]),
  ];
  const resultBase = {
    schemaVersion: "eigengrid.md-stage-result/v1" as const,
    id: "inspection-result",
    revision: 1,
    missionId: workUnit.missionId,
    workUnitId: workUnit.id,
    operationId: operation.id,
    operationReceiptId: receipt.id,
    protocolId: binding.protocol.id,
    protocolRevision: binding.protocol.revision,
    protocolDigest: binding.protocol.digest,
    stageId: stage.id,
    stageRevision: stage.revision,
    stageDigest: stage.stageDigest,
    stageKind: stage.kind,
    ...(binding.replicaSegment
      ? {
          replicaSetId: binding.replicaSegment.replicaSetId,
          replicaSetRevision: binding.replicaSegment.replicaSetRevision,
          replicaSetDigest: binding.replicaSegment.replicaSetDigest,
          replicaId: binding.replicaSegment.replicaId,
          segmentIndex: binding.replicaSegment.segmentIndex,
          parentRestartDigest: binding.parentRestart!.contentDigest,
        }
      : {}),
    terminalReason: "completed" as const,
    exitCode: 0,
    signal: null,
    startedAt: AT,
    finishedAt: AT,
    startStep: 0,
    endStep: 5,
    startTimePs: 0,
    endTimePs: 0.005,
    engine: snapshot.engine,
    artifacts: outputs,
    warnings: [],
    errors: [],
    validationStatus: "not_run" as const,
    validationRefs: [],
  };
  const result = MdStageResultSchema.parse({
    ...resultBase,
    resultDigest: computeMdStageResultDigest(resultBase),
  });
  const provenance = {
    mission: { id: workUnit.missionId },
    workUnits: [workUnit],
    operations: [operation],
    receipts: [receipt],
    evidence: [topology, ...outputs].map((item) => ({
      id: item.evidenceRef,
      missionId: workUnit.missionId,
      workUnitId: workUnit.id,
      kind: item.role,
      uri: objects.uriForDigest(item.contentDigest),
      contentDigest: item.contentDigest,
      sizeBytes: item.sizeBytes,
      mediaType: item.mediaType,
      immutable: true,
      sourceId: item === topology ? "preparation-receipt" : receipt.id,
      createdAt: AT,
    })),
  } as MissionProvenance;
  const input = {
    stageResultId: result.id,
    atomMapId: atomMap.id,
    atomMapRevision: atomMap.revision,
  };
  function inspector(
    limits?: Partial<AmberArtifactInspectionLimits>,
    pythonExecutable = Bun.which("python")!,
  ) {
    return new CanonicalAmberArtifactInspector({
      missionId: workUnit.missionId,
      workUnitId: workUnit.id,
      store: {
        async getMissionProvenance() {
          return provenance;
        },
      },
      md: {
        async getStageResult() {
          return result;
        },
        async getStageSpec() {
          return stage;
        },
        async getAtomMap() {
          return atomMap;
        },
      },
      objects,
      pythonExecutable,
      limits,
    });
  }
  return {
    root,
    objects,
    input,
    result,
    provenance,
    operation,
    receipt,
    stage,
    atomMap,
    inspector,
  };
}

describe("canonical AMBER CAS artifact inspection", () => {
  test("decodes independent periodic format bytes with receipt/topology/AtomMap provenance and no scientific approval", async () => {
    const f = await fixture({ periodic: true });
    const observed = await f.inspector().inspectStage(f.input);
    expect(observed.integrityStatus).toBe("verified");
    expect(observed.scientificVerdict).toBe("not_evaluated");
    expect(observed.topology.observation.atomCount).toBe(3);
    expect(observed.trajectories[0]).toMatchObject({
      frameCount: 5,
      atomCount: 3,
      hasPeriodicBox: true,
      operationReceiptRef: f.receipt.id,
    });
    const { inspectionDigest, ...material } = observed;
    expect(inspectionDigest).toBe(digestCanonical(material));
    expect(JSON.stringify(observed)).not.toContain(f.root);
    const inspector = await f.inspector().trajectoryInspector(f.input);
    const trajectory = f.result.artifacts.find((item) => item.role === "trajectory")!;
    const request = {
      schemaVersion: TrajectoryInspectionSchemaVersion,
      artifact: trajectory,
      expectedAtomCount: 999,
      expectedFrameCount: 999,
      periodicBoxRequired: false,
    };
    expect(await inspector.inspect(request)).toMatchObject({ atomCount: 3, frameCount: 5 });
    await expect(
      inspector.inspect({ ...request, artifact: { ...trajectory, evidenceRef: "foreign" } }),
    ).rejects.toThrow(/outside/);
  });

  test("caller cannot disable the stage's periodic box requirement for the actual vacuum smoke", async () => {
    const f = await fixture();
    const observed = await f.inspector().inspectStage(f.input);
    expect(observed.integrityStatus).toBe("failed");
    expect(observed.diagnostics.join(" ")).toContain(
      "periodic box required by the authorized stage",
    );
    expect(observed.trajectories[0]).toMatchObject({ frameCount: 5, hasPeriodicBox: false });
    const inspector = await f.inspector().trajectoryInspector(f.input);
    expect(
      await inspector.inspect({
        schemaVersion: TrajectoryInspectionSchemaVersion,
        artifact: f.result.artifacts.find((item) => item.role === "trajectory")!,
        expectedAtomCount: 3,
        expectedFrameCount: 5,
        periodicBoxRequired: false,
      }),
    ).toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "amber_canonical_integrity_failure", severity: "error" }),
      ]),
    });
  });

  test("a periodic dynamic restart without velocities or timestamp cannot pass continuation integrity", async () => {
    const source = readFileSync(join(smoke, "water.inpcrd"), "ascii");
    const f = await fixture({
      periodic: true,
      restart: Buffer.from(
        source + " 20.0000000 30.0000000 40.0000000 90.0000000 90.0000000 90.0000000\n",
      ),
    });
    const inspected = await f.inspector().inspectStage(f.input);
    expect(inspected.integrityStatus).toBe("failed");
    expect(inspected.diagnostics).toContain("Dynamic restart lacks byte-verified velocities");
    expect(inspected.diagnostics).toContain(
      "Restart decoded time differs from the exact stage endpoint",
    );
  });

  test("a periodic trajectory cannot hide a restart without its required box", async () => {
    const f = await fixture({ periodic: true, restart: readFileSync(join(smoke, "md.rst7")) });
    const observed = await f.inspector().inspectStage(f.input);
    expect(observed.integrityStatus).toBe("failed");
    expect(observed.diagnostics).toContain(
      "restart is missing a complete periodic box required by the authorized stage",
    );
  });

  test("real minimization table remains a parse without convergence assessment", async () => {
    const f = await fixture({ minimization: true });
    const observed = await f.inspector().inspectStage(f.input);
    expect(
      observed.outputs.find((item) => item.artifact.role === "mdout")?.minimization,
    ).toMatchObject({
      status: "completed",
      convergenceStatus: "not_assessed",
      final: { step: 16 },
    });
  });

  test.each([
    "mission",
    "receipt",
    "request",
    "evidence",
    "evidence_receipt",
    "role",
    "size",
    "uri",
    "input",
    "atommap",
  ] as const)("rejects forged %s authority before decoding", async (attack) => {
    const f = await fixture();
    if (attack === "mission") {
      f.result.missionId = "foreign";
      f.result.resultDigest = computeMdStageResultDigest(f.result);
    }
    if (attack === "receipt") f.receipt.requestDigest = D("0");
    if (attack === "request") f.operation.requestDigest = D("0");
    if (attack === "evidence") f.provenance.evidence[1]!.workUnitId = "foreign";
    if (attack === "evidence_receipt") f.provenance.evidence[1]!.sourceId = "other-attempt-receipt";
    if (attack === "role") f.provenance.evidence[1]!.kind = "trajectory";
    if (attack === "size") f.provenance.evidence[1]!.sizeBytes! += 1;
    if (attack === "uri") f.provenance.evidence[1]!.uri = "/etc/passwd";
    if (attack === "input") f.provenance.workUnits[0]!.inputRefs = [];
    if (attack === "atommap") f.atomMap.mapDigest = D("0");
    await expect(
      f.inspector(undefined, "/missing/python").inspectStage(f.input),
    ).rejects.not.toThrow(/decoder/);
  });

  test("same-count topology order mismatch cannot supply a clean QC inspection", async () => {
    const f = await fixture({ swappedAtoms: true });
    const observed = await f.inspector().inspectStage(f.input);
    expect(observed.integrityStatus).toBe("failed");
    expect(observed.diagnostics.join(" ")).toContain("atom order");
    const inspector = await f.inspector().trajectoryInspector(f.input);
    const inspected = await inspector.inspect({
      schemaVersion: TrajectoryInspectionSchemaVersion,
      artifact: f.result.artifacts.find((item) => item.role === "trajectory")!,
      expectedAtomCount: 3,
      expectedFrameCount: 5,
      periodicBoxRequired: false,
    });
    expect(inspected).toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "amber_canonical_integrity_failure", severity: "error" }),
      ]),
    });
  });

  test("truncated actual NetCDF is retained as failed decoded evidence", async () => {
    const bytes = readFileSync(join(smoke, "md.nc"));
    const f = await fixture({ trajectory: bytes.subarray(0, bytes.length - 8) });
    const observed = await f.inspector().inspectStage(f.input);
    expect(observed.integrityStatus).toBe("failed");
    expect(observed.trajectories[0]).toMatchObject({
      readStatus: "truncated",
      inspectionLevel: "decoded_netcdf",
    });
  });

  test.each(["shifted", "uniform_wrong_cadence", "gap"] as const)(
    "rejects real trajectory %s times against the durable stage cadence",
    async (variant) => {
      const bytes = Buffer.from(readFileSync(join(smoke, "md.nc")));
      for (let index = 1; index <= 5; index++) {
        const before = Buffer.alloc(4);
        before.writeFloatBE(index * 0.001);
        const offset = bytes.indexOf(before);
        expect(offset).toBeGreaterThanOrEqual(0);
        bytes.writeFloatBE(
          variant === "shifted"
            ? 1 + index * 0.001
            : variant === "uniform_wrong_cadence"
              ? index * 0.01
              : index === 3
                ? 0.0035
                : index * 0.001,
          offset,
        );
      }
      const f = await fixture({ trajectory: bytes });
      const inspected = await f.inspector().inspectStage(f.input);
      expect(inspected.integrityStatus).toBe("failed");
      expect(inspected.diagnostics.join(" ")).toContain("authorized stage interval/cadence");
      expect(inspected.scientificVerdict).toBe("not_evaluated");
    },
  );

  test("detects a changed object at its CAS digest", async () => {
    const f = await fixture();
    const output = f.result.artifacts[0]!;
    const path = join(
      f.root,
      "objects/sha256",
      output.contentDigest.slice(0, 2),
      output.contentDigest,
    );
    chmodSync(path, 0o600);
    writeFileSync(path, "corrupt");
    await expect(f.inspector().inspectStage(f.input)).rejects.toThrow(
      /bytes do not match their address/,
    );
  });

  test("enforces byte limits before launching a decoder and fails closed on process failure", async () => {
    const f = await fixture();
    await expect(f.inspector({ maxArtifactBytes: 10 }).inspectStage(f.input)).rejects.toThrow(
      /byte limit/,
    );
    await expect(f.inspector(undefined, "/missing/python").inspectStage(f.input)).rejects.toThrow(
      /decoder failed/,
    );
    expect(() => f.inspector({ memoryBytes: 1 })).toThrow(/limits/);
    expect(() => f.inspector(undefined, "python")).toThrow(/absolute/);
  });
});
