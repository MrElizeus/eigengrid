/** Synthetic contract fixtures only; not approved scientific inputs or M2 evidence. */
import {
  MdAssessmentSchemaVersion,
  MdStageSchemaVersion,
  assertMdStageSpecDigest,
  computeMdAcceptanceCriterionDigest,
  computeMdStageSpecDigest,
  type MdExecutionBindingParameters,
} from "@eigengrid/scientific-schema";
import { computeCanonicalAtomMapDigest } from "./atom-map";
import { sha256Canonical } from "./canonical";
import { PMEMD26_CUDA_PROFILE, SANDER26_CPU_PROFILE } from "./sander26-profile";
import {
  AMBER_CANONICAL_STAGE_MAPPING_SCHEMA_VERSION,
  AMBER_CANONICAL_STAGE_MAPPING_VERSION,
  computeAmberCanonicalStageMappingDigest,
  computeCanonicalMdExecutionBindingDigest,
} from "./canonical-stage-mapper";
import {
  createAmberEnvironmentBinding,
  computeCanonicalMdEnvironmentDigest,
} from "./environment-binding";

export const digest = (value: string) => value.repeat(64).slice(0, 64);
export const topologyDigest = digest("a");
export const coordinateDigest = digest("b");
export const parentDigest = digest("c");
export const segmentParentDigest = digest("0");

const atomMapBase = {
  schemaVersion: "eigengrid.atom-map/v1" as const,
  id: "atom-map-1",
  revision: 1,
  systemManifestId: "system-1",
  systemManifestRevision: 1,
  indexBase: 1 as const,
  atomCount: 2,
  topologyDigest,
  coordinateDigest,
  entries: [
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
      residueIndex: 2,
      residueName: "LIG",
      atomName: "N1",
      element: "N",
    },
  ],
};
export const canonicalAtomMap = {
  ...atomMapBase,
  mapDigest: computeCanonicalAtomMapDigest(atomMapBase),
};

export const system = {
  id: "system-1",
  revision: 1,
  systemClass: "soluble" as const,
  manifestDigest: digest("d"),
  topologyDigest,
  coordinateDigest,
  atomMapDigest: canonicalAtomMap.mapDigest,
};

const criterionBase = {
  schemaVersion: MdAssessmentSchemaVersion,
  id: "normal-termination",
  kind: "normal_termination" as const,
  description: "AMBER terminates normally",
  required: true,
  evaluatorVersion: "1.0.0",
};
const criterion = {
  ...criterionBase,
  criterionDigest: computeMdAcceptanceCriterionDigest(criterionBase),
};

export function unsignedStage() {
  return {
    schemaVersion: MdStageSchemaVersion,
    id: "production-1",
    revision: 1,
    sequence: 2,
    kind: "production" as const,
    name: "Production segment",
    system,
    parentStageId: "equilibration-1",
    requiredParentOutputRole: "restart" as const,
    inputs: [
      {
        artifactId: "topology",
        evidenceRef: "evidence-topology",
        role: "topology" as const,
        contentDigest: topologyDigest,
        mediaType: "application/vnd.amber.prmtop",
      },
    ],
    ensemble: "nvt" as const,
    steps: 1_000,
    timeStepPs: 0.001,
    simulatedTimePs: 1,
    temperature: { points: [{ step: 0, kelvin: 300 }] },
    thermostat: { kind: "langevin" as const, collisionFrequencyPerPs: 1 },
    barostat: { kind: "none" as const },
    constraints: { bondsToHydrogen: false },
    restraints: [],
    nonbonded: {
      cutoffAngstrom: 10,
      electrostatics: "pme" as const,
      ewaldTolerance: 0.00001,
      periodicBoundary: true as const,
    },
    randomSeed: { policy: "replica_segment" as const, segmentCount: 2 },
    resourceProfile: {
      backendCapabilityId: "local-cpu",
      cpuCores: 4,
      gpuCount: 0,
      memoryBytes: 2_000_000,
      scratchBytes: 4_000_000,
      wallTimeSeconds: 600,
    },
    checkpoint: {
      cadenceSteps: 100,
      retainCount: 2,
      stopAfterCheckpointSupported: true,
    },
    outputs: [
      {
        role: "restart" as const,
        required: true,
        mediaType: "application/vnd.amber.rst7",
        cadenceSteps: 100,
      },
      {
        role: "trajectory" as const,
        required: true,
        mediaType: "application/x-netcdf",
        cadenceSteps: 20,
      },
      { role: "mdout" as const, required: true, mediaType: "text/plain", cadenceSteps: 10 },
      { role: "mdinfo" as const, required: true, mediaType: "text/plain" },
    ],
    acceptanceCriteria: [criterion],
    sourceDecisionRefs: ["construct-decision", "force-field-decision", "pose-decision"],
    rendererCompatibilityVersion: AMBER_CANONICAL_STAGE_MAPPING_VERSION,
  };
}

export function signedStage(value = unsignedStage()) {
  return { ...value, stageDigest: computeMdStageSpecDigest(value) };
}

const observations = [
  "antechamber",
  "parmchk2",
  "tleap",
  "sander",
  "pmemd",
  "pmemd.cuda",
  "cpptraj",
].map((executable) =>
  executable === "sander"
    ? { executable, available: true, version: "24", binarySha256: digest("f") }
    : { executable, available: false, diagnostic: "not selected for fixture" },
);
export const adapterEnvironment = {
  schemaVersion: "amber-environment/v1" as const,
  environmentDigest: sha256Canonical(observations),
  observations,
  capabilities: {
    amberToolsPreparation: false,
    referenceMd: true,
    optimizedCpuMd: false,
    gpuMd: false,
    trajectoryAnalysis: false,
  },
};
export const snapshotBase = {
  schemaVersion: "eigengrid.md-environment-capability-snapshot/v1" as const,
  id: "environment-1",
  engine: {
    engine: "amber",
    executable: "sander",
    version: "24",
    buildDigest: digest("f"),
    environmentDigest: adapterEnvironment.environmentDigest,
    compatibilityVersion: AMBER_CANONICAL_STAGE_MAPPING_VERSION,
  },
  capabilities: [{ id: "amber.production-md", version: "1.0.0", contractDigest: digest("1") }],
  targetCompatibility: {
    family: "amber" as const,
    versionRange: ">=24",
    compatible: true as const,
    evaluatorVersion: "1.0.0",
    evidenceDigest: digest("2"),
  },
  observedAt: "2026-08-23T00:00:00.000Z",
};
export const snapshot = {
  ...snapshotBase,
  environmentDigest: computeCanonicalMdEnvironmentDigest(snapshotBase),
};
export const environmentBinding = createAmberEnvironmentBinding(
  snapshot,
  adapterEnvironment,
  "sander",
);

export const decision = (id: string, char: string) => ({
  id,
  revision: 1,
  decisionDigest: digest(char),
  approvalRef: `approval-${id}`,
});

const decisionDigestChar: Record<string, string> = {
  "construct-decision": "3",
  "force-field-decision": "4",
  "pose-decision": "9",
  "minimization-decision": "7",
  "membrane-pressure-decision": "8",
  "restraint-decision": "6",
};

function canonicalDecision(id: string) {
  const char = decisionDigestChar[id];
  if (char === undefined) throw new Error(`Missing fixture decision ${id}`);
  return { ...decision(id, char), kind: "other" as const };
}

export function executionBindingFor(stageValue: unknown) {
  const stage = assertMdStageSpecDigest(stageValue);
  return {
    schemaVersion: "eigengrid.md-execution-binding/v2" as const,
    plan: {
      id: "plan-1",
      version: 1,
      revision: 1,
      digest: digest("5"),
      approvalRef: "approval-plan-1",
    },
    system: {
      id: stage.system.id,
      revision: stage.system.revision,
      digest: stage.system.manifestDigest,
      approvalRef: "approval-system-1",
    },
    protocol: {
      id: "protocol-1",
      revision: 1,
      digest: digest("6"),
      approvalRef: "approval-protocol-1",
    },
    stage: {
      id: stage.id,
      revision: stage.revision,
      sequence: stage.sequence,
      kind: stage.kind,
      digest: stage.stageDigest,
    },
    decisions: stage.sourceDecisionRefs.map(canonicalDecision),
    ...(stage.sequence > 1
      ? {
          parentRestart: {
            artifactId: "parent-restart",
            evidenceRef: "evidence-parent",
            role: "restart" as const,
            contentDigest: segmentParentDigest,
            mediaType: "application/vnd.amber.rst7",
          },
        }
      : {}),
    ...(stage.kind === "production"
      ? {
          replicaSegment: {
            replicaSetId: "replica-set-1",
            replicaSetRevision: 1,
            replicaSetDigest: digest("7"),
            replicaId: "replica-1",
            replicaIndex: 1,
            replicaSeed: 771_001,
            segmentIndex: 0,
            segmentSeed: 771_001,
          },
        }
      : {}),
  };
}

export function unsignedMapping(
  stageValue: unknown = signedStage(),
  executionBinding: MdExecutionBindingParameters = executionBindingFor(stageValue),
) {
  const stage = assertMdStageSpecDigest(stageValue);
  return {
    schemaVersion: AMBER_CANONICAL_STAGE_MAPPING_SCHEMA_VERSION,
    mappingVersion: AMBER_CANONICAL_STAGE_MAPPING_VERSION,
    canonicalStage: {
      id: stage.id,
      revision: stage.revision,
      kind: stage.kind,
      stageDigest: stage.stageDigest,
      rendererCompatibilityVersion: AMBER_CANONICAL_STAGE_MAPPING_VERSION,
    },
    canonicalWorkUnit: {
      bindingDigest: computeCanonicalMdExecutionBindingDigest(executionBinding),
      plan: executionBinding.plan,
      system: executionBinding.system,
      protocol: executionBinding.protocol,
    },
    canonicalAtomMap: {
      id: canonicalAtomMap.id,
      revision: canonicalAtomMap.revision,
      mapDigest: canonicalAtomMap.mapDigest,
      viewVersion: "1.0.0" as const,
    },
    environment: environmentBinding,
    engineSelection: { engine: "sander" as const },
    restart: { format: "formatted" as const },
    pmeElectrostatics: {
      mode: "amber_pme_dsum_tol" as const,
      ewaldTolerance: 0.00001,
    },
    constraints: stage.constraints.bondsToHydrogen
      ? {
          algorithm: "shake" as const,
          bondsToHydrogen: true as const,
          tolerance: stage.constraints.tolerance!,
          maximumIterations: stage.constraints.maximumIterations!,
        }
      : {
          algorithm: "none" as const,
          bondsToHydrogen: false as const,
          tolerance: null,
          maximumIterations: null,
        },
    minimizationSplit: null,
    restraintMasks: [],
    membranePressure: null,
    artifactPaths: {
      cwd: "work/production-1",
      mdin: "work/production-1/stage.mdin",
      inputs: [
        {
          artifactId: "topology",
          role: "topology" as const,
          contentDigest: topologyDigest,
          logicalPath: "inputs/system.prmtop",
        },
        {
          artifactId: "parent-restart",
          role: "parent_restart" as const,
          contentDigest: executionBinding.parentRestart?.contentDigest ?? parentDigest,
          logicalPath: "inputs/parent.rst7",
        },
      ],
      outputs: [
        { role: "restart" as const, logicalPath: "outputs/production.rst7" },
        { role: "trajectory" as const, logicalPath: "outputs/production.nc" },
        { role: "mdout" as const, logicalPath: "outputs/production.mdout" },
        { role: "mdinfo" as const, logicalPath: "outputs/production.mdinfo" },
      ],
      referenceArtifactId: null,
    },
  };
}

export function signedMapping(value: Record<string, unknown> = unsignedMapping()) {
  return { ...value, mappingDigest: computeAmberCanonicalStageMappingDigest(value) };
}

export function resignStage<T extends object>(value: T) {
  return { ...value, stageDigest: computeMdStageSpecDigest(value) };
}

export function explicitMinimization() {
  const base = unsignedStage();
  const stage = resignStage({
    ...base,
    id: "min-explicit",
    sequence: 1,
    kind: "minimization" as const,
    parentStageId: null,
    requiredParentOutputRole: null,
    inputs: [
      base.inputs[0]!,
      {
        artifactId: "coordinates",
        evidenceRef: "evidence-coordinates",
        role: "coordinates" as const,
        contentDigest: coordinateDigest,
        mediaType: "application/vnd.amber.rst7",
      },
    ],
    ensemble: "none" as const,
    steps: 200,
    minimization: {
      algorithm: "steepest_descent_then_conjugate_gradient" as const,
      steepestDescentCycles: 80,
      rmsGradientToleranceKcalMolAngstrom: 0.0002,
      initialStepAngstrom: 0.015,
    },
    timeStepPs: null,
    simulatedTimePs: null,
    temperature: null,
    randomSeed: null,
    thermostat: { kind: "none" as const },
    barostat: { kind: "none" as const },
    checkpoint: { ...base.checkpoint, cadenceSteps: 200, stopAfterCheckpointSupported: false },
    outputs: base.outputs
      .filter((output) => output.role !== "trajectory")
      .map((output) => (output.role === "restart" ? { ...output, cadenceSteps: 200 } : output)),
    sourceDecisionRefs: [...base.sourceDecisionRefs, "minimization-decision"],
  });
  const binding = executionBindingFor(stage);
  const mappingBase = unsignedMapping(stage, binding);
  const mapping = signedMapping({
    ...mappingBase,
    minimizationSplit: {
      algorithm: stage.minimization.algorithm,
      steepestDescentCycles: stage.minimization.steepestDescentCycles,
      decision: decision("minimization-decision", "7"),
    },
    artifactPaths: {
      ...mappingBase.artifactPaths,
      inputs: [
        mappingBase.artifactPaths.inputs[0]!,
        {
          artifactId: "coordinates",
          role: "coordinates",
          contentDigest: coordinateDigest,
          logicalPath: "inputs/system.rst7",
        },
      ],
      outputs: mappingBase.artifactPaths.outputs.filter((output) => output.role !== "trajectory"),
    },
  });
  return { stage, binding, mapping };
}

export function reviewedSander26Environment(
  binaryDigest: string = SANDER26_CPU_PROFILE.binarySha256,
) {
  const exactObservations = observations.map((observation) =>
    observation.executable === "sander"
      ? { ...observation, version: SANDER26_CPU_PROFILE.version, binarySha256: binaryDigest }
      : observation,
  );
  const adapter = {
    ...adapterEnvironment,
    observations: exactObservations,
    environmentDigest: sha256Canonical(exactObservations),
  };
  const canonical = {
    ...snapshotBase,
    engine: {
      ...snapshotBase.engine,
      version: SANDER26_CPU_PROFILE.version,
      buildDigest: binaryDigest,
      environmentDigest: adapter.environmentDigest,
    },
  };
  return createAmberEnvironmentBinding(
    {
      ...canonical,
      environmentDigest: computeCanonicalMdEnvironmentDigest(canonical),
    },
    adapter,
    "sander",
  );
}

export function reviewedPmemdCuda26Environment(
  binaryDigest: string = PMEMD26_CUDA_PROFILE.binarySha256,
) {
  const exactObservations = observations.map((observation) =>
    observation.executable === "pmemd.cuda"
      ? {
          executable: "pmemd.cuda" as const,
          available: true as const,
          version: PMEMD26_CUDA_PROFILE.version,
          binarySha256: binaryDigest,
          gpu: true,
        }
      : observation,
  );
  const adapter = {
    schemaVersion: "amber-environment/v1" as const,
    observations: exactObservations,
    environmentDigest: sha256Canonical(exactObservations),
    capabilities: {
      ...adapterEnvironment.capabilities,
      gpuMd: true,
    },
  };
  const canonical = {
    ...snapshotBase,
    engine: {
      ...snapshotBase.engine,
      executable: PMEMD26_CUDA_PROFILE.executable,
      version: PMEMD26_CUDA_PROFILE.version,
      buildDigest: binaryDigest,
      environmentDigest: adapter.environmentDigest,
    },
  };
  return createAmberEnvironmentBinding(
    {
      ...canonical,
      environmentDigest: computeCanonicalMdEnvironmentDigest(canonical),
    },
    adapter,
    PMEMD26_CUDA_PROFILE.executable,
  );
}
