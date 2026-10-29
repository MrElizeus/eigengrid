import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  ActorIdentitySchema,
  AtomMapPublicationRequestSchema,
  AtomMapPublicationRequestSchemaVersion,
  AtomMapPublicationRequestSchemaVersionV1,
  BiomolecularMaterialPublicationBindingSchema,
  BiomolecularSystemBuildRequestSchema,
  BiomolecularSystemBuildRequestSchemaVersion,
  EvidenceReferenceSchema,
  ForceFieldStackManifestSchema,
  canonicalJson,
  digestCanonical,
  type ActorIdentity,
  type ApprovalRequest,
  type EvidenceReference,
  type ExternalOperation,
  type OperationReceipt,
  type WorkUnit,
} from "@eigengrid/scientific-schema";
import {
  AMBER_PREPARED_SYSTEM_MEDIA_TYPES,
  AmberPreparedSystemCasBundleSchema,
  AmberPreparedSystemQcObservationSchema,
  AmberPreparedSystemPackageSchema,
  assertAmberPreparedSystemPackage,
  atomMapArtifactBytes,
  parameterDigestsForStack,
} from "@eigengrid/amber-adapter";
import type {
  ContentAddressedArtifactStore,
  MdProjectionStore,
  MissionProvenance,
  ScientificStore,
} from "@eigengrid/mission-runtime";
import {
  assertReceiptDerivedFrozenSource,
  frozenSourceManifestDigest,
  type FrozenPreparationSourceProof,
} from "./amber-frozen-material";

const manifestFile = "package.json";
const packageLimit = 64 * 1024 * 1024;
const atomMapLimit = 256 * 1024 * 1024;
const qcReportLimit = 8 * 1024 * 1024;
const chunkSize = 1024 * 1024;

function unchanged(before: BigIntStats, after: BigIntStats): boolean {
  return ["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"].every(
    (key) => before[key as keyof BigIntStats] === after[key as keyof BigIntStats],
  );
}

async function* stableFileBytes(
  path: string,
  expectedSize: number,
  maximumSize: number,
): AsyncGenerator<Uint8Array> {
  const absolute = resolve(path);
  const before = await lstat(absolute, { bigint: true });
  if (
    !before.isFile() ||
    before.size !== BigInt(expectedSize) ||
    before.size < 1n ||
    before.size > BigInt(maximumSize)
  ) {
    throw new Error("Prepared-system input is not the declared regular file and size");
  }
  const handle = await open(
    absolute,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (!unchanged(before, await handle.stat({ bigint: true })))
      throw new Error("Prepared-system input changed while opening");
    let offset = 0;
    while (offset < expectedSize) {
      const buffer = Buffer.alloc(Math.min(chunkSize, expectedSize - offset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, offset);
      if (bytesRead === 0) throw new Error("Prepared-system input was truncated");
      offset += bytesRead;
      yield buffer.subarray(0, bytesRead);
    }
    if (
      !unchanged(before, await handle.stat({ bigint: true })) ||
      !unchanged(before, await lstat(absolute, { bigint: true }))
    ) {
      throw new Error("Prepared-system input changed during import");
    }
  } finally {
    await handle.close();
  }
}

async function readBoundedJson(path: string, maximumSize: number): Promise<unknown> {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.size < 1n || before.size > BigInt(maximumSize))
    throw new Error("Prepared-system package manifest exceeds its file limit");
  const chunks: Uint8Array[] = [];
  for await (const chunk of stableFileBytes(path, Number(before.size), maximumSize))
    chunks.push(chunk);
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
  ) as unknown;
}

function operationReceipt(
  provenance: MissionProvenance,
  operation: ExternalOperation,
): OperationReceipt {
  const receipt = provenance.receipts.find((item) => item.id === operation.receiptId);
  if (
    operation.state !== "confirmed" ||
    !operation.receiptId ||
    !receipt ||
    receipt.operationId !== operation.id ||
    receipt.requestDigest !== operation.requestDigest ||
    receipt.status !== "confirmed" ||
    digestCanonical(operation.request) !== operation.requestDigest
  ) {
    throw new Error("Prepared-system import requires the exact confirmed operation receipt");
  }
  return receipt;
}

function assertApprovedOperation(
  provenance: MissionProvenance,
  operation: ExternalOperation,
  receipt: OperationReceipt,
): ApprovalRequest {
  const approval = provenance.approvals.find(
    (item) =>
      item.subjectType === "operation" &&
      item.subjectId === operation.id &&
      item.subjectVersion === 1 &&
      item.subjectRevision === 1 &&
      item.state === "approved" &&
      item.payloadDigest === operation.requestDigest &&
      item.response?.decision === "approved" &&
      item.response.payloadDigest === operation.requestDigest,
  );
  if (
    !approval?.response?.decidedAt ||
    Date.parse(approval.response.decidedAt) > Date.parse(receipt.recordedAt)
  ) {
    throw new Error("Prepared-system publication lacks prior approval for its exact request");
  }
  return approval;
}

function requiredCapabilityWorkUnit(
  provenance: MissionProvenance,
  workUnitId: string,
  capabilityId: string,
): WorkUnit {
  const workUnit = provenance.workUnits.find((item) => item.id === workUnitId);
  if (
    !workUnit ||
    workUnit.missionId !== provenance.mission.id ||
    workUnit.kind !== "scientific_capability" ||
    !["executing", "observing", "succeeded"].includes(workUnit.state) ||
    workUnit.protocolFragment.kind !== "scientific_capability" ||
    workUnit.protocolFragment.capability.id !== capabilityId ||
    workUnit.executionPolicy.capability !== capabilityId ||
    workUnit.executionPolicy.riskClass !== 3 ||
    workUnit.protocolFragment.riskClass !== 3
  ) {
    throw new Error("Prepared-system import lacks its exact active scientific WorkUnit");
  }
  return workUnit;
}

function assertTypedPreparationEffectBinding(input: {
  provenance: MissionProvenance;
  operation: ExternalOperation;
  workUnit: WorkUnit;
  request:
    | ReturnType<typeof BiomolecularSystemBuildRequestSchema.parse>
    | ReturnType<typeof AtomMapPublicationRequestSchema.parse>;
}): void {
  const { provenance, operation, workUnit, request } = input;
  if (
    request.schemaVersion !== BiomolecularSystemBuildRequestSchemaVersion &&
    request.schemaVersion !== AtomMapPublicationRequestSchemaVersion
  ) {
    return;
  }
  if (
    request.missionId !== provenance.mission.id ||
    request.missionId !== operation.missionId ||
    request.planId !== workUnit.planId ||
    request.planVersion !== workUnit.planVersion ||
    request.workUnitId !== workUnit.id ||
    request.intendedJobId !== workUnit.jobId ||
    request.intendedAttemptId !== workUnit.attemptId ||
    !workUnit.inputRefs.includes(request.inputEvidenceId)
  ) {
    throw new Error(
      "Prepared-system operation does not bind its exact coordinator and plan identity",
    );
  }
  const sourceEvidence = provenance.evidence.find(
    (reference) => reference.id === request.inputEvidenceId,
  );
  if (
    !sourceEvidence ||
    !sourceEvidence.immutable ||
    sourceEvidence.missionId !== provenance.mission.id ||
    sourceEvidence.contentDigest !== request.inputContentDigest
  ) {
    throw new Error("Prepared-system operation input is not the exact immutable mission evidence");
  }
}

function assertQcObservations(input: {
  provenance: MissionProvenance;
  workUnit: WorkUnit;
  packageValue: ReturnType<typeof assertAmberPreparedSystemPackage>;
}): void {
  const { provenance, workUnit, packageValue: prepared } = input;
  const expectedEvidence = [
    prepared.artifacts.topology.evidenceRef,
    prepared.artifacts.coordinates.evidenceRef,
    prepared.artifacts.atomMap.evidenceRef,
    prepared.artifacts.snapshotPdb.evidenceRef,
    prepared.artifacts.qcReport.evidenceRef,
  ].sort();
  for (const type of ["artifact_integrity", "topology_integrity"] as const) {
    const observed = provenance.observations.filter((item) => {
      if (
        item.workUnitId !== workUnit.id ||
        item.type !== type ||
        item.source.kind !== "validator" ||
        item.source.id !== prepared.qc.validatorId ||
        item.qualityFlags.length !== 0 ||
        canonicalJson([...item.evidenceRefs].sort()) !== canonicalJson(expectedEvidence)
      ) {
        return false;
      }
      const payload = AmberPreparedSystemQcObservationSchema.safeParse(item.payload);
      return (
        payload.success &&
        payload.data.packageDigest === prepared.packageDigest &&
        payload.data.qcReportDigest === prepared.artifacts.qcReport.sha256
      );
    });
    if (observed.length !== 1 || !observed[0]) {
      throw new Error("Prepared-system WorkUnit lacks one exact passing package-QC observation");
    }
    const payload = AmberPreparedSystemQcObservationSchema.parse(observed[0]!.payload);
    if (
      payload.packageDigest !== prepared.packageDigest ||
      payload.qcReportDigest !== prepared.artifacts.qcReport.sha256 ||
      payload.topologyDigest !== prepared.qc.topologyDigest ||
      payload.coordinatesDigest !== prepared.qc.coordinatesDigest ||
      payload.atomMapDigest !== prepared.qc.atomMapDigest ||
      payload.forceFieldStackDigest !== prepared.qc.forceFieldStackDigest ||
      payload.validatorId !== prepared.qc.validatorId ||
      payload.validatorVersion !== prepared.qc.validatorVersion
    ) {
      throw new Error("Prepared-system QC observation differs from the approved package report");
    }
  }
}

export function assertPreparedSystemMissionAuthority(input: {
  actor: ActorIdentity;
  provenance: MissionProvenance;
  packageValue: unknown;
  forceFieldStack: unknown;
  frozenSourceProof?: FrozenPreparationSourceProof;
}): {
  packageValue: ReturnType<typeof assertAmberPreparedSystemPackage>;
  buildWorkUnit: WorkUnit;
  buildOperation: ExternalOperation;
  buildReceipt: OperationReceipt;
  buildApproval: ApprovalRequest;
  atomMapWorkUnit: WorkUnit;
  atomMapOperation: ExternalOperation;
  atomMapReceipt: OperationReceipt;
  atomMapApproval: ApprovalRequest;
  packageEvidenceId: string;
} {
  const actor = ActorIdentitySchema.parse(input.actor);
  const prepared = assertAmberPreparedSystemPackage(input.packageValue);
  const { provenance } = input;
  if (
    actor.kind !== "human" ||
    provenance.mission.id !== prepared.missionId ||
    prepared.systemManifest.missionId !== prepared.missionId ||
    prepared.systemManifest.provenance.operationReceiptId === undefined ||
    prepared.systemManifest.provenance.operationId === undefined
  ) {
    throw new Error("Prepared-system package is outside the authenticated mission");
  }
  const stack = ForceFieldStackManifestSchema.parse(input.forceFieldStack);
  if (
    canonicalJson(stack) !== canonicalJson(prepared.forceFieldStack) ||
    stack.stackDigest !== prepared.systemManifest.forceFieldStack.digest ||
    canonicalJson(parameterDigestsForStack(stack)) !==
      canonicalJson(parameterDigestsForStack(prepared.forceFieldStack))
  ) {
    throw new Error("Prepared-system force-field parameters differ from durable mission authority");
  }

  const buildWorkUnit = requiredCapabilityWorkUnit(
    provenance,
    prepared.workUnitId,
    "biomolecular.build-system",
  );
  if (
    buildWorkUnit.protocolFragment.kind !== "scientific_capability" ||
    buildWorkUnit.protocolFragment.parameters.manifestId !== prepared.systemManifest.id ||
    buildWorkUnit.protocolFragment.parameters.manifestRevision !==
      prepared.systemManifest.revision ||
    !["topology", "coordinates", "atom_map"].every((kind) =>
      buildWorkUnit.outputContract.requiredEvidenceKinds.includes(kind),
    ) ||
    !["artifact_integrity", "topology_integrity"].every((kind) =>
      buildWorkUnit.outputContract.requiredObservationKinds.includes(kind),
    )
  ) {
    throw new Error("Prepared-system package is outside its exact system-build WorkUnit contract");
  }
  const buildOperation = provenance.operations.find(
    (item) => item.id === prepared.systemManifest.provenance.operationId,
  );
  if (
    !buildOperation ||
    buildOperation.missionId !== prepared.missionId ||
    buildOperation.workUnitId !== buildWorkUnit.id ||
    buildOperation.kind !== "system_preparation"
  ) {
    throw new Error("Prepared-system manifest lacks its exact system-preparation operation");
  }
  const buildRequest = BiomolecularSystemBuildRequestSchema.parse(buildOperation.request);
  assertTypedPreparationEffectBinding({
    provenance,
    operation: buildOperation,
    workUnit: buildWorkUnit,
    request: buildRequest,
  });
  if (
    buildRequest.workUnitId !== buildWorkUnit.id ||
    buildWorkUnit.protocolFragment.kind !== "scientific_capability" ||
    canonicalJson(buildRequest.capability) !==
      canonicalJson(buildWorkUnit.protocolFragment.capability) ||
    buildRequest.systemManifest.id !== prepared.systemManifest.id ||
    buildRequest.systemManifest.revision !== prepared.systemManifest.revision ||
    buildRequest.parametersDigest !== digestCanonical(buildWorkUnit.protocolFragment.parameters) ||
    buildRequest.outputContractDigest !== digestCanonical(buildWorkUnit.outputContract) ||
    canonicalJson(buildRequest.forceFieldStack) !==
      canonicalJson(prepared.systemManifest.forceFieldStack) ||
    canonicalJson(buildRequest.decisionRefs) !==
      canonicalJson(prepared.systemManifest.decisionRefs) ||
    buildRequest.outputArtifacts.topology.evidenceRef !== prepared.artifacts.topology.evidenceRef ||
    buildRequest.outputArtifacts.topology.mediaType !== prepared.artifacts.topology.mediaType ||
    buildRequest.outputArtifacts.coordinates.evidenceRef !==
      prepared.artifacts.coordinates.evidenceRef ||
    buildRequest.outputArtifacts.coordinates.mediaType !==
      prepared.artifacts.coordinates.mediaType ||
    buildRequest.outputArtifacts.atomMap.evidenceRef !== prepared.artifacts.atomMap.evidenceRef ||
    buildRequest.outputArtifacts.atomMap.mediaType !== prepared.artifacts.atomMap.mediaType
  ) {
    throw new Error("Prepared-system files differ from the exact authorized build outputs");
  }
  const buildReceipt = operationReceipt(provenance, buildOperation);
  if (buildReceipt.id !== prepared.systemManifest.provenance.operationReceiptId)
    throw new Error("Prepared-system manifest receipt lineage is stale");
  const buildApproval = assertApprovedOperation(provenance, buildOperation, buildReceipt);
  if (
    buildWorkUnit.protocolFragment.parameters.manifestDigest !==
    prepared.systemManifest.manifestDigest
  ) {
    if (!input.frozenSourceProof)
      throw new Error(
        "Prepared-system build requires its exact final digest or verified receipt-derived source",
      );
    assertReceiptDerivedFrozenSource({
      prepared,
      workUnit: buildWorkUnit,
      operation: buildOperation,
      receipt: buildReceipt,
      evidence: provenance.evidence,
      proof: input.frozenSourceProof,
    });
  }

  const atomMapOperation = provenance.operations.find(
    (item) =>
      [AtomMapPublicationRequestSchemaVersionV1, AtomMapPublicationRequestSchemaVersion].includes(
        item.request.schemaVersion as
          | typeof AtomMapPublicationRequestSchemaVersionV1
          | typeof AtomMapPublicationRequestSchemaVersion,
      ) &&
      item.request.workUnitId === item.workUnitId &&
      item.request.atomMap !== undefined &&
      (item.request.atomMap as { id?: unknown }).id === prepared.atomMap.id &&
      (item.request.atomMap as { revision?: unknown }).revision === prepared.atomMap.revision &&
      (item.request.atomMap as { digest?: unknown }).digest === prepared.atomMap.mapDigest,
  );
  if (
    !atomMapOperation ||
    atomMapOperation.missionId !== prepared.missionId ||
    atomMapOperation.kind !== "system_preparation"
  ) {
    throw new Error("Prepared-system package lacks the exact AtomMap publication operation");
  }
  const atomMapRequest = AtomMapPublicationRequestSchema.parse(atomMapOperation.request);
  const atomMapWorkUnit = requiredCapabilityWorkUnit(
    provenance,
    atomMapOperation.workUnitId,
    atomMapRequest.capability.id,
  );
  assertTypedPreparationEffectBinding({
    provenance,
    operation: atomMapOperation,
    workUnit: atomMapWorkUnit,
    request: atomMapRequest,
  });
  if (
    !["amber.topology-coordinate-validation", "biomolecular.system-provenance"].includes(
      atomMapRequest.capability.id,
    )
  ) {
    throw new Error("AtomMap publication uses an unsupported capability");
  }
  if (
    atomMapWorkUnit.protocolFragment.kind !== "scientific_capability" ||
    !["artifact_integrity", "topology_integrity"].every((kind) =>
      atomMapWorkUnit.outputContract.requiredObservationKinds.includes(kind),
    ) ||
    atomMapRequest.workUnitId !== atomMapWorkUnit.id ||
    atomMapRequest.systemManifest.id !== prepared.systemManifest.id ||
    atomMapRequest.systemManifest.revision !== prepared.systemManifest.revision ||
    atomMapRequest.systemManifest.digest !== prepared.systemManifest.manifestDigest ||
    atomMapRequest.sourceArtifact.evidenceRef !== prepared.artifacts.atomMap.evidenceRef ||
    atomMapRequest.sourceArtifact.mediaType !== prepared.artifacts.atomMap.mediaType ||
    canonicalJson(atomMapRequest.atomMap) !==
      canonicalJson({
        id: prepared.atomMap.id,
        revision: prepared.atomMap.revision,
        digest: prepared.atomMap.mapDigest,
      })
  ) {
    throw new Error("AtomMap publication differs from the exact manifest and build artifact");
  }
  const atomMapBinding = BiomolecularMaterialPublicationBindingSchema.parse(
    atomMapWorkUnit.protocolFragment.parameters,
  );
  if (
    atomMapBinding.subjectKind !== "atom_map" ||
    atomMapBinding.artifactEvidenceRef !== prepared.artifacts.atomMap.evidenceRef ||
    atomMapBinding.sourceEvidenceRefs.length !== 1 ||
    atomMapBinding.sourceEvidenceRefs[0] !== prepared.artifacts.atomMap.evidenceRef ||
    atomMapBinding.subject.id !== prepared.atomMap.id ||
    atomMapBinding.subject.revision !== prepared.atomMap.revision ||
    atomMapBinding.subject.digest !== prepared.atomMap.mapDigest ||
    atomMapBinding.systemManifest.id !== prepared.systemManifest.id ||
    atomMapBinding.systemManifest.revision !== prepared.systemManifest.revision ||
    atomMapBinding.systemManifest.digest !== prepared.systemManifest.manifestDigest
  ) {
    throw new Error("AtomMap publication WorkUnit is outside the exact material binding");
  }
  const atomMapReceipt = operationReceipt(provenance, atomMapOperation);
  const atomMapApproval = assertApprovedOperation(provenance, atomMapOperation, atomMapReceipt);

  const packageEvidenceId = `amber-prepared-system-package:${prepared.systemManifest.id}:${prepared.systemManifest.revision}`;
  assertQcObservations({
    provenance,
    workUnit: buildWorkUnit,
    packageValue: prepared,
  });
  assertQcObservations({
    provenance,
    workUnit: atomMapWorkUnit,
    packageValue: prepared,
  });
  return {
    packageValue: prepared,
    buildWorkUnit,
    buildOperation,
    buildReceipt,
    buildApproval,
    atomMapWorkUnit,
    atomMapOperation,
    atomMapReceipt,
    atomMapApproval,
    packageEvidenceId,
  };
}

function packageEvidenceBytes(
  prepared: ReturnType<typeof assertAmberPreparedSystemPackage>,
  authority: ReturnType<typeof assertPreparedSystemMissionAuthority>,
): Uint8Array {
  const { packageDigest: _packageDigest, ...material } = prepared;
  const bundle = AmberPreparedSystemCasBundleSchema.parse({
    schemaVersion: "eigengrid.amber-prepared-system-cas-bundle/v1",
    package: material,
    authorities: {
      systemBuild: {
        operation: authority.buildOperation,
        receipt: authority.buildReceipt,
        approval: authority.buildApproval,
      },
      atomMapPublication: {
        operation: authority.atomMapOperation,
        receipt: authority.atomMapReceipt,
        approval: authority.atomMapApproval,
      },
    },
  });
  return new TextEncoder().encode(canonicalJson(bundle));
}

function assertExistingEvidenceCompatible(
  expected: EvidenceReference,
  existing: EvidenceReference | undefined,
): void {
  if (!existing) return;
  const withoutTime = (reference: EvidenceReference) => ({ ...reference, createdAt: undefined });
  if (canonicalJson(withoutTime(existing)) !== canonicalJson(withoutTime(expected))) {
    throw new Error(
      `Prepared-system evidence identity ${expected.id} conflicts with mission provenance`,
    );
  }
}

export async function importAmberPreparedSystem(input: {
  directory: string;
  actor: ActorIdentity;
  store: Pick<
    ScientificStore,
    | "getMissionProjectAssociation"
    | "assertProductionMissionPlanningAccess"
    | "getMissionProvenance"
    | "createEvidence"
  >;
  mdStore: Pick<MdProjectionStore, "getForceFieldStack" | "putSystemManifest" | "putAtomMap">;
  artifacts: Pick<ContentAddressedArtifactStore, "putStream"> &
    Partial<Pick<ContentAddressedArtifactStore, "get">>;
  assertCurrent?: () => Promise<void>;
}): Promise<{
  missionId: string;
  systemManifestId: string;
  systemManifestRevision: number;
  atomMapId: string;
  atomMapRevision: number;
  packageDigest: string;
  authorityBundleDigest: string;
  evidenceRefs: string[];
}> {
  const actor = ActorIdentitySchema.parse(input.actor);
  await input.assertCurrent?.();
  if (actor.kind !== "human") throw new Error("Prepared-system import requires a human owner");
  const directory = resolve(input.directory);
  const directoryStat = await lstat(directory, { bigint: true });
  if (!directoryStat.isDirectory())
    throw new Error("Prepared-system input must be a real directory");
  const packageValue = AmberPreparedSystemPackageSchema.parse(
    await readBoundedJson(join(directory, manifestFile), packageLimit),
  );
  const prepared = assertAmberPreparedSystemPackage(packageValue);

  const association = await input.store.getMissionProjectAssociation(prepared.missionId);
  if (!association || association.ownerUserId !== actor.id) {
    throw new Error("Prepared-system mission is not owned by the authenticated user");
  }
  await input.store.assertProductionMissionPlanningAccess({
    missionId: prepared.missionId,
    projectId: association.projectId,
    ownerUserId: actor.id,
  });
  const provenance = await input.store.getMissionProvenance(prepared.missionId);
  const stack = await input.mdStore.getForceFieldStack(
    prepared.missionId,
    prepared.forceFieldStack.id,
    prepared.forceFieldStack.revision,
  );
  if (!stack) throw new Error("Prepared-system force-field stack is not durably published");
  let frozenSourceProof: FrozenPreparationSourceProof | undefined;
  const buildUnit = provenance.workUnits.find((x) => x.id === prepared.workUnitId);
  if (
    buildUnit?.protocolFragment.kind === "scientific_capability" &&
    buildUnit.protocolFragment.parameters.manifestDigest !== prepared.systemManifest.manifestDigest
  ) {
    const operation = provenance.operations.find(
      (x) => x.id === prepared.systemManifest.provenance.operationId,
    );
    const request = BiomolecularSystemBuildRequestSchema.parse(operation?.request);
    if (!("inputContentDigest" in request) || !input.artifacts.get)
      throw new Error("Verified frozen-source CAS reader required");
    const draft = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        (await input.artifacts.get(request.inputContentDigest)).bytes,
      ),
    );
    const candidates: FrozenPreparationSourceProof[] = [];
    for (const e of provenance.evidence.filter(
      (x) =>
        buildUnit.inputRefs.includes(x.id) &&
        x.immutable &&
        x.kind === "source_snapshot" &&
        x.mediaType === "application/json" &&
        x.sizeBytes !== undefined &&
        x.sizeBytes <= 1024 ** 2,
    )) {
      const sourceManifest = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          (await input.artifacts.get(e.contentDigest)).bytes,
        ),
      );
      if (
        frozenSourceManifestDigest(sourceManifest) ===
        buildUnit.protocolFragment.parameters.manifestDigest
      )
        candidates.push({ draft, sourceManifest, sourceManifestEvidenceRef: e.id });
    }
    if (candidates.length !== 1)
      throw new Error("One exact sealed frozen source manifest is required");
    frozenSourceProof = candidates[0];
  }
  const authority = assertPreparedSystemMissionAuthority({
    actor,
    provenance,
    packageValue: prepared,
    forceFieldStack: stack,
    frozenSourceProof,
  });

  const expectedEntries = new Set([
    manifestFile,
    ...Object.values(prepared.artifacts).map((artifact) => artifact.fileName),
  ]);
  const entries = await readdir(directory);
  if (
    entries.length !== expectedEntries.size ||
    entries.some((entry) => !expectedEntries.has(entry))
  ) {
    throw new Error("Prepared-system directory must contain only its manifest and declared files");
  }

  const fileLimit = new Map<string, number>([
    [prepared.artifacts.atomMap.fileName, atomMapLimit],
    [prepared.artifacts.qcReport.fileName, qcReportLimit],
    [prepared.artifacts.snapshotPdb.fileName, prepared.artifacts.snapshotPdb.sizeBytes],
    [prepared.artifacts.topology.fileName, prepared.artifacts.topology.sizeBytes],
    [prepared.artifacts.coordinates.fileName, prepared.artifacts.coordinates.sizeBytes],
  ]);
  const atomMapBinding = prepared.artifacts.atomMap;
  const atomMapParts: Uint8Array[] = [];
  for await (const chunk of stableFileBytes(
    join(directory, atomMapBinding.fileName),
    atomMapBinding.sizeBytes,
    fileLimit.get(atomMapBinding.fileName)!,
  ))
    atomMapParts.push(chunk);
  const observedAtomMapBytes = Buffer.concat(atomMapParts);
  const expectedAtomMapBytes = atomMapArtifactBytes(prepared.atomMap);
  if (
    observedAtomMapBytes.byteLength !== expectedAtomMapBytes.byteLength ||
    createHash("sha256").update(observedAtomMapBytes).digest("hex") !==
      createHash("sha256").update(expectedAtomMapBytes).digest("hex")
  ) {
    throw new Error("Prepared-system AtomMap file differs from its canonical typed map");
  }
  const qcBinding = prepared.artifacts.qcReport;
  const qcParts: Uint8Array[] = [];
  for await (const chunk of stableFileBytes(
    join(directory, qcBinding.fileName),
    qcBinding.sizeBytes,
    fileLimit.get(qcBinding.fileName)!,
  ))
    qcParts.push(chunk);
  const qcBytes = Buffer.concat(qcParts);
  if (
    canonicalJson(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(qcBytes))) !==
    canonicalJson(prepared.qc)
  ) {
    throw new Error("Prepared-system QC file differs from its typed report");
  }

  const bindings = [
    { binding: prepared.artifacts.topology, kind: "topology" as const },
    { binding: prepared.artifacts.coordinates, kind: "coordinates" as const },
    { binding: prepared.artifacts.atomMap, kind: "atom_map" as const },
    { binding: prepared.artifacts.snapshotPdb, kind: "source_snapshot" as const },
    { binding: prepared.artifacts.qcReport, kind: "parser_output" as const },
  ];
  const evidence: EvidenceReference[] = bindings.map(({ binding, kind }) =>
    EvidenceReferenceSchema.parse({
      id: binding.evidenceRef,
      missionId: prepared.missionId,
      workUnitId: authority.buildWorkUnit.id,
      kind,
      uri: `cas://sha256/${binding.sha256}`,
      contentDigest: binding.sha256,
      sizeBytes: binding.sizeBytes,
      mediaType: binding.mediaType,
      immutable: true,
      sourceId: authority.buildReceipt.id,
      createdAt: authority.buildReceipt.recordedAt,
    }),
  );
  const materialBytes = packageEvidenceBytes(prepared, authority);
  const authorityBundleDigest = createHash("sha256").update(materialBytes).digest("hex");
  evidence.push(
    EvidenceReferenceSchema.parse({
      id: authority.packageEvidenceId,
      missionId: prepared.missionId,
      workUnitId: authority.buildWorkUnit.id,
      kind: "artifact",
      uri: `cas://sha256/${authorityBundleDigest}`,
      contentDigest: authorityBundleDigest,
      sizeBytes: materialBytes.byteLength,
      mediaType: AMBER_PREPARED_SYSTEM_MEDIA_TYPES.package,
      immutable: true,
      sourceId: authority.buildReceipt.id,
      createdAt: authority.buildReceipt.recordedAt,
    }),
  );
  for (const expected of evidence) {
    assertExistingEvidenceCompatible(
      expected,
      provenance.evidence.find((item) => item.id === expected.id),
    );
  }
  for (const { binding } of bindings) {
    await input.assertCurrent?.();
    const maximum = fileLimit.get(binding.fileName)!;
    async function* verifiedChunks() {
      const hash = createHash("sha256");
      for await (const chunk of stableFileBytes(
        join(directory, binding.fileName),
        binding.sizeBytes,
        maximum,
      )) {
        hash.update(chunk);
        yield chunk;
      }
      if (hash.digest("hex") !== binding.sha256)
        throw new Error(`Prepared-system file ${binding.fileName} digest mismatch`);
    }
    const stored = await input.artifacts.putStream(verifiedChunks(), { maxBytes: maximum });
    if (stored.digest !== binding.sha256 || stored.sizeBytes !== binding.sizeBytes)
      throw new Error(`Prepared-system CAS binding mismatch for ${binding.fileName}`);
    if (stored.uri !== `cas://sha256/${binding.sha256}`)
      throw new Error(`Prepared-system CAS URI mismatch for ${binding.fileName}`);
  }
  const materialStored = await input.artifacts.putStream(
    (async function* () {
      yield materialBytes;
    })(),
    { maxBytes: packageLimit * 2 },
  );
  if (
    materialStored.digest !== authorityBundleDigest ||
    materialStored.uri !== `cas://sha256/${authorityBundleDigest}` ||
    materialStored.sizeBytes !== materialBytes.byteLength
  ) {
    throw new Error("Prepared-system canonical package digest mismatch");
  }
  await input.assertCurrent?.();
  for (const reference of evidence) {
    await input.assertCurrent?.();
    const existing = provenance.evidence.find((item) => item.id === reference.id);
    assertExistingEvidenceCompatible(reference, existing);
    if (!existing) await input.store.createEvidence(reference);
  }
  await input.assertCurrent?.();
  const publishedManifest = await input.mdStore.putSystemManifest(prepared.systemManifest);
  const publishedAtomMap = await input.mdStore.putAtomMap(prepared.atomMap, {
    missionId: prepared.missionId,
    operationId: authority.atomMapOperation.id,
    operationReceiptId: authority.atomMapReceipt.id,
  });
  return {
    missionId: prepared.missionId,
    systemManifestId: publishedManifest.id,
    systemManifestRevision: publishedManifest.revision,
    atomMapId: publishedAtomMap.id,
    atomMapRevision: publishedAtomMap.revision,
    packageDigest: prepared.packageDigest,
    authorityBundleDigest,
    evidenceRefs: evidence.map((item) => item.id),
  };
}
