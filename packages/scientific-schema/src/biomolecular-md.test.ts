import { describe, expect, test } from "bun:test";
import { digestCanonical } from "./canonical";
import {
  AtomMapSchema,
  AtomMapSchemaVersion,
  AtomMapPublicationRequestSchema,
  AtomMapPublicationRequestSchemaVersion,
  AtomMapPublicationRequestSchemaVersionV1,
  BiomolecularMaterialPublicationBindingSchema,
  BiomolecularMaterialPublicationBindingSchemaVersion,
  BiomolecularComponentSchemaVersion,
  BiomolecularDecisionSchemaVersion,
  BiomolecularSystemBuildRequestSchema,
  BiomolecularSystemBuildRequestSchemaVersion,
  BiomolecularSystemBuildRequestSchemaVersionV1,
  BiomolecularSystemManifestSchema,
  BiomolecularSystemManifestSchemaVersion,
  ConstructDecisionSchema,
  ForceFieldParameterSetSchema,
  ForceFieldStackDecisionSchema,
  ForceFieldStackPublicationRequestSchema,
  ForceFieldStackPublicationRequestSchemaVersion,
  ForceFieldStackPublicationRequestSchemaVersionV1,
  ForceFieldStackManifestSchema,
  ForceFieldStackSchemaVersion,
  LegacyBiomolecularDecisionSchemaVersion,
  MicrostateDecisionSchema,
  MembraneModelDecisionSchema,
  PoseDecisionSchema,
  PublishedBiomolecularSystemManifestSchemaVersion,
  ReceptorProtonationDecisionSchema,
  ScientificSchemaDigestMismatchError,
  assertAtomMapDigest,
  assertBiomolecularDecisionDigest,
  assertBiomolecularSystemManifestDigest,
  assertPublishedBiomolecularSystemManifestDigest,
  assertForceFieldStackDigest,
  computeBiomolecularDecisionDigest,
  computeBiomolecularSystemManifestDigest,
  computeAtomMapDigest,
  computeForceFieldStackDigest,
} from "./biomolecular";
import {
  MdAcceptanceCriterionSchema,
  MdAssessmentSchemaVersion,
  MdExecutionBindingParametersSchema,
  MdExecutionBindingParametersSchemaVersion,
  MdMetricSeriesSchema,
  MdMetricSeriesSchemaVersion,
  MdProtocolSchemaVersion,
  MdReplicaSetSchemaVersion,
  MdScientificAssessmentSchema,
  MdStageOperationRequestSchema,
  MdStageOperationRequestSchemaVersion,
  MdStageAssessmentSchema,
  MdStageResultSchema,
  MdStageResultSchemaVersion,
  MdStageSchemaVersion,
  MdStageSpecSchema,
  MdWorkflowProtocolSchema,
  ReplicaSetSchema,
  TrajectorySegmentSchema,
  TrajectorySegmentSchemaVersion,
  assertMdMetricSeriesDigest,
  assertMdStageResultDigest,
  assertMdStageSpecDigest,
  assertMdWorkflowProtocolDigest,
  assertTrajectorySegmentDigest,
  computeMdAcceptanceCriterionDigest,
  computeMdMetricSeriesDigest,
  computeMdReplicaSetDigest,
  computeMdReplicaSeedPolicyDigest,
  resolveMdReplicaSegmentSeed,
  computeMdStageResultDigest,
  computeMdStageSpecDigest,
  computeMdWorkflowProtocolDigest,
  computeTrajectorySegmentDigest,
  type MdArtifactRole,
  type MdStageKind,
} from "./md";
import {
  ProtocolFragmentSchema,
  ScientificCapabilityProtocolFragmentSchema,
  WorkUnitSchema,
} from "./schemas";

const digest = (character: string): string => character.repeat(64);
const timestamp = "2026-08-23T12:00:00.000Z";
const actor = { id: "scientist-1", kind: "human" as const, role: "scientific_reviewer" };

const artifact = (role: MdArtifactRole, contentDigest = digest("a")) => ({
  artifactId: `${role}-artifact`,
  evidenceRef: `${role}-evidence`,
  role,
  contentDigest,
  mediaType: "application/octet-stream",
});

const protein = {
  schemaVersion: BiomolecularComponentSchemaVersion,
  id: "protein-receptor",
  revision: 1,
  kind: "protein" as const,
  name: "synthetic protein receptor",
  sourceEvidenceRefs: ["1abc-cif"],
  coordinateDigest: digest("1"),
  atomCount: 3,
  moleculeCount: 1,
  formalCharge: -1,
  role: "receptor" as const,
  chainIds: ["A"],
  residueCount: 1,
  sequenceDigest: digest("2"),
  protonationDecisionId: "protonation-receptor-r1",
};

const ligand = {
  schemaVersion: BiomolecularComponentSchemaVersion,
  id: "ligand-fixture-compound-d",
  revision: 1,
  kind: "ligand" as const,
  name: "fixture-compound-d",
  sourceEvidenceRefs: ["pubchem-4"],
  coordinateDigest: digest("3"),
  atomCount: 2,
  moleculeCount: 1,
  formalCharge: 1,
  pubchemCid: 4,
  inchiKey: `${"A".repeat(14)}-${"B".repeat(10)}-C`,
  stereochemistry: "achiral",
  microstateDecisionId: "microstate-fixture-compound-d-r1",
  poseDecisionId: "pose-fixture-compound-d-r1",
};

const lipid = {
  schemaVersion: BiomolecularComponentSchemaVersion,
  id: "lipid-popc",
  revision: 1,
  kind: "lipid" as const,
  name: "POPC membrane",
  sourceEvidenceRefs: ["membrane-builder-evidence"],
  coordinateDigest: digest("4"),
  atomCount: 4,
  moleculeCount: 2,
  formalCharge: 0,
  residueName: "POPC",
  lipidIdentity: "1-palmitoyl-2-oleoyl-sn-glycero-3-phosphocholine",
};

const water = {
  schemaVersion: BiomolecularComponentSchemaVersion,
  id: "water-tip3p",
  revision: 1,
  kind: "water" as const,
  name: "TIP3P water",
  sourceEvidenceRefs: ["solvation-evidence"],
  coordinateDigest: digest("5"),
  atomCount: 6,
  moleculeCount: 2,
  formalCharge: 0,
  waterModel: "TIP3P",
};

const manifest = {
  schemaVersion: PublishedBiomolecularSystemManifestSchemaVersion,
  id: "system-1abc-fixture-compound-d",
  revision: 1,
  missionId: "mission-1",
  name: "1ABC with fixture-compound-d",
  sourceEvidenceRefs: ["1abc-cif", "pubchem-4"],
  constructDecisionId: "construct-1abc-r1",
  forceFieldStackDecisionId: "force-field-stack-r1",
  membraneModelDecisionId: "membrane-model-r1",
  decisionRefs: [
    {
      id: "construct-1abc-r1",
      revision: 1,
      kind: "construct" as const,
      decisionDigest: digest("c"),
      approvalRef: "approval-construct-1",
    },
    {
      id: "microstate-fixture-compound-d-r1",
      revision: 1,
      kind: "microstate" as const,
      decisionDigest: digest("d"),
      approvalRef: "approval-microstate-1",
    },
    {
      id: "pose-fixture-compound-d-r1",
      revision: 1,
      kind: "pose" as const,
      decisionDigest: digest("e"),
      approvalRef: "approval-pose-1",
    },
    {
      id: "force-field-stack-r1",
      revision: 1,
      kind: "force_field_stack" as const,
      decisionDigest: digest("f"),
      approvalRef: "approval-force-field-1",
    },
    {
      id: "membrane-model-r1",
      revision: 1,
      kind: "membrane_model" as const,
      decisionDigest: digest("1"),
      approvalRef: "approval-membrane-1",
    },
    {
      id: "protonation-receptor-r1",
      revision: 1,
      kind: "protonation" as const,
      decisionDigest: digest("2"),
      approvalRef: "approval-protonation-1",
    },
  ],
  components: {
    proteins: [protein],
    ligands: [ligand],
    lipids: [lipid],
    waters: [water],
    ions: [],
    cofactors: [],
  },
  membrane: {
    orientationProvider: "PPM",
    orientationProviderVersion: "3.0",
    orientationEvidenceRef: "ppm-snapshot",
    orientationDigest: digest("6"),
    normalVector: [0, 0, 1] as [number, number, number],
    hydrophobicThicknessAngstrom: 30,
    composition: [{ lipidComponentId: "lipid-popc", upperLeafletCount: 1, lowerLeafletCount: 1 }],
  },
  environment: {
    targetPh: 7.4,
    targetTemperatureKelvin: 310,
    targetPressureBar: 1,
    targetIonicStrengthMolar: 0.15,
  },
  forceFieldStack: { id: "ff-stack-1", revision: 1, digest: digest("7") },
  topologyDigest: digest("8"),
  coordinateDigest: digest("9"),
  atomMapDigest: digest("a"),
  totalCharge: 0,
  atomCount: 15,
  box: {
    shape: "orthorhombic" as const,
    lengthsAngstrom: [80, 80, 100] as [number, number, number],
    anglesDegrees: [90, 90, 90] as [number, number, number],
    periodic: true as const,
  },
  provenance: {
    operationId: "operation-build-1",
    builder: { name: "fixture-builder", version: "1.0.0" },
    createdBy: actor,
    createdAt: timestamp,
  },
  manifestDigest: digest("b"),
};

const parameterSet = (id: string, parameterDigest: string) => ({
  id,
  family: id,
  version: "1.0",
  source: "fixture",
  sourceEvidenceRefs: [`${id}-source`],
  parameterDigest,
  knownLimitations: ["fixture only"],
});

const criterionBase = {
  schemaVersion: MdAssessmentSchemaVersion,
  id: "normal-termination",
  kind: "normal_termination" as const,
  description: "Engine terminates normally",
  required: true,
  evaluatorVersion: "1.0.0",
};
const criterion = {
  ...criterionBase,
  criterionDigest: computeMdAcceptanceCriterionDigest(criterionBase),
};

const systemReference = {
  id: manifest.id,
  revision: manifest.revision,
  systemClass: "membrane" as const,
  manifestDigest: manifest.manifestDigest,
  topologyDigest: manifest.topologyDigest,
  coordinateDigest: manifest.coordinateDigest,
  atomMapDigest: manifest.atomMapDigest,
};

function stage(sequence: number, kind: MdStageKind) {
  const dynamics = kind !== "minimization";
  const npt = kind === "equilibration" || kind === "production";
  return {
    schemaVersion: MdStageSchemaVersion,
    id: `stage-${sequence}`,
    revision: 1,
    sequence,
    kind,
    name: `${kind} ${sequence}`,
    system: systemReference,
    parentStageId: sequence === 1 ? null : `stage-${sequence - 1}`,
    requiredParentOutputRole: sequence === 1 ? null : ("restart" as const),
    inputs:
      sequence === 1
        ? [
            artifact("topology", manifest.topologyDigest),
            artifact("coordinates", manifest.coordinateDigest),
          ]
        : [artifact("topology", manifest.topologyDigest)],
    ensemble: dynamics ? (npt ? ("npt" as const) : ("nvt" as const)) : ("none" as const),
    steps: dynamics ? 1_000 : 100,
    timeStepPs: dynamics ? 0.002 : null,
    simulatedTimePs: dynamics ? 2 : null,
    temperature: dynamics
      ? {
          points:
            kind === "heating"
              ? [
                  { step: 0, kelvin: 0 },
                  { step: 1_000, kelvin: 310 },
                ]
              : [{ step: 0, kelvin: 310 }],
        }
      : null,
    thermostat: dynamics
      ? { kind: "langevin" as const, collisionFrequencyPerPs: 1 }
      : { kind: "none" as const },
    barostat: npt
      ? {
          kind: "monte_carlo" as const,
          coupling: "semiisotropic" as const,
          targetPressureBar: 1,
          relaxationTimePs: 2,
        }
      : { kind: "none" as const },
    constraints: dynamics
      ? { bondsToHydrogen: true, tolerance: 0.00001, maximumIterations: 1_000 }
      : { bondsToHydrogen: false },
    restraints: [],
    nonbonded: {
      cutoffAngstrom: 10,
      electrostatics: "pme" as const,
      ewaldTolerance: 0.00001,
      periodicBoundary: true as const,
    },
    randomSeed: dynamics ? { policy: "fixed" as const, seed: 10_000 + sequence } : null,
    resourceProfile: {
      backendCapabilityId: "local-cpu",
      cpuCores: 2,
      gpuCount: 0,
      memoryBytes: 1_000_000,
      scratchBytes: 1_000_000,
      wallTimeSeconds: 600,
    },
    checkpoint: {
      cadenceSteps: dynamics ? 500 : 50,
      retainCount: 2,
      stopAfterCheckpointSupported: true,
    },
    outputs: [
      { role: "restart" as const, required: true, mediaType: "application/octet-stream" },
      { role: "mdout" as const, required: true, mediaType: "text/plain" },
      { role: "mdinfo" as const, required: true, mediaType: "text/plain" },
      ...(kind === "production"
        ? [
            {
              role: "trajectory" as const,
              required: true,
              mediaType: "application/x-amber-netcdf",
              cadenceSteps: 100,
            },
          ]
        : []),
    ],
    acceptanceCriteria: [criterion],
    sourceDecisionRefs: ["restraint-policy-1"],
    rendererCompatibilityVersion: "1.0.0",
    stageDigest: digest(String(sequence)),
  };
}

const stages = [
  stage(1, "minimization"),
  stage(2, "heating"),
  stage(3, "equilibration"),
  stage(4, "production"),
];

const protocol = {
  schemaVersion: MdProtocolSchemaVersion,
  id: "md-protocol-1",
  missionId: "mission-1",
  revision: 1,
  status: "approved" as const,
  system: systemReference,
  forceFieldStack: { id: "ff-stack-1", revision: 1, digest: digest("7") },
  targetEngine: { family: "amber" as const, versionRange: ">=24" },
  capabilityRefs: [{ id: "amber.production-md", version: "1.0.0", contractDigest: digest("d") }],
  stages,
  decisionRefs: ["construct-1abc-r1", "force-field-stack-r1"],
  assumptions: ["Technical benchmark of an inactive engineered construct"],
  skillRefs: [{ skillId: "amber.production-md", version: "1.0.0", contentDigest: digest("e") }],
  compilerVersion: "1.0.0",
  protocolDigest: digest("f"),
  approvedByRef: "approval-protocol-1",
  createdAt: timestamp,
  updatedAt: timestamp,
};

describe("biomolecular contracts", () => {
  test("accepts a strict, digest-bound membrane system manifest", () => {
    const parsed = BiomolecularSystemManifestSchema.parse(manifest);
    const signedManifest = {
      ...manifest,
      manifestDigest: computeBiomolecularSystemManifestDigest(manifest),
    };

    expect(parsed.atomCount).toBe(15);
    expect(parsed.totalCharge).toBe(0);
    expect(digestCanonical(parsed)).toMatch(/^[a-f0-9]{64}$/u);
    expect(digestCanonical(parsed)).toBe(digestCanonical({ ...parsed }));
    expect(assertBiomolecularSystemManifestDigest(signedManifest).id).toBe(manifest.id);
    expect(assertPublishedBiomolecularSystemManifestDigest(signedManifest).id).toBe(manifest.id);
    expect(() =>
      assertBiomolecularSystemManifestDigest({ ...signedManifest, name: "tampered name" }),
    ).toThrow(ScientificSchemaDigestMismatchError);
  });

  test("separates legacy v1 drafts from decision-authorized v2 publication", () => {
    const {
      forceFieldStackDecisionId: _forceFieldStackDecisionId,
      membraneModelDecisionId: _membraneModelDecisionId,
      ...legacyFields
    } = manifest;
    const legacyProtein = { ...protein, protonationDecisionId: undefined };
    const legacy = {
      ...legacyFields,
      schemaVersion: BiomolecularSystemManifestSchemaVersion,
      decisionRefs: legacyFields.decisionRefs.filter((reference) =>
        ["construct", "microstate", "pose"].includes(reference.kind),
      ),
      components: { ...legacyFields.components, proteins: [legacyProtein] },
      manifestDigest: digest("0"),
    };
    const signedLegacy = {
      ...legacy,
      manifestDigest: computeBiomolecularSystemManifestDigest(legacy),
    };
    expect(BiomolecularSystemManifestSchema.safeParse(signedLegacy).success).toBe(true);
    expect(() => assertPublishedBiomolecularSystemManifestDigest(signedLegacy)).toThrow(
      /publication requires biomolecular manifest v2/,
    );
    expect(
      BiomolecularSystemManifestSchema.safeParse({
        ...signedLegacy,
        forceFieldStackDecisionId: manifest.forceFieldStackDecisionId,
      }).success,
    ).toBe(false);
    expect(
      BiomolecularSystemManifestSchema.safeParse({
        ...manifest,
        forceFieldStackDecisionId: undefined,
      }).success,
    ).toBe(false);
    expect(
      BiomolecularSystemManifestSchema.safeParse({
        ...manifest,
        membraneModelDecisionId: undefined,
      }).success,
    ).toBe(false);
    expect(
      BiomolecularSystemManifestSchema.safeParse({
        ...manifest,
        components: {
          ...manifest.components,
          proteins: [{ ...protein, protonationDecisionId: undefined }],
        },
      }).success,
    ).toBe(false);
  });

  test("binds a system build to exact source, decisions, outputs, and capability", () => {
    const request = {
      schemaVersion: BiomolecularSystemBuildRequestSchemaVersion,
      missionId: "mission-build-system",
      planId: "plan-build-system",
      planVersion: 1,
      intendedJobId: "job-build-system-1",
      intendedAttemptId: "attempt-build-system-1",
      inputEvidenceId: "1abc-cif",
      inputContentDigest: digest("1"),
      workUnitId: "work-unit-build-system",
      capability: {
        id: "biomolecular.build-system",
        version: "1.0.0",
        contractDigest: digest("b"),
      },
      systemManifest: {
        id: manifest.id,
        revision: manifest.revision,
      },
      sourceEvidence: [
        { id: "1abc-cif", contentDigest: digest("1") },
        { id: "pubchem-4", contentDigest: digest("2") },
      ],
      decisionRefs: manifest.decisionRefs,
      forceFieldStack: manifest.forceFieldStack,
      outputArtifacts: {
        topology: {
          evidenceRef: "topology-evidence",
          mediaType: "application/octet-stream",
        },
        coordinates: {
          evidenceRef: "coordinates-evidence",
          mediaType: "application/octet-stream",
        },
        atomMap: {
          evidenceRef: "atom-map-evidence",
          mediaType: "application/json",
        },
      },
      parametersDigest: digest("c"),
      outputContractDigest: digest("d"),
    };
    expect(BiomolecularSystemBuildRequestSchema.parse(request).workUnitId).toBe(
      "work-unit-build-system",
    );
    const {
      missionId: _missionId,
      planId: _planId,
      planVersion: _planVersion,
      intendedJobId: _jobId,
      intendedAttemptId: _attemptId,
      inputEvidenceId: _inputEvidenceId,
      inputContentDigest: _inputContentDigest,
      ...legacyRequestFields
    } = request;
    expect(
      BiomolecularSystemBuildRequestSchema.parse({
        ...legacyRequestFields,
        schemaVersion: BiomolecularSystemBuildRequestSchemaVersionV1,
      }).workUnitId,
    ).toBe("work-unit-build-system");
    expect(
      BiomolecularSystemBuildRequestSchema.safeParse({
        ...request,
        rawAmberCommand: "tleap -f leap.in",
      }).success,
    ).toBe(false);
    expect(
      BiomolecularSystemBuildRequestSchema.safeParse({
        ...request,
        outputArtifacts: {
          ...request.outputArtifacts,
          atomMap: {
            ...request.outputArtifacts.atomMap,
            evidenceRef: request.outputArtifacts.topology.evidenceRef,
          },
        },
      }).success,
    ).toBe(false);
    expect(
      BiomolecularSystemBuildRequestSchema.safeParse({
        ...request,
        sourceEvidence: [request.sourceEvidence[0], request.sourceEvidence[0]],
      }).success,
    ).toBe(false);
    expect(
      BiomolecularSystemBuildRequestSchema.safeParse({
        ...request,
        inputEvidenceId: "evidence-from-another-work-unit",
      }).success,
    ).toBe(false);
  });

  test("rejects unknown fields and upper-case or malformed digests", () => {
    expect(
      BiomolecularSystemManifestSchema.safeParse({
        ...manifest,
        rawAmberCommand: "tleap -f leap.in",
      }).success,
    ).toBe(false);
    expect(
      BiomolecularSystemManifestSchema.safeParse({ ...manifest, topologyDigest: "A".repeat(64) })
        .success,
    ).toBe(false);
  });

  test("checks aggregate atom count, charge, receptor ownership, and membrane composition", () => {
    expect(BiomolecularSystemManifestSchema.safeParse({ ...manifest, atomCount: 14 }).success).toBe(
      false,
    );
    expect(
      BiomolecularSystemManifestSchema.safeParse({ ...manifest, totalCharge: 1 }).success,
    ).toBe(false);
    expect(
      BiomolecularSystemManifestSchema.safeParse({
        ...manifest,
        components: {
          ...manifest.components,
          proteins: [{ ...protein, role: "fusion" }],
        },
      }).success,
    ).toBe(false);
    expect(
      BiomolecularSystemManifestSchema.safeParse({
        ...manifest,
        membrane: {
          ...manifest.membrane,
          composition: [
            { lipidComponentId: "lipid-popc", upperLeafletCount: 1, lowerLeafletCount: 0 },
          ],
        },
      }).success,
    ).toBe(false);
  });

  test("requires exact approval evidence for approved construct decisions", () => {
    const decisionBase = {
      schemaVersion: BiomolecularDecisionSchemaVersion,
      id: "construct-1abc-r1",
      missionId: "mission-1",
      revision: 1,
      status: "approved" as const,
      kind: "construct" as const,
      rationale: "Preserve the benchmark construct for technical comparison",
      evidenceRefs: ["1abc-cif"],
      decidedBy: actor,
      approvalRef: "approval-construct-1",
      approvedAt: timestamp,
      createdAt: timestamp,
      sourceStructureDigest: digest("2"),
      chainPolicies: [{ chainId: "A", action: "preserve" as const, reason: "benchmark" }],
      mutationPolicies: [],
      missingRegionPolicies: [],
      terminiPolicy: "preserve modeled termini",
      fusionPolicy: "preserve BRIL for the technical control",
      disulfidePolicy: "preserve validated disulfides",
      outputConstructDigest: digest("3"),
    };
    const decision = {
      ...decisionBase,
      decisionDigest: computeBiomolecularDecisionDigest(decisionBase),
    };

    expect(ConstructDecisionSchema.safeParse(decision).success).toBe(true);
    expect(assertBiomolecularDecisionDigest(decision)).toEqual(decision);
    expect(
      ConstructDecisionSchema.safeParse({
        ...decision,
        schemaVersion: LegacyBiomolecularDecisionSchemaVersion,
      }).success,
    ).toBe(false);
    const { approvalRef: _approvalRef, ...withoutApproval } = decision;
    expect(ConstructDecisionSchema.safeParse(withoutApproval).success).toBe(false);

    const proposedBase = {
      ...decisionBase,
      status: "proposed" as const,
      approvalRef: undefined,
      approvedAt: undefined,
    };
    const proposed = {
      ...proposedBase,
      decisionDigest: computeBiomolecularDecisionDigest(proposedBase),
    };
    expect(proposed.decisionDigest).toBe(decision.decisionDigest);
    expect(assertBiomolecularDecisionDigest(proposed)).toEqual(proposed);
    expect(() =>
      assertBiomolecularDecisionDigest({ ...decision, rationale: "unreviewed mutation" }),
    ).toThrow(ScientificSchemaDigestMismatchError);
  });

  test("binds a microstate and pose selection to enumerated candidates", () => {
    const microstate = {
      schemaVersion: BiomolecularDecisionSchemaVersion,
      id: "microstate-fixture-compound-d-r1",
      missionId: "mission-1",
      revision: 1,
      status: "proposed" as const,
      kind: "microstate" as const,
      rationale: "Enumerated at the target pH",
      evidenceRefs: ["microstate-enumeration"],
      decidedBy: actor,
      decisionDigest: digest("4"),
      createdAt: timestamp,
      subjectComponentId: ligand.id,
      subjectKind: "ligand" as const,
      targetPh: 7.4,
      temperatureKelvin: 310,
      method: "enumerator 1.0",
      alternatives: [
        {
          id: "protonated",
          label: "protonated amine",
          formalCharge: 1,
          protonationDescription: "protonated primary amine",
          tautomerDescription: "indole tautomer",
          structureDigest: digest("5"),
        },
      ],
      selectedAlternativeId: "protonated",
      selectedFormalCharge: 1,
    };
    expect(MicrostateDecisionSchema.safeParse(microstate).success).toBe(true);
    expect(
      MicrostateDecisionSchema.safeParse({ ...microstate, selectedFormalCharge: 0 }).success,
    ).toBe(false);

    const pose = {
      schemaVersion: BiomolecularDecisionSchemaVersion,
      id: "pose-fixture-compound-d-r1",
      missionId: "mission-1",
      revision: 1,
      status: "proposed" as const,
      kind: "pose" as const,
      rationale: "Candidate passes deterministic pocket checks",
      evidenceRefs: ["pose-qc"],
      decidedBy: actor,
      decisionDigest: digest("6"),
      createdAt: timestamp,
      receptorComponentId: protein.id,
      ligandComponentId: ligand.id,
      pocketDefinitionDigest: digest("7"),
      candidates: [
        {
          id: "pose-1",
          method: "pharmacophore" as const,
          coordinateDigest: digest("8"),
          atomMapDigest: digest("9"),
          generatorVersion: "1.0",
          seed: 0,
          validationEvidenceRefs: ["pose-qc"],
        },
      ],
      selectedCandidateId: "pose-1",
      selectionCriteria: ["no severe clashes"],
      uncertainty: "high" as const,
    };
    expect(PoseDecisionSchema.safeParse(pose).success).toBe(true);
    expect(PoseDecisionSchema.safeParse({ ...pose, selectedCandidateId: "missing" }).success).toBe(
      false,
    );
  });

  test("types force-field, membrane, and receptor protonation decisions fail closed", () => {
    const forceFieldBase = {
      schemaVersion: BiomolecularDecisionSchemaVersion,
      id: "force-field-stack-r1",
      missionId: "mission-1",
      revision: 1,
      status: "proposed" as const,
      kind: "force_field_stack" as const,
      rationale: "Select one exact compatible stack revision",
      evidenceRefs: ["force-field-stack-evidence"],
      decidedBy: actor,
      createdAt: timestamp,
      candidates: [
        {
          id: manifest.forceFieldStack.id,
          revision: manifest.forceFieldStack.revision,
          digest: manifest.forceFieldStack.digest,
          evidenceRef: "force-field-stack-evidence",
          limitations: ["fixture only"],
        },
      ],
      selectedStack: manifest.forceFieldStack,
      compatibilityCriteria: ["same protein/lipid/water/ion parameter stack"],
    };
    const forceField = {
      ...forceFieldBase,
      decisionDigest: computeBiomolecularDecisionDigest(forceFieldBase),
    };
    expect(assertBiomolecularDecisionDigest(forceField)).toEqual(forceField);
    expect(
      ForceFieldStackDecisionSchema.safeParse({
        ...forceField,
        selectedStack: { ...forceField.selectedStack, revision: 2 },
      }).success,
    ).toBe(false);
    expect(
      ForceFieldStackDecisionSchema.safeParse({
        ...forceField,
        evidenceRefs: ["unrelated-evidence"],
      }).success,
    ).toBe(false);

    const membraneBase = {
      schemaVersion: BiomolecularDecisionSchemaVersion,
      id: "membrane-model-r1",
      missionId: "mission-1",
      revision: 1,
      status: "proposed" as const,
      kind: "membrane_model" as const,
      rationale: "Bind the selected orientation and composition",
      evidenceRefs: [protein.sourceEvidenceRefs[0]!, manifest.membrane.orientationEvidenceRef],
      decidedBy: actor,
      createdAt: timestamp,
      receptorComponentId: protein.id,
      receptorCoordinateDigest: protein.coordinateDigest,
      receptorCoordinateEvidenceRef: protein.sourceEvidenceRefs[0]!,
      membraneDigest: digestCanonical(manifest.membrane),
      orientationDigest: manifest.membrane.orientationDigest,
      orientationEvidenceRef: manifest.membrane.orientationEvidenceRef,
      selectionCriteria: ["approved membrane orientation"],
      knownLimitations: ["fixture only"],
    };
    const membrane = {
      ...membraneBase,
      decisionDigest: computeBiomolecularDecisionDigest(membraneBase),
    };
    expect(assertBiomolecularDecisionDigest(membrane)).toEqual(membrane);
    expect(
      MembraneModelDecisionSchema.safeParse({
        ...membrane,
        evidenceRefs: [membrane.orientationEvidenceRef],
      }).success,
    ).toBe(false);

    const protonationBase = {
      schemaVersion: BiomolecularDecisionSchemaVersion,
      id: "protonation-receptor-r1",
      missionId: "mission-1",
      revision: 1,
      status: "proposed" as const,
      kind: "protonation" as const,
      rationale: "Bind explicit receptor residue states",
      evidenceRefs: [protein.sourceEvidenceRefs[0]!],
      decidedBy: actor,
      createdAt: timestamp,
      subjectKind: "protein" as const,
      subjectRole: "receptor" as const,
      subjectComponentId: protein.id,
      targetPh: manifest.environment.targetPh,
      temperatureKelvin: manifest.environment.targetTemperatureKelvin,
      method: "fixture-review 1.0",
      inputCoordinateDigest: digest("3"),
      inputCoordinateEvidenceRef: protein.sourceEvidenceRefs[0]!,
      residueStates: [
        {
          chainId: "A",
          residueNumber: 1,
          residueName: "ASP",
          selectedState: "deprotonated",
          formalCharge: -1,
        },
      ],
      terminiPolicy: "explicit fixture termini",
      selectedFormalCharge: protein.formalCharge,
      outputCoordinateDigest: protein.coordinateDigest,
      outputCoordinateEvidenceRef: protein.sourceEvidenceRefs[0]!,
    };
    const protonation = {
      ...protonationBase,
      inputCoordinateDigest: protein.coordinateDigest,
      decisionDigest: computeBiomolecularDecisionDigest({
        ...protonationBase,
        inputCoordinateDigest: protein.coordinateDigest,
      }),
    };
    expect(assertBiomolecularDecisionDigest(protonation)).toEqual(protonation);
    expect(
      ReceptorProtonationDecisionSchema.safeParse({
        ...protonation,
        evidenceRefs: ["unrelated-evidence"],
      }).success,
    ).toBe(false);
    expect(() =>
      assertBiomolecularDecisionDigest({
        ...protonation,
        selectedFormalCharge: protein.formalCharge + 1,
      }),
    ).toThrow(ScientificSchemaDigestMismatchError);
  });

  test("validates force-field stack uniqueness and atom-map contiguity", () => {
    const stack = {
      schemaVersion: ForceFieldStackSchemaVersion,
      id: "ff-stack-1",
      revision: 1,
      protein: parameterSet("ff19SB", digest("1")),
      lipid: parameterSet("lipid21", digest("2")),
      ligands: [
        {
          componentId: ligand.id,
          parameterSet: parameterSet("gaff2", digest("3")),
          chargeMethod: "AM1-BCC",
          chargeMethodVersion: "sqm fixture",
          formalCharge: 1,
          atomTypeDigest: digest("4"),
          chargeDigest: digest("5"),
        },
      ],
      water: { model: "TIP3P", parameterSet: parameterSet("tip3p", digest("6")) },
      ions: parameterSet("ionsjc_tip3p", digest("7")),
      cofactors: [],
      engineCompatibility: [{ engine: "amber", versionRange: ">=24" }],
      compatibilityEvidenceRefs: ["compatibility-review"],
      knownLimitations: ["fixture only"],
      stackDigest: digest("8"),
      createdAt: timestamp,
    };
    expect(ForceFieldStackManifestSchema.safeParse(stack).success).toBe(true);
    const signedStack = { ...stack, stackDigest: computeForceFieldStackDigest(stack) };
    expect(assertForceFieldStackDigest(signedStack).id).toBe(stack.id);
    expect(() =>
      assertForceFieldStackDigest({
        ...signedStack,
        knownLimitations: [...signedStack.knownLimitations, "tampered"],
      }),
    ).toThrow(ScientificSchemaDigestMismatchError);
    expect(ForceFieldParameterSetSchema.safeParse({ ...stack.protein, family: "" }).success).toBe(
      false,
    );
    expect(
      ForceFieldStackManifestSchema.safeParse({
        ...stack,
        ligands: [...stack.ligands, stack.ligands[0]],
      }).success,
    ).toBe(false);

    const atomMap = {
      schemaVersion: AtomMapSchemaVersion,
      id: "atom-map-1",
      revision: 1,
      systemManifestId: manifest.id,
      systemManifestRevision: 1,
      indexBase: 1 as const,
      atomCount: 2,
      topologyDigest: manifest.topologyDigest,
      coordinateDigest: manifest.coordinateDigest,
      entries: [
        {
          systemAtomIndex: 1,
          componentId: protein.id,
          componentAtomIndex: 1,
          chainId: "A",
          residueIndex: 1,
          residueName: "ALA",
          atomName: "N",
          element: "N",
        },
        {
          systemAtomIndex: 2,
          componentId: protein.id,
          componentAtomIndex: 2,
          chainId: "A",
          residueIndex: 1,
          residueName: "ALA",
          atomName: "CA",
          element: "C",
        },
      ],
      mapDigest: digest("9"),
    };
    expect(AtomMapSchema.safeParse(atomMap).success).toBe(true);
    const signedAtomMap = { ...atomMap, mapDigest: computeAtomMapDigest(atomMap) };
    expect(assertAtomMapDigest(signedAtomMap).id).toBe(atomMap.id);
    expect(() =>
      assertAtomMapDigest({ ...signedAtomMap, entries: signedAtomMap.entries.slice(1) }),
    ).toThrow();
    expect(
      AtomMapSchema.safeParse({
        ...atomMap,
        entries: atomMap.entries.map((entry, index) => ({
          ...entry,
          systemAtomIndex: index === 0 ? 1 : 3,
        })),
      }).success,
    ).toBe(false);
    expect(
      AtomMapSchema.safeParse({
        ...atomMap,
        entries: atomMap.entries.map((entry, index) => ({
          ...entry,
          componentAtomIndex: index === 0 ? 1 : 3,
        })),
      }).success,
    ).toBe(false);
  });

  test("keeps material publication bindings typed and command-free", () => {
    const stackBinding = {
      schemaVersion: BiomolecularMaterialPublicationBindingSchemaVersion,
      subjectKind: "force_field_stack" as const,
      subject: { id: "ff-stack-1", revision: 1, digest: digest("1") },
      sourceEvidenceRefs: ["ff-source-1"],
      artifactEvidenceRef: "ff-stack-artifact",
    };
    expect(BiomolecularMaterialPublicationBindingSchema.parse(stackBinding).subjectKind).toBe(
      "force_field_stack",
    );
    const stackRequest = {
      schemaVersion: ForceFieldStackPublicationRequestSchemaVersion,
      missionId: "mission-build-system",
      planId: "plan-build-system",
      planVersion: 1,
      intendedJobId: "job-stack-1",
      intendedAttemptId: "attempt-stack-1",
      inputEvidenceId: "ff-source-1",
      inputContentDigest: digest("3"),
      workUnitId: "work-stack-1",
      capability: {
        id: "amber.force-field-stack",
        version: "1.0.0",
        contractDigest: digest("2"),
      },
      stack: stackBinding.subject,
      sourceEvidence: [{ id: "ff-source-1", contentDigest: digest("3") }],
      outputArtifact: {
        evidenceRef: stackBinding.artifactEvidenceRef,
        mediaType: "application/vnd.eigengrid.force-field-stack+json",
      },
      parametersDigest: digest("4"),
      outputContractDigest: digest("5"),
    };
    expect(ForceFieldStackPublicationRequestSchema.parse(stackRequest).stack.id).toBe("ff-stack-1");
    const {
      missionId: _stackMissionId,
      planId: _stackPlanId,
      planVersion: _stackPlanVersion,
      intendedJobId: _stackJobId,
      intendedAttemptId: _stackAttemptId,
      inputEvidenceId: _stackInputEvidenceId,
      inputContentDigest: _stackInputContentDigest,
      ...legacyStackRequestFields
    } = stackRequest;
    expect(
      ForceFieldStackPublicationRequestSchema.parse({
        ...legacyStackRequestFields,
        schemaVersion: ForceFieldStackPublicationRequestSchemaVersionV1,
      }).stack.id,
    ).toBe("ff-stack-1");
    expect(
      ForceFieldStackPublicationRequestSchema.safeParse({
        ...stackRequest,
        sourceEvidence: [stackRequest.sourceEvidence[0], stackRequest.sourceEvidence[0]],
      }).success,
    ).toBe(false);
    expect(
      ForceFieldStackPublicationRequestSchema.safeParse({
        ...stackRequest,
        executable: "bash",
      }).success,
    ).toBe(false);
    expect(
      ForceFieldStackPublicationRequestSchema.safeParse({
        ...stackRequest,
        inputContentDigest: digest("0"),
      }).success,
    ).toBe(false);

    const atomMapRequest = {
      schemaVersion: AtomMapPublicationRequestSchemaVersion,
      missionId: "mission-build-system",
      planId: "plan-build-system",
      planVersion: 1,
      intendedJobId: "job-atom-map-1",
      intendedAttemptId: "attempt-atom-map-1",
      inputEvidenceId: "atom-map-artifact",
      inputContentDigest: digest("7"),
      workUnitId: "work-atom-map-1",
      capability: {
        id: "amber.topology-coordinate-validation",
        version: "1.0.0",
        contractDigest: digest("6"),
      },
      atomMap: { id: "atom-map-1", revision: 1, digest: digest("7") },
      systemManifest: { id: manifest.id, revision: 1, digest: manifest.manifestDigest },
      sourceArtifact: {
        evidenceRef: "atom-map-artifact",
        mediaType: "application/vnd.eigengrid.atom-map+json",
      },
      parametersDigest: digest("8"),
      outputContractDigest: digest("9"),
    };
    expect(AtomMapPublicationRequestSchema.parse(atomMapRequest).systemManifest.id).toBe(
      manifest.id,
    );
    const {
      missionId: _mapMissionId,
      planId: _mapPlanId,
      planVersion: _mapPlanVersion,
      intendedJobId: _mapJobId,
      intendedAttemptId: _mapAttemptId,
      inputEvidenceId: _mapInputEvidenceId,
      inputContentDigest: _mapInputContentDigest,
      ...legacyAtomMapRequestFields
    } = atomMapRequest;
    expect(
      AtomMapPublicationRequestSchema.parse({
        ...legacyAtomMapRequestFields,
        schemaVersion: AtomMapPublicationRequestSchemaVersionV1,
      }).systemManifest.id,
    ).toBe(manifest.id);
    expect(
      AtomMapPublicationRequestSchema.safeParse({ ...atomMapRequest, argv: ["tleap"] }).success,
    ).toBe(false);
    expect(
      AtomMapPublicationRequestSchema.safeParse({
        ...atomMapRequest,
        inputContentDigest: digest("0"),
      }).success,
    ).toBe(false);
  });
});

describe("MD workflow contracts", () => {
  test("binds an MD capability into the canonical WorkUnit without widening QC fragments", () => {
    const sourceFragment = {
      skillId: "amber.production-md",
      version: "1.0.0",
      contentDigest: digest("1"),
      fragmentId: "amber-production-protocol",
      fragmentDigest: digest("2"),
      relativePath: "protocols/production.md",
      selector: "production",
    };
    const capabilityFragment = {
      schemaVersion: "eigengrid.scientific-capability-fragment/v1" as const,
      id: "fragment-production-1",
      kind: "scientific_capability" as const,
      capability: {
        id: "amber.production-md",
        version: "1.0.0",
        contractDigest: digest("3"),
      },
      reason: "Execute the approved production stage through the AMBER adapter",
      parameters: { stageId: "stage-4", stageDigest: stages[3]!.stageDigest },
      sourceFragments: [sourceFragment],
      riskClass: 3 as const,
    };
    const workUnit = {
      id: "work-unit-md-1",
      missionId: "mission-1",
      planId: "plan-1",
      planVersion: 1,
      kind: "scientific_capability" as const,
      state: "created" as const,
      reason: "Execute a digest-bound MD stage",
      dependencies: [],
      inputRefs: ["topology-evidence", "restart-evidence"],
      outputContract: {
        requiredEvidenceKinds: ["restart", "trajectory", "mdout"],
        requiredObservationKinds: ["stage_completion"],
      },
      skillRefs: [sourceFragment],
      protocolFragment: capabilityFragment,
      retryPolicy: { maximumAttempts: 2, ambiguityRequiresReconciliation: true },
      approvalPolicy: { required: true, minimumRole: "scientific_reviewer" },
      executionPolicy: { capability: "amber.production-md", riskClass: 3 as const },
      revision: 1,
      claimOwner: null,
      claimExpiresAt: null,
      jobId: null,
      attemptId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    expect(ScientificCapabilityProtocolFragmentSchema.safeParse(capabilityFragment).success).toBe(
      true,
    );
    expect(ProtocolFragmentSchema.safeParse(capabilityFragment).success).toBe(false);
    expect(WorkUnitSchema.safeParse(workUnit).success).toBe(true);
    expect(
      WorkUnitSchema.safeParse({
        ...workUnit,
        executionPolicy: { ...workUnit.executionPolicy, capability: "amber.heating" },
      }).success,
    ).toBe(false);
  });

  test("requires a canonical execution binding and digest-only operation intent", () => {
    const binding = {
      schemaVersion: MdExecutionBindingParametersSchemaVersion,
      plan: {
        id: "plan-1",
        version: 1,
        revision: 2,
        digest: digest("1"),
        approvalRef: "approval-plan-1",
      },
      system: {
        id: manifest.id,
        revision: manifest.revision,
        digest: manifest.manifestDigest,
        approvalRef: "approval-system-1",
      },
      protocol: {
        id: protocol.id,
        revision: protocol.revision,
        digest: protocol.protocolDigest,
        approvalRef: "approval-protocol-1",
      },
      stage: {
        id: stages[2]!.id,
        revision: stages[2]!.revision,
        sequence: stages[2]!.sequence,
        kind: stages[2]!.kind,
        digest: stages[2]!.stageDigest,
      },
      decisions: manifest.decisionRefs,
      parentRestart: artifact("restart", digest("f")),
    };
    expect(MdExecutionBindingParametersSchema.safeParse(binding).success).toBe(true);
    expect(
      MdExecutionBindingParametersSchema.safeParse({
        ...binding,
        stage: { ...binding.stage, kind: "production" },
      }).success,
    ).toBe(false);

    const request = {
      schemaVersion: MdStageOperationRequestSchemaVersion,
      workUnitId: "work-unit-1",
      bindingDigest: digestCanonical(binding),
      outputContractDigest: digest("2"),
      stage: {
        id: binding.stage.id,
        revision: binding.stage.revision,
        digest: binding.stage.digest,
      },
      environment: {
        canonicalSnapshotId: "environment-1",
        canonicalSnapshotDigest: digest("3"),
        engineEnvironmentDigest: digest("4"),
        bindingVersion: "1.0.0",
        bindingDigest: digest("5"),
        engine: {
          engine: "amber",
          executable: "sander",
          version: "24",
          buildDigest: digest("6"),
          environmentDigest: digest("4"),
          compatibilityVersion: "2.0.0",
        },
        binaryDigest: digest("6"),
      },
      render: {
        schemaVersion: "eigengrid.amber-canonical-stage-render/v2",
        renderedStageDigest: digest("7"),
        mapperVersion: "2.0.0",
        mapperDigest: digest("8"),
        mdinDigest: digest("9"),
        commandRequestDigest: digest("a"),
      },
      outputs: {
        mappingVersion: "1.0.0",
        mappingDigest: digest("b"),
        bindings: [
          {
            engineRole: "stage.restart",
            canonicalRole: "restart",
            mediaType: "application/vnd.amber.rst7",
            required: true,
          },
          {
            engineRole: "stage.trajectory",
            canonicalRole: "trajectory",
            mediaType: "application/x-netcdf",
            required: true,
          },
          {
            engineRole: "stage.mdout",
            canonicalRole: "mdout",
            mediaType: "text/plain",
            required: true,
          },
          {
            engineRole: "stage.mdinfo",
            canonicalRole: "mdinfo",
            mediaType: "text/plain",
            required: true,
          },
        ],
      },
    };
    expect(MdStageOperationRequestSchema.safeParse(request).success).toBe(true);
    expect(
      MdStageOperationRequestSchema.safeParse({ ...request, argv: ["-i", "mdin"] }).success,
    ).toBe(false);
    expect(
      MdStageOperationRequestSchema.safeParse({
        ...request,
        schemaVersion: "eigengrid.md-stage-operation-request/v1",
      }).success,
    ).toBe(false);
    expect(
      MdStageOperationRequestSchema.safeParse({
        ...request,
        environment: { ...request.environment, binaryDigest: digest("c") },
      }).success,
    ).toBe(false);
    expect(
      MdStageOperationRequestSchema.safeParse({
        ...request,
        outputs: { ...request.outputs, bindings: request.outputs.bindings.slice(1) },
      }).success,
    ).toBe(false);
  });

  test("accepts a deterministic staged protocol without embedding an engine command", () => {
    expect(MdWorkflowProtocolSchema.safeParse(protocol).success).toBe(true);
    expect(digestCanonical(MdWorkflowProtocolSchema.parse(protocol))).toMatch(/^[a-f0-9]{64}$/u);

    const signedStages = stages.map((value) => ({
      ...value,
      stageDigest: computeMdStageSpecDigest(value),
    }));
    for (const signedStage of signedStages) {
      expect(assertMdStageSpecDigest(signedStage).id).toBe(signedStage.id);
    }
    expect(() =>
      assertMdStageSpecDigest({ ...signedStages[3], name: "tampered production" }),
    ).toThrow(ScientificSchemaDigestMismatchError);

    const protocolWithSignedStages = { ...protocol, stages: signedStages };
    const signedProtocol = {
      ...protocolWithSignedStages,
      protocolDigest: computeMdWorkflowProtocolDigest(protocolWithSignedStages),
    };
    expect(assertMdWorkflowProtocolDigest(signedProtocol).id).toBe(protocol.id);
    const reviewedProtocol = {
      ...signedProtocol,
      status: "under_review" as const,
      approvedByRef: undefined,
      updatedAt: "2026-08-23T01:00:00.000Z",
    };
    expect(computeMdWorkflowProtocolDigest(reviewedProtocol)).toBe(signedProtocol.protocolDigest);
    expect(assertMdWorkflowProtocolDigest(reviewedProtocol).id).toBe(protocol.id);
    expect(() =>
      assertMdWorkflowProtocolDigest({
        ...signedProtocol,
        assumptions: [...signedProtocol.assumptions, "tampered assumption"],
      }),
    ).toThrow(ScientificSchemaDigestMismatchError);
  });

  test("rejects unknown stage keys, mismatched simulated time, and unsafe NPT pressure controls", () => {
    expect(MdStageSpecSchema.safeParse({ ...stages[3], executable: "pmemd.cuda" }).success).toBe(
      false,
    );
    expect(MdStageSpecSchema.safeParse({ ...stages[3], simulatedTimePs: 3 }).success).toBe(false);
    expect(MdStageSpecSchema.safeParse({ ...stages[3], barostat: { kind: "none" } }).success).toBe(
      false,
    );
  });

  test("technical pilots require explicit purpose and cannot include production", () => {
    const pilot = { ...protocol, stages: stages.slice(0, 3) };
    expect(MdWorkflowProtocolSchema.safeParse(pilot).success).toBe(false);
    expect(
      MdWorkflowProtocolSchema.safeParse({ ...pilot, purpose: "technical_pilot" }).success,
    ).toBe(true);
    expect(
      MdWorkflowProtocolSchema.safeParse({ ...protocol, purpose: "technical_pilot" }).success,
    ).toBe(false);
    expect(MdWorkflowProtocolSchema.safeParse({ ...pilot, purpose: "production" }).success).toBe(
      false,
    );
  });

  test("requires exact topology, coordinates, parent-output role, and canonical outputs", () => {
    expect(
      MdStageSpecSchema.safeParse({
        ...stages[0],
        inputs: [
          artifact("topology", digest("0")),
          artifact("coordinates", manifest.coordinateDigest),
        ],
      }).success,
    ).toBe(false);
    expect(
      MdStageSpecSchema.safeParse({ ...stages[1], requiredParentOutputRole: null }).success,
    ).toBe(false);
    expect(
      MdStageSpecSchema.safeParse({
        ...stages[1],
        inputs: [...stages[1]!.inputs, artifact("parent_restart", digest("e"))],
      }).success,
    ).toBe(false);
    expect(
      MdStageSpecSchema.safeParse({
        ...stages[3],
        outputs: stages[3]!.outputs.filter((output) => output.role !== "trajectory"),
      }).success,
    ).toBe(false);
  });

  test("rejects non-contiguous and backward workflow stage sequences", () => {
    const nonContiguous = [stages[0], { ...stages[1], sequence: 3 }, stages[2], stages[3]];
    expect(MdWorkflowProtocolSchema.safeParse({ ...protocol, stages: nonContiguous }).success).toBe(
      false,
    );
    expect(
      MdWorkflowProtocolSchema.safeParse({
        ...protocol,
        stages: [stages[0], { ...stages[1], kind: "production" }, stages[2], stages[3]],
      }).success,
    ).toBe(false);
  });

  test("rejects partial system-reference equality and forged criterion identities", () => {
    expect(
      MdWorkflowProtocolSchema.safeParse({
        ...protocol,
        stages: [
          { ...stages[0], system: { ...stages[0]!.system, atomMapDigest: digest("0") } },
          ...stages.slice(1),
        ],
      }).success,
    ).toBe(false);
    expect(
      MdWorkflowProtocolSchema.safeParse({
        ...protocol,
        stages: [
          { ...stages[0], system: { ...stages[0]!.system, systemClass: "soluble" as const } },
          ...stages.slice(1),
        ],
      }).success,
    ).toBe(false);
    expect(
      MdAcceptanceCriterionSchema.safeParse({
        ...criterion,
        description: "Changed without a new criterion digest",
      }).success,
    ).toBe(false);
  });

  test("enforces metric criterion bounds and monotonic normalized series", () => {
    expect(
      MdAcceptanceCriterionSchema.safeParse({
        ...criterion,
        kind: "thermodynamic_range",
        observable: "temperature",
        lowerBound: 315,
        upperBound: 305,
        unit: "K",
      }).success,
    ).toBe(false);
    const series = {
      schemaVersion: MdMetricSeriesSchemaVersion,
      id: "temperature-series",
      stageResultId: "stage-result-1",
      metric: "temperature" as const,
      unit: "K",
      points: [
        { step: 0, timePs: 0, value: 300 },
        { step: 100, timePs: 0.2, value: 310 },
      ],
      sourceArtifactRef: "mdout-evidence",
      parserVersion: "1.0.0",
      seriesDigest: digest("1"),
    };
    expect(MdMetricSeriesSchema.safeParse(series).success).toBe(true);
    const signedSeries = { ...series, seriesDigest: computeMdMetricSeriesDigest(series) };
    expect(assertMdMetricSeriesDigest(signedSeries).id).toBe(series.id);
    expect(() => assertMdMetricSeriesDigest({ ...signedSeries, unit: "kelvin" })).toThrow(
      ScientificSchemaDigestMismatchError,
    );
    expect(
      MdMetricSeriesSchema.safeParse({
        ...series,
        points: [series.points[1], series.points[0]],
      }).success,
    ).toBe(false);
  });

  test("requires unique replica seeds and one-based replica indices", () => {
    const replicaSet = {
      schemaVersion: MdReplicaSetSchemaVersion,
      id: "replica-set-1",
      missionId: "mission-1",
      revision: 1,
      protocolId: protocol.id,
      protocolRevision: protocol.revision,
      protocolDigest: protocol.protocolDigest,
      systemManifestDigest: manifest.manifestDigest,
      replicaCount: 2,
      replicas: [
        { id: "replica-1", index: 1, seed: 101, initialRestart: artifact("restart", digest("1")) },
        { id: "replica-2", index: 2, seed: 102, initialRestart: artifact("restart", digest("2")) },
      ],
      seedPolicyDigest: digest("3"),
      decisionRef: "replica-decision-1",
      createdAt: timestamp,
    };
    expect(ReplicaSetSchema.safeParse(replicaSet).success).toBe(true);
    expect(computeMdReplicaSetDigest(replicaSet)).toMatch(/^[a-f0-9]{64}$/u);
    const replicas = replicaSet.replicas.map((replica, index) => ({
      ...replica,
      segmentSeeds: [replica.seed, 103 + index],
    }));
    const explicit = ReplicaSetSchema.parse({
      ...replicaSet,
      replicas,
      seedPolicyDigest: computeMdReplicaSeedPolicyDigest(replicas),
    });
    const stageBase = {
      ...stage(4, "production"),
      randomSeed: { policy: "replica_segment" as const, segmentCount: 2 },
    };
    const production = assertMdStageSpecDigest({
      ...stageBase,
      stageDigest: computeMdStageSpecDigest(stageBase),
    });
    expect(resolveMdReplicaSegmentSeed(production, explicit, "replica-1", 0)).toBe(101);
    expect(resolveMdReplicaSegmentSeed(production, explicit, "replica-1", 1)).toBe(103);
    expect(resolveMdReplicaSegmentSeed(production, explicit, "replica-2", 1)).toBe(104);
    for (const index of [-1, 1.5, 2, NaN]) {
      expect(() => resolveMdReplicaSegmentSeed(production, explicit, "replica-1", index)).toThrow();
    }
    expect(() => resolveMdReplicaSegmentSeed(production, explicit, "absent", 0)).toThrow();
    expect(() =>
      resolveMdReplicaSegmentSeed(production, ReplicaSetSchema.parse(replicaSet), "replica-1", 0),
    ).toThrow(/approved production length/);
    const longerBase = {
      ...production,
      randomSeed: { policy: "replica_segment" as const, segmentCount: 3 },
    };
    const longer = assertMdStageSpecDigest({
      ...longerBase,
      stageDigest: computeMdStageSpecDigest(longerBase),
    });
    expect(longer.stageDigest).not.toBe(production.stageDigest);
    expect(() => resolveMdReplicaSegmentSeed(longer, explicit, "replica-1", 0)).toThrow(
      /approved production length/,
    );
    for (const changed of [
      [{ ...replicas[0]!, segmentSeeds: [101, 101] }, replicas[1]!],
      [replicas[0]!, { ...replicas[1]!, segmentSeeds: [102, 103] }],
      [{ ...replicas[0]!, segmentSeeds: [105, 103] }, replicas[1]!],
      [replicas[0]!, { ...replicas[1]!, segmentSeeds: [102] }],
    ]) {
      expect(
        ReplicaSetSchema.safeParse({
          ...replicaSet,
          replicas: changed,
          seedPolicyDigest: computeMdReplicaSeedPolicyDigest(changed),
        }).success,
      ).toBe(false);
    }
    expect(ReplicaSetSchema.safeParse({ ...explicit, seedPolicyDigest: digest("0") }).success).toBe(
      false,
    );
    expect(
      ReplicaSetSchema.safeParse({ ...explicit, replicas: [replicas[0], replicaSet.replicas[1]] })
        .success,
    ).toBe(false);
    expect(
      MdStageSpecSchema.safeParse({ ...stage(2, "heating"), randomSeed: production.randomSeed })
        .success,
    ).toBe(false);
    expect(
      ReplicaSetSchema.safeParse({
        ...replicaSet,
        replicas: [replicaSet.replicas[0], { ...replicaSet.replicas[1], seed: 101 }],
      }).success,
    ).toBe(false);
  });

  test("rejects a falsely verified trajectory continuation", () => {
    const segment = {
      schemaVersion: TrajectorySegmentSchemaVersion,
      id: "segment-0",
      revision: 1,
      missionId: "mission-1",
      replicaId: "replica-1",
      stageResultId: "stage-result-1",
      segmentIndex: 0,
      parentRestart: artifact("restart", digest("4")),
      restart: artifact("restart", digest("5")),
      trajectory: artifact("trajectory", digest("6")),
      startStep: 1_000,
      endStep: 2_000,
      startTimePs: 2,
      endTimePs: 4,
      frameCount: 10,
      netcdf: { convention: "AMBER NetCDF", atomCount: 15, frameCount: 10, hasPeriodicBox: true },
      continuity: {
        status: "verified" as const,
        expectedParentRestartDigest: digest("4"),
        observedParentRestartDigest: digest("4"),
        expectedStartStep: 1_000,
        observedStartStep: 1_000,
        expectedStartTimePs: 2,
        observedStartTimePs: 2,
        reason: "exact continuation",
      },
      segmentDigest: digest("7"),
      createdAt: timestamp,
    };
    expect(TrajectorySegmentSchema.safeParse(segment).success).toBe(true);
    const signedSegment = {
      ...segment,
      segmentDigest: computeTrajectorySegmentDigest(segment),
    };
    expect(assertTrajectorySegmentDigest(signedSegment).id).toBe(segment.id);
    expect(() =>
      assertTrajectorySegmentDigest({
        ...signedSegment,
        continuity: { ...signedSegment.continuity, reason: "tampered reason" },
      }),
    ).toThrow(ScientificSchemaDigestMismatchError);
    expect(
      TrajectorySegmentSchema.safeParse({
        ...segment,
        continuity: { ...segment.continuity, observedStartStep: 999 },
      }).success,
    ).toBe(false);
  });

  test("binds successful results to operation receipts and required artifacts", () => {
    const result = {
      schemaVersion: MdStageResultSchemaVersion,
      id: "stage-result-1",
      revision: 1,
      missionId: "mission-1",
      workUnitId: "work-unit-1",
      operationId: "operation-1",
      operationReceiptId: "receipt-1",
      protocolId: protocol.id,
      protocolRevision: protocol.revision,
      protocolDigest: protocol.protocolDigest,
      stageId: stages[3]!.id,
      stageRevision: 1,
      stageDigest: stages[3]!.stageDigest,
      stageKind: "production" as const,
      replicaSetId: "replica-set-1",
      replicaSetRevision: 1,
      replicaSetDigest: digest("b"),
      replicaId: "replica-1",
      segmentIndex: 0,
      parentRestartDigest: digest("1"),
      terminalReason: "completed" as const,
      exitCode: 0,
      signal: null,
      startedAt: timestamp,
      finishedAt: "2026-08-23T12:01:00.000Z",
      startStep: 0,
      endStep: 1_000,
      startTimePs: 0,
      endTimePs: 2,
      engine: {
        engine: "amber",
        executable: "pmemd.cuda",
        version: "24",
        buildDigest: digest("8"),
        environmentDigest: digest("9"),
        compatibilityVersion: "1.0.0",
      },
      artifacts: [
        artifact("restart"),
        artifact("trajectory"),
        artifact("mdout"),
        artifact("mdinfo"),
      ],
      warnings: [],
      errors: [],
      validationStatus: "passed" as const,
      validationRefs: ["validation-1"],
      resultDigest: digest("a"),
    };
    expect(MdStageResultSchema.safeParse(result).success).toBe(true);
    const signedResult = { ...result, resultDigest: computeMdStageResultDigest(result) };
    expect(assertMdStageResultDigest(signedResult).id).toBe(result.id);
    expect(() =>
      assertMdStageResultDigest({ ...signedResult, validationStatus: "inconclusive" }),
    ).toThrow(ScientificSchemaDigestMismatchError);
    expect(MdStageResultSchema.safeParse({ ...result, exitCode: 1 }).success).toBe(false);
    expect(MdStageResultSchema.safeParse({ ...result, segmentIndex: undefined }).success).toBe(
      false,
    );
    expect(
      MdStageResultSchema.safeParse({
        ...result,
        artifacts: result.artifacts.filter((entry) => entry.role !== "restart"),
      }).success,
    ).toBe(false);
  });

  test("does not advance a rejected or inconclusive stage assessment", () => {
    const assessment = {
      schemaVersion: MdAssessmentSchemaVersion,
      id: "stage-assessment-1",
      revision: 1,
      missionId: "mission-1",
      stageResultId: "stage-result-1",
      stageResultRevision: 1,
      stageResultDigest: digest("a"),
      status: "accepted" as const,
      evaluations: [
        {
          criterionId: criterion.id,
          criterionDigest: criterion.criterionDigest,
          required: true,
          status: "passed" as const,
          summary: "normal termination",
          evidenceRefs: ["mdout-evidence"],
        },
      ],
      nextStageEligible: true,
      limitations: ["short smoke trajectory"],
      evidenceRefs: ["mdout-evidence"],
      assessor: actor,
      assessmentDigest: digest("b"),
      createdAt: timestamp,
    };
    expect(MdStageAssessmentSchema.safeParse(assessment).success).toBe(true);
    expect(
      MdStageAssessmentSchema.safeParse({
        ...assessment,
        status: "rejected",
        nextStageEligible: true,
      }).success,
    ).toBe(false);
    expect(
      MdStageAssessmentSchema.safeParse({
        ...assessment,
        evaluations: assessment.evaluations.map((evaluation) => ({
          ...evaluation,
          status: "not_applicable" as const,
        })),
      }).success,
    ).toBe(false);
  });

  test("does not label unsupported claims as supported or bypass human review", () => {
    const assessment = {
      schemaVersion: MdAssessmentSchemaVersion,
      id: "scientific-assessment-1",
      revision: 1,
      missionId: "mission-1",
      systemManifestId: manifest.id,
      systemManifestRevision: manifest.revision,
      systemManifestDigest: manifest.manifestDigest,
      protocolId: protocol.id,
      protocolRevision: protocol.revision,
      protocolDigest: protocol.protocolDigest,
      status: "supported" as const,
      claims: [
        {
          statement: "The fixture completed its contract smoke path",
          support: "supported" as const,
          evidenceRefs: ["stage-assessment-1"],
        },
      ],
      uncertaintySources: ["fixture scale"],
      limitations: ["not scientific convergence evidence"],
      stageAssessmentRefs: ["stage-assessment-1"],
      decisionRefs: manifest.decisionRefs.map((decision) => decision.id),
      generatedBy: { id: "reporter-1", kind: "service" as const, role: "reporter" },
      reviewedBy: [actor],
      assessmentDigest: digest("c"),
      createdAt: timestamp,
    };
    expect(MdScientificAssessmentSchema.safeParse(assessment).success).toBe(true);
    expect(MdScientificAssessmentSchema.safeParse({ ...assessment, reviewedBy: [] }).success).toBe(
      false,
    );
    expect(
      MdScientificAssessmentSchema.safeParse({
        ...assessment,
        claims: assessment.claims.map((claim) => ({
          ...claim,
          support: "unsupported" as const,
        })),
      }).success,
    ).toBe(false);
  });
});
