import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AtomMapPublicationRequestSchema,
  AtomMapPublicationRequestSchemaVersion,
  BiomolecularSystemBuildRequestSchema,
  BiomolecularSystemBuildRequestSchemaVersion,
  computeAtomMapDigest,
  computeBiomolecularSystemManifestDigest,
  computeForceFieldStackDigest,
  canonicalJson,
  digestCanonical,
  WorkUnitSchema,
  ExternalOperationSchema,
  OperationReceiptSchema,
  EvidenceReferenceSchema,
  type AtomMapEntry,
} from "@eigengrid/scientific-schema";
import {
  AmberPreparedSystemCasBundleSchema,
  AmberPreparedSystemQcReportSchema,
  assertPreparedSystemFileBytes,
  parameterDigestsForStack,
  assertAmberPreparedSystemPackage,
} from "./prepared-system";
import { importAmberPreparedSystem } from "../../../apps/cli/src/services/amber-prepared-system-import";
import {
  assertReceiptDerivedFrozenSource,
  assertAtomMapPackageMaterial,
} from "../../../apps/cli/src/services/amber-frozen-material";

const digestBytes = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const digest = (value: string) => digestCanonical(value);

function fixture() {
  const bytes = {
    topology: Buffer.from("synthetic prmtop bytes"),
    coordinates: Buffer.from("synthetic rst7 bytes"),
    snapshotPdb: Buffer.from("END\n"),
  };
  const topologyDigest = digestBytes(bytes.topology);
  const coordinateDigest = digestBytes(bytes.coordinates);
  const stackParameter = (id: string, parameterDigest: string) => ({
    id,
    family: "fixture",
    version: "1",
    source: "synthetic fixture",
    sourceEvidenceRefs: ["forcefield-source"],
    parameterDigest,
    knownLimitations: ["Test fixture only"],
  });
  const stackBase = {
    schemaVersion: "eigengrid.force-field-stack/v1" as const,
    id: "force-field-stack",
    revision: 1,
    protein: stackParameter("protein-parameters", digest("protein-parameters")),
    lipid: stackParameter("lipid-parameters", digest("lipid-parameters")),
    ligands: [
      {
        componentId: "ligand",
        parameterSet: stackParameter("ligand-parameters", digest("ligand-parameters")),
        chargeMethod: "fixture",
        chargeMethodVersion: "1",
        formalCharge: 1,
        atomTypeDigest: digest("ligand-types"),
        chargeDigest: digest("ligand-charge"),
      },
    ],
    water: {
      model: "TIP3P",
      parameterSet: stackParameter("water-parameters", digest("water-parameters")),
    },
    ions: stackParameter("ion-parameters", digest("ion-parameters")),
    cofactors: [],
    engineCompatibility: [{ engine: "amber", versionRange: "26.x" }],
    compatibilityEvidenceRefs: ["compatibility-evidence"],
    knownLimitations: ["Test fixture only"],
    createdAt: "2026-09-30T00:00:00.000Z",
  };
  const forceFieldStack = {
    ...stackBase,
    stackDigest: computeForceFieldStackDigest(stackBase),
  };
  const waterAtomNames = ["O", "H1", "H2"] as const;
  const waterElements = ["O", "H", "H"] as const;
  const entries: AtomMapEntry[] = [
    {
      systemAtomIndex: 1,
      componentId: "receptor",
      componentAtomIndex: 1,
      chainId: "A",
      residueIndex: 1,
      residueName: "ALA",
      atomName: "CA",
      element: "C",
    },
    {
      systemAtomIndex: 2,
      componentId: "ligand",
      componentAtomIndex: 1,
      residueIndex: 1,
      residueName: "LIG",
      atomName: "N1",
      element: "N",
    },
    ...Array.from({ length: 370 * 3 }, (_, index) => ({
      systemAtomIndex: index + 3,
      componentId: "water",
      componentAtomIndex: index + 1,
      chainId: "W",
      residueIndex: Math.floor(index / 3) + 1,
      residueName: "WAT",
      atomName: waterAtomNames[index % 3]!,
      element: waterElements[index % 3]!,
    })),
    {
      systemAtomIndex: 1113,
      componentId: "lipid",
      componentAtomIndex: 1,
      residueIndex: 1,
      residueName: "POPC",
      atomName: "C1",
      element: "C",
    },
    {
      systemAtomIndex: 1114,
      componentId: "sodium",
      componentAtomIndex: 1,
      residueIndex: 1,
      residueName: "Na+",
      atomName: "Na+",
      element: "Na",
    },
    {
      systemAtomIndex: 1115,
      componentId: "chloride",
      componentAtomIndex: 1,
      residueIndex: 1,
      residueName: "Cl-",
      atomName: "Cl-",
      element: "Cl",
    },
    {
      systemAtomIndex: 1116,
      componentId: "chloride",
      componentAtomIndex: 2,
      residueIndex: 2,
      residueName: "Cl-",
      atomName: "Cl-",
      element: "Cl",
    },
  ];
  const atomMapBase = {
    schemaVersion: "eigengrid.atom-map/v1" as const,
    id: "system-atom-map",
    revision: 1,
    systemManifestId: "system-manifest",
    systemManifestRevision: 1,
    indexBase: 1 as const,
    atomCount: 1116,
    topologyDigest,
    coordinateDigest,
    entries,
  };
  const atomMap = { ...atomMapBase, mapDigest: computeAtomMapDigest(atomMapBase) };
  const component = (id: string, atomCount: number, formalCharge = 0) => ({
    schemaVersion: "eigengrid.biomolecular-component/v1" as const,
    id,
    revision: 1,
    name: id,
    sourceEvidenceRefs: ["source-structure"],
    coordinateDigest,
    atomCount,
    moleculeCount: 1,
    formalCharge,
  });
  const decisions = [
    { id: "construct", kind: "construct" as const },
    { id: "force-field", kind: "force_field_stack" as const },
    { id: "membrane", kind: "membrane_model" as const },
    { id: "protonation", kind: "protonation" as const },
    { id: "microstate", kind: "microstate" as const },
    { id: "pose", kind: "pose" as const },
  ].map((decision) => ({
    ...decision,
    revision: 1,
    decisionDigest: digest(decision.id),
    approvalRef: `approval-${decision.id}`,
  }));
  const manifestBase = {
    schemaVersion: "eigengrid.biomolecular-system-manifest/v2" as const,
    id: "system-manifest",
    revision: 1,
    missionId: "mission",
    name: "synthetic prepared system fixture",
    sourceEvidenceRefs: ["source-structure"],
    constructDecisionId: "construct",
    forceFieldStackDecisionId: "force-field",
    membraneModelDecisionId: "membrane",
    decisionRefs: decisions,
    components: {
      proteins: [
        {
          ...component("receptor", 1),
          kind: "protein" as const,
          role: "receptor" as const,
          chainIds: ["A"],
          residueCount: 1,
          sequenceDigest: digest("sequence"),
          protonationDecisionId: "protonation",
        },
      ],
      ligands: [
        {
          ...component("ligand", 1, 1),
          kind: "ligand" as const,
          inchiKey: "AAAAAAAAAAAAAA-BBBBBBBBBB-C",
          stereochemistry: "synthetic fixture stereochemistry",
          microstateDecisionId: "microstate",
          poseDecisionId: "pose",
        },
      ],
      lipids: [
        {
          ...component("lipid", 1),
          kind: "lipid" as const,
          residueName: "POPC",
          lipidIdentity: "POPC",
        },
      ],
      waters: [
        {
          ...component("water", 1110),
          moleculeCount: 370,
          kind: "water" as const,
          waterModel: "TIP3P",
        },
      ],
      ions: [
        {
          ...component("sodium", 1, 1),
          kind: "ion" as const,
          element: "Na",
          perIonFormalCharge: 1,
        },
        {
          ...component("chloride", 2, -2),
          moleculeCount: 2,
          kind: "ion" as const,
          element: "Cl",
          perIonFormalCharge: -1,
        },
      ],
      cofactors: [],
    },
    membrane: {
      orientationProvider: "fixture",
      orientationProviderVersion: "1",
      orientationEvidenceRef: "orientation-evidence",
      orientationDigest: digest("orientation"),
      normalVector: [0, 0, 1] as [number, number, number],
      hydrophobicThicknessAngstrom: 30,
      composition: [{ lipidComponentId: "lipid", upperLeafletCount: 1, lowerLeafletCount: 0 }],
    },
    environment: {
      targetPh: 7.4,
      targetTemperatureKelvin: 310,
      targetPressureBar: 1,
      targetIonicStrengthMolar: 0.15,
    },
    forceFieldStack: {
      id: forceFieldStack.id,
      revision: forceFieldStack.revision,
      digest: forceFieldStack.stackDigest,
    },
    topologyDigest,
    coordinateDigest,
    atomMapDigest: atomMap.mapDigest,
    totalCharge: 0,
    atomCount: 1116,
    box: {
      shape: "orthorhombic" as const,
      lengthsAngstrom: [20, 20, 20] as [number, number, number],
      anglesDegrees: [90, 90, 90] as [number, number, number],
      periodic: true as const,
    },
    provenance: {
      operationId: "build-operation",
      operationReceiptId: "build-receipt",
      builder: { name: "fixture-builder", version: "1" },
      createdBy: { kind: "human" as const, id: "owner", role: "scientist" },
      createdAt: "2026-09-30T00:00:00.000Z",
    },
  };
  const systemManifest = {
    ...manifestBase,
    manifestDigest: computeBiomolecularSystemManifestDigest(manifestBase),
  };
  const mapBytes = new TextEncoder().encode(
    canonicalJson((({ mapDigest: _mapDigest, ...unsigned }) => unsigned)(atomMap)),
  );
  const parameterDigests = parameterDigestsForStack(forceFieldStack);
  const qcBase = {
    schemaVersion: "eigengrid.amber-prepared-system-qc/v1" as const,
    status: "passed" as const,
    validatorId: "amber-system-qc",
    validatorVersion: "1.0.0",
    topologyDigest,
    coordinatesDigest: coordinateDigest,
    atomMapDigest: atomMap.mapDigest,
    forceFieldStackDigest: forceFieldStack.stackDigest,
    parameterDigests,
    atomCount: 1116,
    topologyAtomCount: 1116,
    coordinateAtomCount: 1116,
    formalCharge: 0,
    partialChargeTotal: 0,
    boxLengthsAngstrom: [20, 20, 20] as [number, number, number],
    boxAnglesDegrees: [90, 90, 90] as [number, number, number],
    atomIdentityDigest: digestCanonical(
      entries.map((entry) => ({ ...entry, chainId: entry.chainId ?? null })),
    ),
    componentAtomCounts: {
      receptor: 1,
      ligand: 1,
      water: 1110,
      lipid: 1,
      sodium: 1,
      chloride: 2,
    },
    leapFatalCount: 0 as const,
    impossibleContactCount: 0 as const,
    finiteCoordinates: true as const,
    periodicBoxPresent: true as const,
    ionAddition: {
      schemaVersion: "eigengrid.amber-ion-addition-report/v1" as const,
      waterMoleculeCountBeforeIons: 370,
      targetIonicStrengthMolar: 0.15,
      preNeutralizationSoluteCharge: 1,
      neutralizationCounterIon: "Cl-" as const,
      neutralizationIonCount: 1,
      sodiumChloridePairCount: 1,
      waterReferenceMolarity: 55.5 as const,
      derivation: "round(Nwater * targetIonicStrengthMolar / 55.5)" as const,
      neutralizationOrder: "separate-before-salt-pairs" as const,
    },
    passedChecks: [
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
    ] as const,
    fatalDiagnostics: [] as string[],
  };
  const qc = AmberPreparedSystemQcReportSchema.parse(qcBase);
  const qcBytes = new TextEncoder().encode(canonicalJson(qc));
  const binding = (
    evidenceRef: string,
    fileName: string,
    mediaType: string,
    value: Uint8Array,
  ) => ({
    evidenceRef,
    fileName,
    mediaType,
    sha256: digestBytes(value),
    sizeBytes: value.byteLength,
  });
  const artifacts = {
    topology: binding(
      "topology-evidence",
      "system.prmtop",
      "application/vnd.amber.prmtop",
      bytes.topology,
    ),
    coordinates: binding(
      "coordinates-evidence",
      "system.rst7",
      "application/vnd.amber.rst7",
      bytes.coordinates,
    ),
    atomMap: binding(
      "atom-map-evidence",
      "atom-map.json",
      "application/vnd.eigengrid.atom-map+json",
      mapBytes,
    ),
    snapshotPdb: binding("snapshot-evidence", "system.pdb", "chemical/x-pdb", bytes.snapshotPdb),
    qcReport: binding(
      "qc-evidence",
      "qc.json",
      "application/vnd.eigengrid.amber-prepared-system-qc+json",
      qcBytes,
    ),
  };
  const material = {
    schemaVersion: "eigengrid.amber-prepared-system-package/v1" as const,
    missionId: "mission",
    workUnitId: "build-work-unit",
    systemManifest,
    atomMap,
    forceFieldStack,
    parameterDigests,
    artifacts,
    qc,
  };
  return {
    value: { ...material, packageDigest: digestCanonical(material) },
    files: {
      "system.prmtop": bytes.topology,
      "system.rst7": bytes.coordinates,
      "system.pdb": bytes.snapshotPdb,
      "atom-map.json": mapBytes,
      "qc.json": qcBytes,
    },
  };
}

function receiptSourceFixture() {
  const original = fixture().value;
  const {
    schemaVersion: _version,
    manifestDigest: _digest,
    provenance: _provenance,
    ...system
  } = original.systemManifest;
  const sourceMaterial = { schemaVersion: "unit-only.source-manifest/v1", ...system };
  const sourceManifest = { ...sourceMaterial, manifestDigest: digestCanonical(sourceMaterial) };
  const draft = {
    schemaVersion: "eigengrid.amber-frozen-system-draft/v1",
    system,
    atomMap: original.atomMap,
    forceFieldStack: original.forceFieldStack,
    parameterDigests: original.parameterDigests,
    artifacts: original.artifacts,
    qc: original.qc,
  };
  const evidence = [
    { id: "unit-draft-source", document: draft },
    { id: "unit-manifest-source", document: sourceManifest },
  ].map((x) =>
    EvidenceReferenceSchema.parse({
      id: x.id,
      missionId: original.missionId,
      kind: "source_snapshot",
      uri: `cas://sha256/${digestCanonical(x.document)}`,
      contentDigest: digestCanonical(x.document),
      sizeBytes: Buffer.byteLength(canonicalJson(x.document)),
      mediaType: "application/json",
      immutable: true,
      createdAt: "2026-09-30T00:00:00.000Z",
    }),
  );
  const skill = {
    skillId: "unit-source",
    version: "1.0.0",
    contentDigest: digest("unit-skill"),
    fragmentId: "unit-fragment",
    fragmentDigest: digest("unit-fragment"),
    relativePath: "protocols/unit.yaml",
    selector: "$",
  };
  const capability = {
    id: "biomolecular.build-system",
    version: "1.0.0",
    contractDigest: digest("unit-capability"),
  };
  const workUnit = WorkUnitSchema.parse({
    id: original.workUnitId,
    missionId: original.missionId,
    planId: "unit-plan",
    planVersion: 1,
    kind: "scientific_capability",
    state: "succeeded",
    reason: "Unit-only frozen source proof",
    dependencies: [],
    inputRefs: evidence.map((e) => e.id),
    outputContract: {
      requiredEvidenceKinds: ["topology", "coordinates", "atom_map"],
      requiredObservationKinds: ["artifact_integrity", "topology_integrity"],
    },
    skillRefs: [skill],
    protocolFragment: {
      schemaVersion: "eigengrid.scientific-capability-fragment/v1",
      id: "unit-capability-fragment",
      kind: "scientific_capability",
      capability,
      reason: "Unit-only source proof",
      parameters: {
        manifestId: system.id,
        manifestRevision: system.revision,
        manifestDigest: sourceManifest.manifestDigest,
      },
      sourceFragments: [skill],
      riskClass: 3,
    },
    retryPolicy: { maximumAttempts: 1, ambiguityRequiresReconciliation: true },
    approvalPolicy: { required: true, minimumRole: "scientific_reviewer" },
    executionPolicy: { capability: capability.id, riskClass: 3 },
    revision: 1,
    claimOwner: null,
    claimExpiresAt: null,
    jobId: "unit-job",
    attemptId: "unit-attempt",
    createdAt: "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-09-30T00:00:00.000Z",
  });
  const request = BiomolecularSystemBuildRequestSchema.parse({
    schemaVersion: BiomolecularSystemBuildRequestSchemaVersion,
    missionId: original.missionId,
    planId: workUnit.planId,
    planVersion: 1,
    workUnitId: workUnit.id,
    capability,
    intendedJobId: workUnit.jobId,
    intendedAttemptId: workUnit.attemptId,
    inputEvidenceId: evidence[0]!.id,
    inputContentDigest: evidence[0]!.contentDigest,
    systemManifest: { id: system.id, revision: system.revision },
    sourceEvidence: evidence.map((e) => ({ id: e.id, contentDigest: e.contentDigest })),
    decisionRefs: system.decisionRefs,
    forceFieldStack: system.forceFieldStack,
    outputArtifacts: Object.fromEntries(
      ["topology", "coordinates", "atomMap"].map((k) => [
        k,
        {
          evidenceRef: original.artifacts[k as "topology"].evidenceRef,
          mediaType: original.artifacts[k as "topology"].mediaType,
        },
      ]),
    ),
    parametersDigest: digestCanonical(workUnit.protocolFragment.parameters),
    outputContractDigest: digestCanonical(workUnit.outputContract),
  });
  const operation = ExternalOperationSchema.parse({
    id: "unit-operation",
    missionId: original.missionId,
    workUnitId: workUnit.id,
    idempotencyKey: "unit-idempotency",
    kind: "system_preparation",
    state: "confirmed",
    request,
    requestDigest: digestCanonical(request),
    policyDigest: digest("unit-policy"),
    externalIdentity: { publisher: "eigengrid-frozen-amber-material-adoption/v1" },
    receiptId: "unit-receipt",
    revision: 4,
    createdAt: "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-09-30T00:01:00.000Z",
  });
  const receipt = OperationReceiptSchema.parse({
    id: "unit-receipt",
    operationId: operation.id,
    requestDigest: operation.requestDigest,
    status: "confirmed",
    detailDigest: digest("unit-detail"),
    recordedAt: "2026-09-30T00:01:00.000Z",
  });
  const manifestMaterial = {
    ...system,
    schemaVersion: "eigengrid.biomolecular-system-manifest/v2",
    provenance: {
      operationId: operation.id,
      operationReceiptId: receipt.id,
      builder: { name: "eigengrid-frozen-amber-material-adoption", version: "1.0.0" },
      createdBy: {
        id: "eigengrid-amber-material-publication",
        kind: "service",
        role: "scientific-mission-owner",
      },
      createdAt: receipt.recordedAt,
    },
  };
  const systemManifest = {
    ...manifestMaterial,
    manifestDigest: computeBiomolecularSystemManifestDigest(manifestMaterial),
  };
  const { packageDigest: _old, ...packageBase } = original;
  const packageMaterial = { ...packageBase, systemManifest };
  const prepared = assertAmberPreparedSystemPackage({
    ...packageMaterial,
    packageDigest: digestCanonical(packageMaterial),
  });
  return {
    prepared,
    workUnit,
    operation,
    receipt,
    evidence,
    proof: { draft, sourceManifest, sourceManifestEvidenceRef: evidence[1]!.id },
  };
}

describe("frozen prepared-system receipt derivation (unit-only)", () => {
  test("AtomMap package QC requires the full native package and exact published material", () => {
    const input = receiptSourceFixture();
    expect(
      assertAtomMapPackageMaterial(
        input.prepared,
        input.prepared.systemManifest,
        input.prepared.atomMap,
      ).packageDigest,
    ).toBe(input.prepared.packageDigest);
    const changed = structuredClone(input.prepared.systemManifest);
    changed.name = "different unit system";
    expect(() =>
      assertAtomMapPackageMaterial(input.prepared, changed, input.prepared.atomMap),
    ).toThrow(/exact published/);
    const map = structuredClone(input.prepared.atomMap);
    map.entries[0]!.atomName = "other";
    expect(() =>
      assertAtomMapPackageMaterial(input.prepared, input.prepared.systemManifest, map),
    ).toThrow(/exact published/);
  });
  test("proves a distinct final manifest through exact sealed inputs and its confirmed receipt", () => {
    const input = receiptSourceFixture();
    expect(input.workUnit.protocolFragment.parameters.manifestDigest).not.toBe(
      input.prepared.systemManifest.manifestDigest,
    );
    expect(() => assertReceiptDerivedFrozenSource(input)).not.toThrow();
  });
  test("rejects altered bytes, cross-mission source authority, receipt time drift and a bare digest claim", () => {
    const changed = receiptSourceFixture();
    changed.proof.draft.qc.partialChargeTotal = 0.001;
    expect(() => assertReceiptDerivedFrozenSource(changed)).toThrow(/sealed/);
    const cross = receiptSourceFixture();
    cross.evidence[0]!.missionId = "other-unit-mission";
    expect(() => assertReceiptDerivedFrozenSource(cross)).toThrow(/same-mission/);
    const time = receiptSourceFixture();
    time.receipt.recordedAt = "2026-09-30T00:02:00.000Z";
    expect(() => assertReceiptDerivedFrozenSource(time)).toThrow(/receipt-derived/);
    const bare = receiptSourceFixture();
    bare.workUnit.protocolFragment.parameters.manifestDigest = digest("bare-claim");
    expect(() => assertReceiptDerivedFrozenSource(bare)).toThrow(/reviewed system/);
  });
});

describe("prepared AMBER system package gates", () => {
  test("joins canonical AtomMap, force-field digests, Amber outputs, and typed QC", () => {
    const testFixture = fixture();
    const verified = assertPreparedSystemFileBytes(testFixture.value, testFixture.files);
    expect(verified.packageDigest).toBe(testFixture.value.packageDigest);
    expect(verified.systemManifest.atomCount).toBe(1116);
    expect(verified.qc.status).toBe("passed");
  });

  test("rejects stale material hashes, incomplete file bindings, and a changed AtomMap", () => {
    const testFixture = fixture();
    const changedFiles = { ...testFixture.files, "system.rst7": Buffer.from("changed") };
    expect(() => assertPreparedSystemFileBytes(testFixture.value, changedFiles)).toThrow(
      /digest or size mismatch/u,
    );
    expect(() => assertPreparedSystemFileBytes(testFixture.value, {})).toThrow(/missing/u);
    const changed = structuredClone(testFixture.value) as typeof testFixture.value;
    changed.atomMap.entries[0]!.atomName = "CB";
    expect(() => assertPreparedSystemFileBytes(changed, testFixture.files)).toThrow();
  });

  test("rejects an internally rehashed but chemically inconsistent salt ledger", () => {
    const testFixture = fixture();
    const changed = structuredClone(testFixture.value) as typeof testFixture.value;
    changed.qc.ionAddition.sodiumChloridePairCount = 2;
    const qcBytes = new TextEncoder().encode(canonicalJson(changed.qc));
    changed.artifacts.qcReport.sha256 = digestBytes(qcBytes);
    changed.artifacts.qcReport.sizeBytes = qcBytes.byteLength;
    const { packageDigest: _oldPackageDigest, ...packageMaterial } = changed;
    changed.packageDigest = digestCanonical(packageMaterial);
    expect(() =>
      assertPreparedSystemFileBytes(changed, { ...testFixture.files, "qc.json": qcBytes }),
    ).toThrow(/NaCl pairs/u);
  });

  test("rejects non-orthogonal or misoriented membranes before Amber 26 pressure import", () => {
    for (const changedDimension of ["box", "orientation"] as const) {
      const testFixture = fixture();
      const changed = structuredClone(testFixture.value) as typeof testFixture.value;
      const manifest = changed.systemManifest;
      const { manifestDigest: _oldDigest, ...manifestMaterial } = manifest;
      if (changedDimension === "box") (manifest.box as { shape: string }).shape = "triclinic";
      else manifest.membrane!.normalVector = [1, 0, 0];
      manifest.manifestDigest = computeBiomolecularSystemManifestDigest(manifestMaterial);
      const { packageDigest: _oldPackageDigest, ...packageMaterial } = changed;
      changed.packageDigest = digestCanonical(packageMaterial);
      expect(() => assertPreparedSystemFileBytes(changed, testFixture.files)).toThrow(
        /orthogonal XY-oriented box/u,
      );
    }
  });

  test("imports an exactly approved prepared-system package to CAS and publications idempotently", async () => {
    const prepared = fixture();
    const manifest = prepared.value.systemManifest;
    const stack = prepared.value.forceFieldStack;
    const map = prepared.value.atomMap;
    const topologyEvidence = prepared.value.artifacts.topology;
    const coordinatesEvidence = prepared.value.artifacts.coordinates;
    const atomMapEvidence = prepared.value.artifacts.atomMap;
    const snapshotEvidence = prepared.value.artifacts.snapshotPdb;
    const qcEvidence = prepared.value.artifacts.qcReport;
    const buildParameters = {
      manifestId: manifest.id,
      manifestRevision: manifest.revision,
      manifestDigest: manifest.manifestDigest,
    };
    const buildOutputContract = {
      requiredEvidenceKinds: ["topology", "coordinates", "atom_map"],
      requiredObservationKinds: ["artifact_integrity", "topology_integrity"],
    };
    const buildWorkUnit = {
      id: prepared.value.workUnitId,
      missionId: prepared.value.missionId,
      planId: "prepared-system-plan",
      planVersion: 1,
      kind: "scientific_capability",
      state: "succeeded",
      inputRefs: [...manifest.sourceEvidenceRefs, "force-field-stack-evidence"],
      jobId: "job-build-prepared-system",
      attemptId: "attempt-build-prepared-system",
      protocolFragment: {
        kind: "scientific_capability",
        capability: {
          id: "biomolecular.build-system",
          version: "1.0.0",
          contractDigest: digest("build-contract"),
        },
        parameters: buildParameters,
        riskClass: 3,
      },
      executionPolicy: { capability: "biomolecular.build-system", riskClass: 3 },
      outputContract: buildOutputContract,
    };
    const buildInputEvidenceId = manifest.sourceEvidenceRefs[0]!;
    const buildRequest = BiomolecularSystemBuildRequestSchema.parse({
      schemaVersion: BiomolecularSystemBuildRequestSchemaVersion,
      missionId: manifest.missionId,
      planId: buildWorkUnit.planId,
      planVersion: buildWorkUnit.planVersion,
      intendedJobId: buildWorkUnit.jobId,
      intendedAttemptId: buildWorkUnit.attemptId,
      inputEvidenceId: buildInputEvidenceId,
      inputContentDigest: digest(buildInputEvidenceId),
      workUnitId: buildWorkUnit.id,
      capability: buildWorkUnit.protocolFragment.capability,
      systemManifest: { id: manifest.id, revision: manifest.revision },
      sourceEvidence: manifest.sourceEvidenceRefs.map((id) => ({ id, contentDigest: digest(id) })),
      decisionRefs: manifest.decisionRefs,
      forceFieldStack: {
        id: stack.id,
        revision: stack.revision,
        digest: stack.stackDigest,
      },
      outputArtifacts: {
        topology: {
          evidenceRef: topologyEvidence.evidenceRef,
          mediaType: topologyEvidence.mediaType,
        },
        coordinates: {
          evidenceRef: coordinatesEvidence.evidenceRef,
          mediaType: coordinatesEvidence.mediaType,
        },
        atomMap: { evidenceRef: atomMapEvidence.evidenceRef, mediaType: atomMapEvidence.mediaType },
      },
      parametersDigest: digestCanonical(buildParameters),
      outputContractDigest: digestCanonical(buildOutputContract),
    });
    const atomMapParameters = {
      schemaVersion: "eigengrid.biomolecular-material-publication-binding/v1",
      subjectKind: "atom_map",
      subject: { id: map.id, revision: map.revision, digest: map.mapDigest },
      systemManifest: {
        id: manifest.id,
        revision: manifest.revision,
        digest: manifest.manifestDigest,
      },
      sourceEvidenceRefs: [atomMapEvidence.evidenceRef],
      artifactEvidenceRef: atomMapEvidence.evidenceRef,
    };
    const atomMapOutputContract = {
      requiredEvidenceKinds: [],
      requiredObservationKinds: ["artifact_integrity", "topology_integrity"],
    };
    const atomMapWorkUnit = {
      id: "atom-map-publication-work-unit",
      missionId: prepared.value.missionId,
      planId: buildWorkUnit.planId,
      planVersion: buildWorkUnit.planVersion,
      kind: "scientific_capability",
      state: "succeeded",
      inputRefs: [atomMapEvidence.evidenceRef],
      jobId: "job-publish-prepared-system-atom-map",
      attemptId: "attempt-publish-prepared-system-atom-map",
      protocolFragment: {
        kind: "scientific_capability",
        capability: {
          id: "amber.topology-coordinate-validation",
          version: "1.0.0",
          contractDigest: digest("atom-map-contract"),
        },
        parameters: atomMapParameters,
        riskClass: 3,
      },
      executionPolicy: { capability: "amber.topology-coordinate-validation", riskClass: 3 },
      outputContract: atomMapOutputContract,
    };
    const atomMapRequest = AtomMapPublicationRequestSchema.parse({
      schemaVersion: AtomMapPublicationRequestSchemaVersion,
      missionId: manifest.missionId,
      planId: atomMapWorkUnit.planId,
      planVersion: atomMapWorkUnit.planVersion,
      intendedJobId: atomMapWorkUnit.jobId,
      intendedAttemptId: atomMapWorkUnit.attemptId,
      inputEvidenceId: atomMapEvidence.evidenceRef,
      inputContentDigest: atomMapEvidence.sha256,
      workUnitId: atomMapWorkUnit.id,
      capability: atomMapWorkUnit.protocolFragment.capability,
      atomMap: { id: map.id, revision: map.revision, digest: map.mapDigest },
      systemManifest: {
        id: manifest.id,
        revision: manifest.revision,
        digest: manifest.manifestDigest,
      },
      sourceArtifact: {
        evidenceRef: atomMapEvidence.evidenceRef,
        mediaType: atomMapEvidence.mediaType,
      },
      parametersDigest: digestCanonical(atomMapParameters),
      outputContractDigest: digestCanonical(atomMapOutputContract),
    });
    const approvedOperation = (
      id: string,
      workUnitId: string,
      request: unknown,
      receiptId = `${id}-receipt`,
    ) => {
      const requestDigest = digestCanonical(request);
      const approvalId = `approval-${id}`;
      const reviewer = {
        id: "prepared-system-reviewer",
        kind: "human" as const,
        role: "scientific_reviewer",
      };
      return {
        operation: {
          id,
          missionId: prepared.value.missionId,
          workUnitId,
          idempotencyKey: `prepared-system/${id}`,
          kind: "system_preparation",
          state: "confirmed",
          receiptId,
          requestDigest,
          policyDigest: digest("policy"),
          revision: 4,
          request,
          createdAt: "2026-09-27T00:00:00.000Z",
          updatedAt: "2026-09-29T00:00:00.000Z",
        },
        receipt: {
          id: receiptId,
          operationId: id,
          requestDigest,
          status: "confirmed",
          detailDigest: digest("receipt-detail"),
          recordedAt: "2026-09-29T00:00:00.000Z",
        },
        approval: {
          id: approvalId,
          missionId: prepared.value.missionId,
          subjectType: "operation",
          subjectId: id,
          subjectVersion: 1,
          subjectRevision: 1,
          state: "approved",
          requestedFromRole: reviewer.role,
          payloadDigest: requestDigest,
          policyDigest: digest("policy"),
          editableFields: [],
          requestedBy: reviewer,
          requestedAt: "2026-09-27T00:00:00.000Z",
          response: {
            id: `response-${id}`,
            approvalRequestId: approvalId,
            decision: "approved",
            actor: reviewer,
            role: reviewer.role,
            reason: "Reviewed exact prepared-system operation request",
            subjectVersion: 1,
            subjectRevision: 1,
            payloadDigest: requestDigest,
            policyDigest: digest("policy"),
            decidedAt: "2026-09-28T00:00:00.000Z",
          },
        },
      };
    };
    const buildAuthority = approvedOperation(
      "build-operation",
      buildWorkUnit.id,
      buildRequest,
      manifest.provenance.operationReceiptId,
    );
    const atomMapAuthority = approvedOperation(
      "atom-map-operation",
      atomMapWorkUnit.id,
      atomMapRequest,
    );
    const expectedEvidenceRefs = [
      topologyEvidence.evidenceRef,
      coordinatesEvidence.evidenceRef,
      atomMapEvidence.evidenceRef,
      snapshotEvidence.evidenceRef,
      qcEvidence.evidenceRef,
    ].sort();
    const qcObservation = (workUnitId: string, type: string) => ({
      workUnitId,
      type,
      source: { kind: "validator", id: prepared.value.qc.validatorId },
      qualityFlags: [],
      evidenceRefs: expectedEvidenceRefs,
      payload: {
        schemaVersion: "eigengrid.amber-prepared-system-qc-observation/v1",
        packageDigest: prepared.value.packageDigest,
        qcReportDigest: prepared.value.artifacts.qcReport.sha256,
        topologyDigest: prepared.value.qc.topologyDigest,
        coordinatesDigest: prepared.value.qc.coordinatesDigest,
        atomMapDigest: prepared.value.qc.atomMapDigest,
        forceFieldStackDigest: prepared.value.qc.forceFieldStackDigest,
        validatorId: prepared.value.qc.validatorId,
        validatorVersion: prepared.value.qc.validatorVersion,
        status: "passed",
      },
    });
    const provenance: {
      mission: { id: string };
      workUnits: unknown[];
      operations: unknown[];
      receipts: unknown[];
      approvals: unknown[];
      observations: unknown[];
      evidence: Array<Record<string, unknown>>;
    } = {
      mission: { id: prepared.value.missionId },
      workUnits: [buildWorkUnit, atomMapWorkUnit],
      operations: [buildAuthority.operation, atomMapAuthority.operation],
      receipts: [buildAuthority.receipt, atomMapAuthority.receipt],
      approvals: [buildAuthority.approval, atomMapAuthority.approval],
      observations: [
        qcObservation(buildWorkUnit.id, "artifact_integrity"),
        qcObservation(buildWorkUnit.id, "topology_integrity"),
        qcObservation(atomMapWorkUnit.id, "artifact_integrity"),
        qcObservation(atomMapWorkUnit.id, "topology_integrity"),
      ],
      evidence: [
        ...[...new Set(manifest.sourceEvidenceRefs)].map((id) => ({
          id,
          missionId: manifest.missionId,
          kind: "source_snapshot",
          uri: `cas://sha256/${digest(id)}`,
          contentDigest: digest(id),
          immutable: true,
          createdAt: "2026-09-27T00:00:00.000Z",
        })),
        {
          id: atomMapEvidence.evidenceRef,
          missionId: manifest.missionId,
          kind: "atom_map",
          uri: `cas://sha256/${atomMapEvidence.sha256}`,
          contentDigest: atomMapEvidence.sha256,
          sizeBytes: atomMapEvidence.sizeBytes,
          workUnitId: buildWorkUnit.id,
          immutable: true,
          mediaType: atomMapEvidence.mediaType,
          sourceId: buildAuthority.receipt.id,
          createdAt: buildAuthority.receipt.recordedAt,
        },
      ],
    };
    const storedObjects = new Map<string, Uint8Array>();
    const evidenceWrites: string[] = [];
    const manifestWrites: string[] = [];
    const atomMapWrites: string[] = [];
    const directory = await mkdtemp(join(tmpdir(), "eigengrid-prepared-system-import-"));
    try {
      await writeFile(join(directory, "package.json"), JSON.stringify(prepared.value));
      for (const [fileName, bytes] of Object.entries(prepared.files)) {
        await writeFile(join(directory, fileName), bytes);
      }
      const dependencies = {
        directory,
        actor: { id: "owner", kind: "human" as const, role: "scientist" },
        store: {
          async getMissionProjectAssociation() {
            return { ownerUserId: "owner", projectId: "project" };
          },
          async assertProductionMissionPlanningAccess() {},
          async getMissionProvenance() {
            return provenance;
          },
          async createEvidence(reference: Record<string, unknown>) {
            evidenceWrites.push(String(reference.id));
            provenance.evidence.push(reference);
          },
        },
        mdStore: {
          async getForceFieldStack() {
            return stack;
          },
          async putSystemManifest(value: { id: string; revision: number }) {
            manifestWrites.push(`${value.id}:${value.revision}`);
            return value;
          },
          async putAtomMap(value: { id: string; revision: number }) {
            atomMapWrites.push(`${value.id}:${value.revision}`);
            return value;
          },
        },
        artifacts: {
          async putStream(chunks: AsyncIterable<Uint8Array>, options: { maxBytes: number }) {
            const parts: Uint8Array[] = [];
            let size = 0;
            for await (const chunk of chunks) {
              size += chunk.byteLength;
              if (size > options.maxBytes) throw new Error("fixture CAS size overflow");
              parts.push(chunk);
            }
            const bytes = Buffer.concat(parts.map((part) => Buffer.from(part)));
            const sha256 = digestBytes(bytes);
            storedObjects.set(sha256, bytes);
            return { digest: sha256, sizeBytes: bytes.byteLength, uri: `cas://sha256/${sha256}` };
          },
        },
      };

      const first = await importAmberPreparedSystem(dependencies as never);
      const second = await importAmberPreparedSystem(dependencies as never);
      expect(first).toEqual(second);
      expect(first.packageDigest).toBe(prepared.value.packageDigest);
      expect(first.authorityBundleDigest).not.toBe(first.packageDigest);
      expect(first.evidenceRefs).toHaveLength(6);
      expect(storedObjects.size).toBe(6);
      expect(
        provenance.evidence.find((reference) => reference.id === first.evidenceRefs.at(-1)),
      ).toMatchObject({
        contentDigest: first.authorityBundleDigest,
        uri: `cas://sha256/${first.authorityBundleDigest}`,
      });
      const authorityBundle = JSON.parse(
        new TextDecoder().decode(storedObjects.get(first.authorityBundleDigest)),
      );
      expect(authorityBundle).toMatchObject({
        schemaVersion: "eigengrid.amber-prepared-system-cas-bundle/v1",
        authorities: {
          systemBuild: {
            operation: { id: "build-operation" },
            receipt: { id: "build-receipt" },
            approval: {
              id: "approval-build-operation",
              response: {
                decision: "approved",
                payloadDigest: buildAuthority.operation.requestDigest,
              },
            },
          },
          atomMapPublication: {
            operation: { id: "atom-map-operation" },
            receipt: { id: "atom-map-operation-receipt" },
            approval: {
              id: "approval-atom-map-operation",
              response: {
                decision: "approved",
                payloadDigest: atomMapAuthority.operation.requestDigest,
              },
            },
          },
        },
      });
      const changedAuthority = structuredClone(authorityBundle) as {
        authorities: { systemBuild: { approval: { response: { payloadDigest: string } } } };
      };
      changedAuthority.authorities.systemBuild.approval.response.payloadDigest = digest("forged");
      expect(() => AmberPreparedSystemCasBundleSchema.parse(changedAuthority)).toThrow(
        /prior human approval of the exact request/u,
      );
      expect(evidenceWrites).toHaveLength(5);
      expect(manifestWrites).toEqual(["system-manifest:1", "system-manifest:1"]);
      expect(atomMapWrites).toEqual(["system-atom-map:1", "system-atom-map:1"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
