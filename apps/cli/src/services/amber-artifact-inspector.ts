import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  assertMdStageOperationRequestAuthority,
  MdResultCollectionSchema,
  type ContentAddressedArtifactStore,
  type MdProjectionStore,
  type ScientificStore,
} from "@eigengrid/mission-runtime";
import {
  assertAmberByteInspection,
  assertAmberMinimizationParseResult,
  bindAmberTrajectoryArtifactInspection,
  TrajectoryInspectionRequestSchema,
  type AmberByteInspection,
  type AmberMinimizationParseResult,
  type TrajectoryInspector,
  type TrajectoryInspectionResult,
} from "@eigengrid/md-analysis";
import { runCommand } from "@eigengrid/runners";
import {
  EvidenceReferenceSchema,
  ExternalOperationSchema,
  IdSchema,
  MdExecutionBindingParametersSchema,
  OperationReceiptSchema,
  assertAtomMapDigest,
  assertMdStageResultDigest,
  assertMdStageSpecDigest,
  canonicalJson,
  digestCanonical,
  type AtomMap,
  type EvidenceReference,
  type MdArtifactReference,
  type MdStageResult,
  type MdStageSpec,
} from "@eigengrid/scientific-schema";

export interface AmberArtifactInspectionLimits {
  maxArtifactBytes: number;
  maxTotalBytes: number;
  timeoutMs: number;
  memoryBytes: number;
  cpuSeconds: number;
}

const DEFAULT_LIMITS: AmberArtifactInspectionLimits = {
  maxArtifactBytes: 4 * 1024 ** 3,
  maxTotalBytes: 8 * 1024 ** 3,
  timeoutMs: 300_000,
  memoryBytes: 512 * 1024 ** 2,
  cpuSeconds: 240,
};

export interface CanonicalAmberArtifactInspectorOptions {
  /** Internal coordinator scope, established before this service is exposed.
   * This is not an HTTP/user authorization boundary. A caller cannot change
   * mission/work-unit scope, supply paths or invent an observation/receipt. */
  missionId: string;
  workUnitId: string;
  store: Pick<ScientificStore, "getMissionProvenance">;
  md: Pick<MdProjectionStore, "getStageResult" | "getStageSpec" | "getAtomMap">;
  objects: ContentAddressedArtifactStore;
  /** Site-controlled Python environment containing eigengrid_chem. */
  pythonExecutable: string;
  limits?: Partial<AmberArtifactInspectionLimits>;
}

export interface CanonicalAmberStageInspection {
  schemaVersion: "eigengrid.canonical-amber-stage-inspection/v1";
  missionId: string;
  workUnitId: string;
  stageResultId: string;
  stageResultDigest: string;
  operationId: string;
  operationReceiptId: string;
  operationRequestDigest: string;
  atomMap: { id: string; revision: number; mapDigest: string };
  topology: { artifact: MdArtifactReference; observation: AmberByteInspection };
  outputs: Array<{
    artifact: MdArtifactReference;
    observation?: AmberByteInspection;
    minimization?: AmberMinimizationParseResult;
  }>;
  trajectories: TrajectoryInspectionResult[];
  /** Identity checks are separate from scientific QC, which is never granted here. */
  integrityStatus: "verified" | "failed";
  diagnostics: string[];
  scientificVerdict: "not_evaluated";
  inspectionDigest: string;
}

function exactOne<T>(values: readonly T[], label: string): T {
  if (values.length !== 1) throw new Error(`AMBER inspection requires exactly one ${label}`);
  return values[0]!;
}

function checkedLimits(overrides: Partial<AmberArtifactInspectionLimits> = {}) {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error("Invalid AMBER inspection limit");
  }
  if (
    limits.timeoutMs > 600_000 ||
    limits.cpuSeconds > 600 ||
    limits.memoryBytes < 64 * 1024 ** 2 ||
    limits.memoryBytes > 8 * 1024 ** 3 ||
    limits.maxArtifactBytes > limits.maxTotalBytes
  )
    throw new Error("AMBER inspection limits outside supported range");
  return Object.freeze(limits);
}

/** Decode existing, collection-bound scientific outputs. No submission,
 * collection, replication acknowledgement, assessment or DB write is possible. */
export class CanonicalAmberArtifactInspector {
  private readonly limits: Readonly<AmberArtifactInspectionLimits>;
  private readonly options: CanonicalAmberArtifactInspectorOptions;

  constructor(options: CanonicalAmberArtifactInspectorOptions) {
    IdSchema.parse(options.missionId);
    IdSchema.parse(options.workUnitId);
    if (!isAbsolute(options.pythonExecutable)) {
      throw new Error("AMBER inspector requires a site-controlled absolute Python executable");
    }
    this.limits = checkedLimits(options.limits);
    this.options = { ...options };
  }

  async inspectStage(input: {
    stageResultId: string;
    atomMapId: string;
    atomMapRevision: number;
  }): Promise<CanonicalAmberStageInspection> {
    const saved = await this.options.md.getStageResult(input.stageResultId);
    if (!saved) throw new Error("AMBER stage result was not collected");
    return this.inspectBoundResult(input, saved, true);
  }

  /** Bootstrap only from an adopted canonical collection. Candidate interval and
   * validation fields are hypotheses, not durable scientific observations. The
   * caller derives and validates them from returned actual bytes before admission.
   */
  async inspectCollectedCandidate(input: {
    result: MdStageResult;
    atomMapId: string;
    atomMapRevision: number;
  }): Promise<CanonicalAmberStageInspection> {
    return this.inspectBoundResult(
      {
        stageResultId: input.result.id,
        atomMapId: input.atomMapId,
        atomMapRevision: input.atomMapRevision,
      },
      input.result,
      false,
    );
  }

  private async inspectBoundResult(
    input: { stageResultId: string; atomMapId: string; atomMapRevision: number },
    saved: MdStageResult,
    checkInterval: boolean,
  ): Promise<CanonicalAmberStageInspection> {
    const { missionId, workUnitId, store, md } = this.options;
    IdSchema.parse(input.stageResultId);
    IdSchema.parse(input.atomMapId);
    if (!Number.isSafeInteger(input.atomMapRevision) || input.atomMapRevision < 1)
      throw new Error("AMBER inspection requires an exact AtomMap revision");
    const result = assertMdStageResultDigest(saved);
    if (
      result.id !== input.stageResultId ||
      result.missionId !== missionId ||
      result.workUnitId !== workUnitId
    )
      throw new Error("AMBER stage result is outside the inspector's mission/work-unit scope");
    const provenance = await store.getMissionProvenance(missionId);
    if (provenance.mission.id !== missionId) throw new Error("AMBER mission provenance mismatch");
    const workUnit = exactOne(
      provenance.workUnits.filter((item) => item.id === workUnitId),
      "WorkUnit",
    );
    if (workUnit.missionId !== missionId) throw new Error("AMBER WorkUnit mission mismatch");
    const operation = ExternalOperationSchema.parse(
      exactOne(
        provenance.operations.filter((item) => item.id === result.operationId),
        "operation",
      ),
    );
    const receipt = OperationReceiptSchema.parse(
      exactOne(
        provenance.receipts.filter((item) => item.id === result.operationReceiptId),
        "receipt",
      ),
    );
    if (
      operation.missionId !== missionId ||
      operation.workUnitId !== workUnitId ||
      operation.kind !== "md_stage_execution" ||
      operation.state !== "confirmed" ||
      operation.receiptId !== receipt.id ||
      receipt.operationId !== operation.id ||
      receipt.status !== "confirmed" ||
      receipt.requestDigest !== operation.requestDigest ||
      operation.requestDigest !== digestCanonical(operation.request)
    )
      throw new Error("AMBER operation/receipt provenance is not exact and confirmed");
    assertMdStageOperationRequestAuthority(workUnit, operation.request, result);
    if (!checkInterval) {
      const collected = exactOne(
        provenance.observations.filter(
          (o) => o.id === `md-collection-${digestCanonical({ operationId: operation.id })}`,
        ),
        "adopted collection",
      );
      const collection = MdResultCollectionSchema.parse(collected.payload);
      if (
        collection.operationId !== operation.id ||
        collection.outcome !== "completed" ||
        collection.artifactStatus !== "complete" ||
        digestCanonical(collection) !== receipt.detailDigest ||
        collected.workUnitId !== workUnit.id ||
        collected.missionId !== missionId ||
        collected.source.id !== receipt.id
      )
        throw new Error("Unadmitted AMBER candidate lacks its exact terminal collection receipt");
      for (const artifact of result.artifacts) {
        const actual = collection.artifacts.find((a) => a.role === `output_stage_${artifact.role}`);
        if (
          !actual ||
          actual.sha256 !== artifact.contentDigest ||
          actual.sizeBytes !== artifact.sizeBytes ||
          actual.mediaType !== artifact.mediaType ||
          actual.kind !== artifact.role ||
          artifact.evidenceRef !==
            `evidence-md-${digestCanonical({ operationId: operation.id, role: actual.role })}`
        )
          throw new Error(
            "Unadmitted AMBER candidate invented an output outside its actual collection",
          );
      }
    }
    const binding = MdExecutionBindingParametersSchema.parse(workUnit.protocolFragment.parameters);
    const stageValue = await md.getStageSpec(result.stageId, result.stageRevision);
    if (!stageValue) throw new Error("AMBER stage specification was not found");
    const stage = assertMdStageSpecDigest(stageValue);
    if (
      stage.id !== result.stageId ||
      stage.revision !== result.stageRevision ||
      stage.stageDigest !== result.stageDigest ||
      stage.kind !== result.stageKind ||
      stage.system.id !== binding.system.id ||
      stage.system.revision !== binding.system.revision ||
      stage.system.manifestDigest !== binding.system.digest ||
      result.protocolId !== binding.protocol.id ||
      result.protocolRevision !== binding.protocol.revision ||
      result.protocolDigest !== binding.protocol.digest ||
      result.replicaSetId !== binding.replicaSegment?.replicaSetId ||
      result.replicaSetRevision !== binding.replicaSegment?.replicaSetRevision ||
      result.replicaSetDigest !== binding.replicaSegment?.replicaSetDigest ||
      result.replicaId !== binding.replicaSegment?.replicaId ||
      result.segmentIndex !== binding.replicaSegment?.segmentIndex ||
      (stage.kind === "production" &&
        result.parentRestartDigest !== binding.parentRestart?.contentDigest)
    )
      throw new Error("AMBER stage/system/protocol provenance mismatch");
    const atomMapValue = await md.getAtomMap(missionId, input.atomMapId, input.atomMapRevision);
    if (!atomMapValue) throw new Error("AMBER AtomMap lacks canonical publication authority");
    const atomMap = assertAtomMapDigest(atomMapValue);
    this.assertAtomMap(atomMap, input, stage.system);
    const topology = exactOne(
      stage.inputs.filter((item) => item.role === "topology"),
      "topology input",
    );
    if (topology.contentDigest !== stage.system.topologyDigest)
      throw new Error("AMBER topology does not belong to the exact system");
    const artifacts = [topology, ...result.artifacts];
    if (
      new Set(artifacts.map((item) => item.artifactId)).size !== artifacts.length ||
      new Set(artifacts.map((item) => item.evidenceRef)).size !== artifacts.length ||
      new Set(result.artifacts.map((item) => item.role)).size !== result.artifacts.length
    )
      throw new Error("AMBER artifacts contain duplicate identity, evidence or role");

    let totalBytes = 0;
    // Validate every provenance edge before reading any CAS byte.
    const evidenceById = new Map<string, EvidenceReference>();
    for (const artifact of artifacts) {
      const evidence = EvidenceReferenceSchema.parse(
        exactOne(
          provenance.evidence.filter((item) => item.id === artifact.evidenceRef),
          "artifact evidence",
        ),
      );
      if (
        !evidence.immutable ||
        evidence.missionId !== missionId ||
        (artifact !== topology && evidence.workUnitId !== workUnitId) ||
        (artifact !== topology && evidence.sourceId !== receipt.id) ||
        (artifact === topology && !workUnit.inputRefs.includes(evidence.id)) ||
        evidence.kind !== artifact.role ||
        evidence.contentDigest !== artifact.contentDigest ||
        evidence.uri !== this.options.objects.uriForDigest(artifact.contentDigest) ||
        evidence.mediaType !== artifact.mediaType ||
        evidence.sizeBytes === undefined ||
        artifact.sizeBytes === undefined ||
        evidence.sizeBytes !== artifact.sizeBytes
      )
        throw new Error(
          "AMBER artifact evidence is outside its exact role, size, digest or lineage",
        );
      if (evidence.sizeBytes > this.limits.maxArtifactBytes)
        throw new Error("AMBER artifact exceeds the configured byte limit");
      totalBytes += evidence.sizeBytes;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > this.limits.maxTotalBytes)
        throw new Error("AMBER inspection exceeds the configured total byte limit");
      evidenceById.set(evidence.id, evidence);
    }
    const topologyObservation = assertAmberByteInspection(await this.decode(topology, "prmtop"));
    const diagnostics: string[] = [];
    const expectedAtomIdentity = digestCanonical(
      [...atomMap.entries]
        .sort((left, right) => left.systemAtomIndex - right.systemAtomIndex)
        .map((entry) => ({ atom: entry.atomName, residue: entry.residueName })),
    );
    if (topologyObservation.atomIdentityDigest !== expectedAtomIdentity)
      diagnostics.push("Topology atom order/names differ from the canonical AtomMap");
    if (topologyObservation.atomCount !== atomMap.atomCount)
      diagnostics.push("Topology atom count differs from the canonical AtomMap");
    if (stage.nonbonded.periodicBoundary && topologyObservation.hasPeriodicBox !== true)
      diagnostics.push("Topology is missing the periodic box required by the authorized stage");
    if (this.invalidObservation(topologyObservation))
      diagnostics.push("Topology bytes failed inspection");
    const outputs: CanonicalAmberStageInspection["outputs"] = [];
    const trajectories: TrajectoryInspectionResult[] = [];
    for (const artifact of result.artifacts) {
      if (artifact.role === "trajectory" || artifact.role === "restart") {
        const observation = assertAmberByteInspection(await this.decode(artifact, artifact.role));
        if (observation.atomCount !== atomMap.atomCount)
          diagnostics.push(`${artifact.role} atom count differs from the canonical AtomMap`);
        if (this.invalidObservation(observation))
          diagnostics.push(`${artifact.role} bytes failed inspection`);
        if (
          stage.nonbonded.periodicBoundary &&
          (observation.hasPeriodicBox !== true || observation.cell.status !== "complete")
        )
          diagnostics.push(
            `${artifact.role} is missing a complete periodic box required by the authorized stage`,
          );
        if (checkInterval && artifact.role === "trajectory") {
          diagnostics.push(...this.trajectoryTimeDiagnostics(stage, result, observation));
        }
        if (checkInterval && artifact.role === "restart" && stage.kind !== "minimization") {
          if (observation.hasVelocities !== true)
            diagnostics.push("Dynamic restart lacks byte-verified velocities");
          const precision = observation.time.precisionPs;
          if (
            observation.time.lastPs === null ||
            precision === null ||
            Math.abs(observation.time.lastPs - result.endTimePs) > Math.max(precision * 4, 1e-9)
          )
            diagnostics.push("Restart decoded time differs from the exact stage endpoint");
        }
        outputs.push({ artifact, observation });
        if (artifact.role === "trajectory")
          trajectories.push(
            bindAmberTrajectoryArtifactInspection(observation, artifact, receipt.id),
          );
      } else if (artifact.role === "mdout" && result.stageKind === "minimization") {
        const minimization = assertAmberMinimizationParseResult(
          await this.decode(artifact, "minimization"),
        );
        outputs.push({ artifact, minimization });
        if (minimization.status !== "completed")
          diagnostics.push("Minimization output is incomplete");
      } else {
        // mdinfo/MD mdout are integrity verified here; telemetry belongs to AM-04.
        const verified = await this.options.objects.verify(artifact.contentDigest, {
          maxBytes: artifact.sizeBytes!,
        });
        if (verified.sizeBytes !== evidenceById.get(artifact.evidenceRef)!.sizeBytes)
          throw new Error("AMBER artifact CAS size differs from canonical evidence");
        outputs.push({ artifact });
      }
    }
    const material = {
      schemaVersion: "eigengrid.canonical-amber-stage-inspection/v1" as const,
      missionId,
      workUnitId,
      stageResultId: result.id,
      stageResultDigest: result.resultDigest,
      operationId: operation.id,
      operationReceiptId: receipt.id,
      operationRequestDigest: operation.requestDigest,
      atomMap: { id: atomMap.id, revision: atomMap.revision, mapDigest: atomMap.mapDigest },
      topology: { artifact: topology, observation: topologyObservation },
      outputs,
      trajectories,
      integrityStatus: diagnostics.length ? ("failed" as const) : ("verified" as const),
      diagnostics,
      scientificVerdict: "not_evaluated" as const,
    };
    return { ...material, inspectionDigest: digestCanonical(material) };
  }

  /** Produces the existing QC interface from a fresh canonical inspection.
   * Only exact artifacts inspected in this result are accepted. Caller-supplied
   * expected counts are never copied into observed data. */
  async trajectoryInspector(
    input: Parameters<CanonicalAmberArtifactInspector["inspectStage"]>[0],
  ): Promise<TrajectoryInspector> {
    const inspected = await this.inspectStage(input);
    return {
      async inspect(requestValue) {
        const request = TrajectoryInspectionRequestSchema.parse(requestValue);
        const artifact = inspected.outputs.find(
          (item) => item.artifact.artifactId === request.artifact.artifactId,
        )?.artifact;
        if (!artifact || canonicalJson(artifact) !== canonicalJson(request.artifact))
          throw new Error("Trajectory is outside the canonical AMBER inspection");
        const result = exactOne(
          inspected.trajectories.filter((item) => item.artifactId === artifact.artifactId),
          "decoded trajectory",
        );
        // A trajectory has no atom labels. Its order relies on the exact
        // topology + AtomMap + stage receipt, and cannot bypass a failed link.
        if (inspected.integrityStatus !== "verified")
          return {
            ...structuredClone(result),
            diagnostics: [
              ...result.diagnostics,
              {
                code: "amber_canonical_integrity_failure",
                severity: "error",
                message: inspected.diagnostics.join("; "),
                evidenceRefs: [artifact.evidenceRef],
              },
            ],
          };
        return structuredClone(result);
      },
    };
  }

  private invalidObservation(observation: AmberByteInspection): boolean {
    return (
      observation.inspectionLevel !== "decoded" ||
      observation.readStatus !== "complete" ||
      observation.finiteValues !== true ||
      observation.diagnostics.some((item) => ["error", "fatal"].includes(item.severity))
    );
  }

  private trajectoryTimeDiagnostics(
    stage: MdStageSpec,
    result: MdStageResult,
    observation: AmberByteInspection,
  ): string[] {
    // The closed Amber renderer writes a frame at each local ntwx step, with
    // no initial t=0 frame. A segment's metadata cannot supply this cadence:
    // only the exact stage authorized in its persisted operation does.
    const cadenceSteps = stage.outputs.find((item) => item.role === "trajectory")?.cadenceSteps;
    const time = observation.time;
    if (
      !cadenceSteps ||
      stage.timeStepPs === null ||
      time.firstPs === null ||
      time.lastPs === null ||
      time.precisionPs === null
    )
      return ["Trajectory lacks its authorized cadence or decoded time precision"];
    const expectedFrames = Math.floor((result.endStep - result.startStep) / cadenceSteps);
    const cadencePs = cadenceSteps * stage.timeStepPs;
    const expectedFirst = result.startTimePs + cadencePs;
    const expectedLast = result.startTimePs + expectedFrames * cadencePs;
    // Bound representation/rounding error; this is not a scientific tolerance.
    const tolerance = Math.max(
      time.precisionPs * 4,
      Number.EPSILON * Math.max(Math.abs(expectedFirst), Math.abs(expectedLast), cadencePs) * 8,
    );
    if (
      observation.frameCount !== expectedFrames ||
      time.count !== expectedFrames ||
      Math.abs(time.firstPs - expectedFirst) > tolerance ||
      Math.abs(time.lastPs - expectedLast) > tolerance ||
      (expectedFrames > 1 &&
        (time.minDeltaPs === null ||
          time.maxDeltaPs === null ||
          Math.abs(time.minDeltaPs - cadencePs) > tolerance ||
          Math.abs(time.maxDeltaPs - cadencePs) > tolerance))
    )
      return [
        "Trajectory decoded times/frame count differ from the authorized stage interval/cadence",
      ];
    return [];
  }

  private assertAtomMap(
    atomMap: AtomMap,
    input: { atomMapId: string; atomMapRevision: number },
    system: {
      id: string;
      revision: number;
      atomMapDigest: string;
      topologyDigest: string;
      coordinateDigest: string;
    },
  ) {
    if (
      atomMap.id !== input.atomMapId ||
      atomMap.revision !== input.atomMapRevision ||
      atomMap.systemManifestId !== system.id ||
      atomMap.systemManifestRevision !== system.revision ||
      atomMap.mapDigest !== system.atomMapDigest ||
      atomMap.topologyDigest !== system.topologyDigest ||
      atomMap.coordinateDigest !== system.coordinateDigest
    )
      throw new Error("AMBER AtomMap is outside the exact system/topology provenance");
  }

  private async decode(
    artifact: MdArtifactReference,
    kind: "prmtop" | "restart" | "trajectory" | "minimization",
  ): Promise<unknown> {
    const temporary = await mkdtemp(join(tmpdir(), "eigengrid-amber-inspection-"));
    const path = join(temporary, "artifact");
    try {
      const file = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const content = await this.options.objects.getStream(artifact.contentDigest, {
          maxBytes: artifact.sizeBytes!,
        });
        let length = 0;
        const hash = createHash("sha256");
        for await (const chunk of content.bytes) {
          length += chunk.byteLength;
          if (length > this.limits.maxArtifactBytes || length > artifact.sizeBytes!)
            throw new Error("AMBER CAS object exceeds its authorized size/byte limit");
          hash.update(chunk);
          let offset = 0;
          while (offset < chunk.byteLength) {
            const written = await file.write(chunk, offset, chunk.byteLength - offset);
            if (written.bytesWritten <= 0) throw new Error("AMBER private snapshot write stalled");
            offset += written.bytesWritten;
          }
        }
        if (
          length !== artifact.sizeBytes ||
          content.sizeBytes !== length ||
          hash.digest("hex") !== artifact.contentDigest
        )
          throw new Error("AMBER CAS snapshot digest/size differs from canonical evidence");
        await file.chmod(0o400);
      } finally {
        await file.close();
      }
      const processResult = await runCommand(
        this.options.pythonExecutable,
        [
          "-B",
          "-m",
          "eigengrid_chem.amber.inspection_worker",
          kind,
          path,
          String(this.limits.memoryBytes),
          String(this.limits.cpuSeconds),
        ],
        { timeout: this.limits.timeoutMs, maxOutputBytes: 8 * 1024 ** 2, maxErrorBytes: 16 * 1024 },
      );
      if (
        processResult.exitCode !== 0 ||
        processResult.timedOut ||
        processResult.stdoutTruncated ||
        processResult.stderrTruncated
      )
        throw new Error("AMBER byte decoder failed or exceeded its resource limits");
      const observed =
        kind === "minimization"
          ? assertAmberMinimizationParseResult(JSON.parse(processResult.stdout))
          : assertAmberByteInspection(JSON.parse(processResult.stdout));
      const parser = "decoder" in observed ? observed.decoder : observed.parser;
      if (parser.id !== "eigengrid_chem.amber.byte-inspector" || parser.version !== "0.1.3")
        throw new Error("AMBER byte decoder identity/version differs from the qualified contract");
      if (
        observed.observedContentDigest !== artifact.contentDigest ||
        observed.byteLength !== artifact.sizeBytes ||
        ("artifactKind" in observed && observed.artifactKind !== kind)
      )
        throw new Error("AMBER decoder response does not match the authorized CAS snapshot");
      return observed;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
