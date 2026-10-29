import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ApprovalRequestSchema,
  AtomMapPublicationRequestSchema,
  BiomolecularSystemBuildRequestSchema,
  BiomolecularSystemManifestSchema,
  DigestSchema,
  ExternalOperationSchema,
  ForceFieldStackManifestSchema,
  IdSchema,
  AtomMapSchema,
  OperationReceiptSchema,
  assertAtomMapDigest,
  assertForceFieldStackDigest,
  assertPublishedBiomolecularSystemManifestDigest,
  canonicalJson,
  digestCanonical,
  type AtomMap,
  type BiomolecularSystemManifest,
} from "@eigengrid/scientific-schema";
import { sha256Canonical } from "./canonical";

export const AMBER_PREPARED_SYSTEM_MEDIA_TYPES = Object.freeze({
  topology: "application/vnd.amber.prmtop",
  coordinates: "application/vnd.amber.rst7",
  atomMap: "application/vnd.eigengrid.atom-map+json",
  snapshotPdb: "chemical/x-pdb",
  qcReport: "application/vnd.eigengrid.amber-prepared-system-qc+json",
  package: "application/vnd.eigengrid.amber-prepared-system-package+json",
});

export const AmberIonAdditionReportSchema = z
  .object({
    schemaVersion: z.literal("eigengrid.amber-ion-addition-report/v1"),
    waterMoleculeCountBeforeIons: z.number().int().positive(),
    targetIonicStrengthMolar: z.number().finite().nonnegative().max(1),
    preNeutralizationSoluteCharge: z.number().int(),
    neutralizationCounterIon: z.enum(["Na+", "Cl-"]).nullable(),
    neutralizationIonCount: z.number().int().nonnegative(),
    sodiumChloridePairCount: z.number().int().nonnegative(),
    waterReferenceMolarity: z.literal(55.5),
    derivation: z.literal("round(Nwater * targetIonicStrengthMolar / 55.5)"),
    neutralizationOrder: z.literal("separate-before-salt-pairs"),
  })
  .strict();
export type AmberIonAdditionReport = z.infer<typeof AmberIonAdditionReportSchema>;

const positiveSize = z
  .number()
  .int()
  .positive()
  .max(4 * 1024 ** 3);
const FileBindingSchema = z
  .object({
    evidenceRef: IdSchema,
    fileName: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u, "Prepared-system inputs must be flat filenames"),
    mediaType: z.string().regex(/^[a-z0-9.+-]+\/[a-zA-Z0-9.+-]+$/u),
    sha256: DigestSchema,
    sizeBytes: positiveSize.max(2 * 1024 ** 3),
  })
  .strict();
const BoxLengthsSchema = z.tuple([
  z.number().finite().positive(),
  z.number().finite().positive(),
  z.number().finite().positive(),
]);
const BoxAnglesSchema = z.tuple([
  z.number().finite().gt(0).lt(180),
  z.number().finite().gt(0).lt(180),
  z.number().finite().gt(0).lt(180),
]);

export const AmberPreparedSystemQcReportSchema = z
  .object({
    schemaVersion: z.literal("eigengrid.amber-prepared-system-qc/v1"),
    status: z.literal("passed"),
    validatorId: IdSchema,
    validatorVersion: z.string().min(1).max(128),
    topologyDigest: DigestSchema,
    coordinatesDigest: DigestSchema,
    atomMapDigest: DigestSchema,
    forceFieldStackDigest: DigestSchema,
    parameterDigests: z.array(DigestSchema).min(4).max(64),
    atomCount: z.number().int().positive(),
    topologyAtomCount: z.number().int().positive(),
    coordinateAtomCount: z.number().int().positive(),
    formalCharge: z.number().int(),
    partialChargeTotal: z.number().finite(),
    boxLengthsAngstrom: BoxLengthsSchema,
    boxAnglesDegrees: BoxAnglesSchema,
    atomIdentityDigest: DigestSchema,
    componentAtomCounts: z.record(IdSchema, z.number().int().positive()),
    leapFatalCount: z.literal(0),
    impossibleContactCount: z.literal(0),
    finiteCoordinates: z.literal(true),
    periodicBoxPresent: z.literal(true),
    ionAddition: AmberIonAdditionReportSchema,
    passedChecks: z
      .array(
        z.enum([
          "topology-readable",
          "coordinates-readable",
          "topology-coordinate-count",
          "atommap-index-and-identity",
          "forcefield-parameter-digests",
          "charge-balance",
          "periodic-box",
          "leap-fatal-count",
          "impossible-contacts",
          "finite-coordinates",
          "salt-concentration-and-neutralization",
        ]),
      )
      .length(11),
    fatalDiagnostics: z.array(z.string().min(1)).max(0),
  })
  .strict();
export type AmberPreparedSystemQcReport = z.infer<typeof AmberPreparedSystemQcReportSchema>;

export const AmberPreparedSystemQcObservationSchema = z
  .object({
    schemaVersion: z.literal("eigengrid.amber-prepared-system-qc-observation/v1"),
    packageDigest: DigestSchema,
    qcReportDigest: DigestSchema,
    topologyDigest: DigestSchema,
    coordinatesDigest: DigestSchema,
    atomMapDigest: DigestSchema,
    forceFieldStackDigest: DigestSchema,
    validatorId: IdSchema,
    validatorVersion: z.string().min(1).max(128),
    status: z.literal("passed"),
  })
  .strict();
export type AmberPreparedSystemQcObservation = z.infer<
  typeof AmberPreparedSystemQcObservationSchema
>;

export const AmberPreparedSystemPackageSchema = z
  .object({
    schemaVersion: z.literal("eigengrid.amber-prepared-system-package/v1"),
    missionId: IdSchema,
    workUnitId: IdSchema,
    systemManifest: BiomolecularSystemManifestSchema,
    atomMap: AtomMapSchema,
    forceFieldStack: ForceFieldStackManifestSchema,
    parameterDigests: z.array(DigestSchema).min(4).max(64),
    artifacts: z
      .object({
        topology: FileBindingSchema,
        coordinates: FileBindingSchema,
        atomMap: FileBindingSchema,
        snapshotPdb: FileBindingSchema,
        qcReport: FileBindingSchema,
      })
      .strict(),
    qc: AmberPreparedSystemQcReportSchema,
    packageDigest: DigestSchema,
  })
  .strict();
export type AmberPreparedSystemPackage = z.infer<typeof AmberPreparedSystemPackageSchema>;

/** Exact durable authorities committed alongside the material package in CAS. */
const AmberPreparedSystemOperationAuthoritySchema = z
  .object({
    operation: ExternalOperationSchema,
    receipt: OperationReceiptSchema,
    approval: ApprovalRequestSchema,
  })
  .strict()
  .superRefine((authority, context) => {
    const { operation, receipt, approval } = authority;
    if (
      operation.kind !== "system_preparation" ||
      operation.state !== "confirmed" ||
      operation.requestDigest !== digestCanonical(operation.request) ||
      operation.receiptId !== receipt.id ||
      receipt.operationId !== operation.id ||
      receipt.requestDigest !== operation.requestDigest ||
      receipt.status !== "confirmed"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["operation"],
        message: "Prepared-system CAS authority must bind one exact confirmed operation receipt",
      });
    }
    if (
      approval.subjectType !== "operation" ||
      approval.missionId !== operation.missionId ||
      approval.subjectId !== operation.id ||
      approval.subjectVersion !== 1 ||
      approval.subjectRevision !== 1 ||
      approval.state !== "approved" ||
      approval.payloadDigest !== operation.requestDigest ||
      operation.policyDigest !== approval.policyDigest ||
      approval.response?.decision !== "approved" ||
      approval.response.payloadDigest !== operation.requestDigest ||
      approval.response.policyDigest !== approval.policyDigest ||
      approval.response.subjectVersion !== approval.subjectVersion ||
      approval.response.subjectRevision !== approval.subjectRevision ||
      approval.response.role !== approval.requestedFromRole ||
      approval.response.actor.kind !== "human" ||
      approval.response.actor.role !== approval.requestedFromRole ||
      Date.parse(approval.response.decidedAt) > Date.parse(receipt.recordedAt)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approval"],
        message:
          "Prepared-system CAS authority must bind prior human approval of the exact request",
      });
    }
  });

export const AmberPreparedSystemCasBundleSchema = z
  .object({
    schemaVersion: z.literal("eigengrid.amber-prepared-system-cas-bundle/v1"),
    package: AmberPreparedSystemPackageSchema.omit({ packageDigest: true }),
    authorities: z
      .object({
        systemBuild: AmberPreparedSystemOperationAuthoritySchema,
        atomMapPublication: AmberPreparedSystemOperationAuthoritySchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((bundle, context) => {
    const { package: prepared, authorities } = bundle;
    const build = authorities.systemBuild;
    const buildRequest = BiomolecularSystemBuildRequestSchema.safeParse(build.operation.request);
    if (
      !buildRequest.success ||
      build.operation.missionId !== prepared.missionId ||
      build.operation.workUnitId !== prepared.workUnitId ||
      build.receipt.id !== prepared.systemManifest.provenance.operationReceiptId ||
      build.operation.id !== prepared.systemManifest.provenance.operationId ||
      buildRequest.data.workUnitId !== prepared.workUnitId ||
      buildRequest.data.systemManifest.id !== prepared.systemManifest.id ||
      buildRequest.data.systemManifest.revision !== prepared.systemManifest.revision ||
      canonicalJson(buildRequest.data.decisionRefs) !==
        canonicalJson(prepared.systemManifest.decisionRefs) ||
      canonicalJson(buildRequest.data.forceFieldStack) !==
        canonicalJson(prepared.systemManifest.forceFieldStack) ||
      buildRequest.data.outputArtifacts.topology.evidenceRef !==
        prepared.artifacts.topology.evidenceRef ||
      buildRequest.data.outputArtifacts.topology.mediaType !==
        prepared.artifacts.topology.mediaType ||
      buildRequest.data.outputArtifacts.coordinates.evidenceRef !==
        prepared.artifacts.coordinates.evidenceRef ||
      buildRequest.data.outputArtifacts.coordinates.mediaType !==
        prepared.artifacts.coordinates.mediaType ||
      buildRequest.data.outputArtifacts.atomMap.evidenceRef !==
        prepared.artifacts.atomMap.evidenceRef ||
      buildRequest.data.outputArtifacts.atomMap.mediaType !== prepared.artifacts.atomMap.mediaType
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["authorities", "systemBuild"],
        message: "System-build CAS authority differs from manifest provenance",
      });
    }
    const mapAuthority = authorities.atomMapPublication;
    const mapRequest = AtomMapPublicationRequestSchema.safeParse(mapAuthority.operation.request);
    if (
      !mapRequest.success ||
      mapAuthority.operation.missionId !== prepared.missionId ||
      mapRequest.data.atomMap.id !== prepared.atomMap.id ||
      mapRequest.data.atomMap.revision !== prepared.atomMap.revision ||
      mapRequest.data.atomMap.digest !== prepared.atomMap.mapDigest ||
      mapRequest.data.systemManifest.id !== prepared.systemManifest.id ||
      mapRequest.data.systemManifest.revision !== prepared.systemManifest.revision ||
      mapRequest.data.systemManifest.digest !== prepared.systemManifest.manifestDigest ||
      mapRequest.data.sourceArtifact.evidenceRef !== prepared.artifacts.atomMap.evidenceRef
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["authorities", "atomMapPublication"],
        message: "AtomMap CAS authority differs from its exact published material",
      });
    }
  });
export type AmberPreparedSystemCasBundle = z.infer<typeof AmberPreparedSystemCasBundleSchema>;

export function parameterDigestsForStack(value: unknown): string[] {
  const stack = assertForceFieldStackDigest(value);
  return [
    stack.protein.parameterDigest,
    stack.lipid.parameterDigest,
    stack.water.parameterSet.parameterDigest,
    stack.ions.parameterDigest,
    ...stack.ligands.map((entry) => entry.parameterSet.parameterDigest),
    ...stack.cofactors.map((entry) => entry.parameterSet.parameterDigest),
  ].sort();
}

export function atomMapArtifactBytes(value: unknown): Uint8Array {
  const atomMap = assertAtomMapDigest(value);
  const { mapDigest: _mapDigest, ...unsignedAtomMap } = atomMap;
  return new TextEncoder().encode(canonicalJson(unsignedAtomMap));
}

function atomIdentityDigest(atomMap: AtomMap): string {
  return digestCanonical(
    atomMap.entries.map((entry) => ({
      systemAtomIndex: entry.systemAtomIndex,
      componentId: entry.componentId,
      componentAtomIndex: entry.componentAtomIndex,
      chainId: entry.chainId ?? null,
      residueIndex: entry.residueIndex,
      residueName: entry.residueName,
      atomName: entry.atomName,
      element: entry.element,
    })),
  );
}

function componentAtomCounts(manifest: BiomolecularSystemManifest): Record<string, number> {
  return Object.fromEntries(
    Object.values(manifest.components)
      .flat()
      .map((component) => [component.id, component.atomCount])
      .sort(([left], [right]) => String(left).localeCompare(String(right))),
  );
}

function closeEnough(left: number, right: number, tolerance: number): boolean {
  return Math.abs(left - right) <= tolerance;
}

function assertIonAdditionReport(
  manifest: BiomolecularSystemManifest,
  report: AmberIonAdditionReport,
): void {
  const waterCount = manifest.components.waters.reduce(
    (total, water) => total + water.moleculeCount,
    0,
  );
  const pairCount = Math.round(
    (waterCount * manifest.environment.targetIonicStrengthMolar) / report.waterReferenceMolarity,
  );
  const ions = manifest.components.ions;
  const sodiumCount = ions
    .filter((ion) => ion.element === "Na" && ion.perIonFormalCharge === 1)
    .reduce((total, ion) => total + ion.moleculeCount, 0);
  const chlorideCount = ions
    .filter((ion) => ion.element === "Cl" && ion.perIonFormalCharge === -1)
    .reduce((total, ion) => total + ion.moleculeCount, 0);
  const unsupportedIons = ions.some(
    (ion) =>
      !(
        (ion.element === "Na" && ion.perIonFormalCharge === 1) ||
        (ion.element === "Cl" && ion.perIonFormalCharge === -1)
      ),
  );
  const expectedNeutralizationIon =
    report.preNeutralizationSoluteCharge > 0
      ? "Cl-"
      : report.preNeutralizationSoluteCharge < 0
        ? "Na+"
        : null;
  const expectedNeutralizationCount = Math.abs(report.preNeutralizationSoluteCharge);
  const expectedSodiumCount =
    pairCount + (report.neutralizationCounterIon === "Na+" ? expectedNeutralizationCount : 0);
  const expectedChlorideCount =
    pairCount + (report.neutralizationCounterIon === "Cl-" ? expectedNeutralizationCount : 0);
  if (
    report.waterMoleculeCountBeforeIons !== waterCount ||
    report.targetIonicStrengthMolar !== manifest.environment.targetIonicStrengthMolar ||
    report.sodiumChloridePairCount !== pairCount ||
    report.neutralizationCounterIon !== expectedNeutralizationIon ||
    report.neutralizationIonCount !== expectedNeutralizationCount ||
    sodiumCount !== expectedSodiumCount ||
    chlorideCount !== expectedChlorideCount ||
    unsupportedIons ||
    manifest.totalCharge !== 0
  ) {
    throw new Error(
      "Prepared-system NaCl pairs, separate neutralization, or final charge do not match the manifest",
    );
  }
}

export function assertAmberPreparedSystemPackage(value: unknown): AmberPreparedSystemPackage {
  const prepared = AmberPreparedSystemPackageSchema.parse(value);
  const { packageDigest, ...material } = prepared;
  if (digestCanonical(material) !== packageDigest) {
    throw new Error("Prepared-system package self-digest does not match its contents");
  }
  const manifest = assertPublishedBiomolecularSystemManifestDigest(prepared.systemManifest);
  assertIonAdditionReport(manifest, prepared.qc.ionAddition);
  const atomMap = assertAtomMapDigest(prepared.atomMap);
  const stack = assertForceFieldStackDigest(prepared.forceFieldStack);
  const actualParameters = parameterDigestsForStack(stack);
  const unique = (items: readonly string[]) => [...new Set(items)].sort();
  if (
    prepared.missionId !== manifest.missionId ||
    prepared.systemManifest.provenance.operationReceiptId === undefined ||
    manifest.forceFieldStack.id !== stack.id ||
    manifest.forceFieldStack.revision !== stack.revision ||
    manifest.forceFieldStack.digest !== stack.stackDigest ||
    atomMap.systemManifestId !== manifest.id ||
    atomMap.systemManifestRevision !== manifest.revision ||
    atomMap.atomCount !== manifest.atomCount ||
    atomMap.topologyDigest !== manifest.topologyDigest ||
    atomMap.coordinateDigest !== manifest.coordinateDigest ||
    atomMap.mapDigest !== manifest.atomMapDigest ||
    prepared.artifacts.topology.sha256 !== manifest.topologyDigest ||
    prepared.artifacts.coordinates.sha256 !== manifest.coordinateDigest ||
    prepared.artifacts.atomMap.sha256 !== atomMap.mapDigest ||
    prepared.artifacts.topology.mediaType !== AMBER_PREPARED_SYSTEM_MEDIA_TYPES.topology ||
    prepared.artifacts.coordinates.mediaType !== AMBER_PREPARED_SYSTEM_MEDIA_TYPES.coordinates ||
    prepared.artifacts.atomMap.mediaType !== AMBER_PREPARED_SYSTEM_MEDIA_TYPES.atomMap ||
    prepared.artifacts.snapshotPdb.mediaType !== AMBER_PREPARED_SYSTEM_MEDIA_TYPES.snapshotPdb ||
    prepared.artifacts.qcReport.mediaType !== AMBER_PREPARED_SYSTEM_MEDIA_TYPES.qcReport ||
    digestCanonical(unique(prepared.parameterDigests)) !==
      digestCanonical(unique(actualParameters)) ||
    digestCanonical(unique(prepared.qc.parameterDigests)) !==
      digestCanonical(unique(actualParameters))
  ) {
    throw new Error("Prepared-system artifacts do not match their published material identities");
  }
  const mappedCounts = new Map<string, number>();
  for (const entry of atomMap.entries)
    mappedCounts.set(entry.componentId, (mappedCounts.get(entry.componentId) ?? 0) + 1);
  const expectedCounts = componentAtomCounts(manifest);
  if (
    digestCanonical(Object.fromEntries(mappedCounts)) !== digestCanonical(expectedCounts) ||
    digestCanonical(prepared.qc.componentAtomCounts) !== digestCanonical(expectedCounts)
  ) {
    throw new Error("Prepared-system AtomMap component coverage is incomplete or duplicated");
  }
  if (
    manifest.membrane !== null &&
    (manifest.box.shape !== "orthorhombic" ||
      manifest.box.anglesDegrees.some((angle) => !closeEnough(angle, 90, 0.02)) ||
      !closeEnough(manifest.membrane.normalVector[0], 0, 1e-6) ||
      !closeEnough(manifest.membrane.normalVector[1], 0, 1e-6) ||
      !closeEnough(Math.abs(manifest.membrane.normalVector[2]), 1, 1e-6))
  ) {
    throw new Error("Amber 26 membrane pressure mapping requires an orthogonal XY-oriented box");
  }
  if (
    prepared.qc.topologyDigest !== manifest.topologyDigest ||
    prepared.qc.coordinatesDigest !== manifest.coordinateDigest ||
    prepared.qc.atomMapDigest !== atomMap.mapDigest ||
    prepared.qc.forceFieldStackDigest !== stack.stackDigest ||
    prepared.qc.atomCount !== manifest.atomCount ||
    prepared.qc.topologyAtomCount !== manifest.atomCount ||
    prepared.qc.coordinateAtomCount !== manifest.atomCount ||
    prepared.qc.formalCharge !== manifest.totalCharge ||
    !closeEnough(prepared.qc.partialChargeTotal, manifest.totalCharge, 0.001) ||
    prepared.qc.atomIdentityDigest !== atomIdentityDigest(atomMap) ||
    prepared.qc.leapFatalCount !== 0 ||
    prepared.qc.impossibleContactCount !== 0 ||
    prepared.qc.finiteCoordinates !== true ||
    prepared.qc.periodicBoxPresent !== true ||
    prepared.qc.passedChecks.length !== 11 ||
    new Set(prepared.qc.passedChecks).size !== 11
  ) {
    throw new Error("Prepared-system structural and parameter QC evidence is not complete");
  }
  for (const [index, length] of manifest.box.lengthsAngstrom.entries()) {
    if (!closeEnough(prepared.qc.boxLengthsAngstrom[index]!, length, 0.02)) {
      throw new Error("Prepared-system QC box lengths differ from the approved manifest");
    }
  }
  for (const [index, angle] of manifest.box.anglesDegrees.entries()) {
    if (!closeEnough(prepared.qc.boxAnglesDegrees[index]!, angle, 0.02)) {
      throw new Error("Prepared-system QC box angles differ from the approved manifest");
    }
  }
  if (prepared.artifacts.qcReport.sha256 !== sha256Canonical(prepared.qc)) {
    throw new Error("Prepared-system QC report file digest differs from the typed QC report");
  }
  const identities = Object.values(prepared.artifacts).map((artifact) => artifact.evidenceRef);
  const names = Object.values(prepared.artifacts).map((artifact) => artifact.fileName);
  if (new Set(identities).size !== identities.length || new Set(names).size !== names.length) {
    throw new Error("Prepared-system file evidence identities and names must be unique");
  }
  return prepared;
}

export function assertPreparedSystemFileBytes(
  value: unknown,
  files: Record<string, Uint8Array>,
): AmberPreparedSystemPackage {
  const prepared = assertAmberPreparedSystemPackage(value);
  const fileBytes = new Map<string, Uint8Array>();
  for (const binding of Object.values(prepared.artifacts)) {
    const bytes = files[binding.fileName];
    if (!bytes) throw new Error(`Prepared-system file ${binding.fileName} is missing`);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== binding.sizeBytes || digest !== binding.sha256) {
      throw new Error(`Prepared-system file ${binding.fileName} has a digest or size mismatch`);
    }
    fileBytes.set(binding.fileName, bytes);
  }
  const canonicalAtomMapBytes = atomMapArtifactBytes(prepared.atomMap);
  const observedAtomMap = fileBytes.get(prepared.artifacts.atomMap.fileName)!;
  if (
    canonicalAtomMapBytes.byteLength !== observedAtomMap.byteLength ||
    createHash("sha256").update(canonicalAtomMapBytes).digest("hex") !==
      createHash("sha256").update(observedAtomMap).digest("hex")
  ) {
    throw new Error("Prepared-system AtomMap file is not the exact canonical AtomMap payload");
  }
  const canonicalQcBytes = new TextEncoder().encode(canonicalJson(prepared.qc));
  const observedQc = fileBytes.get(prepared.artifacts.qcReport.fileName)!;
  if (
    canonicalQcBytes.byteLength !== observedQc.byteLength ||
    createHash("sha256").update(canonicalQcBytes).digest("hex") !==
      createHash("sha256").update(observedQc).digest("hex")
  ) {
    throw new Error("Prepared-system QC file is not the exact canonical QC report");
  }
  return prepared;
}
