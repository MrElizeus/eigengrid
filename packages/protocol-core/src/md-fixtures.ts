/** Synthetic contract fixtures; no scientific or site qualification. Not a public export. */
import {
  BiomolecularComponentSchemaVersion,
  BiomolecularSystemManifestSchemaVersion,
  PublishedBiomolecularSystemManifestSchemaVersion,
  MdAssessmentSchemaVersion,
  MdEnvironmentCapabilitySnapshotSchemaVersion,
  MdProtocolSchemaVersion,
  MdReplicaSetSchemaVersion,
  MdStageResultSchemaVersion,
  MdStageSchemaVersion,
  computeBiomolecularSystemManifestDigest,
  computeMdAcceptanceCriterionDigest,
  computeMdReplicaSetDigest,
  computeMdReplicaSeedPolicyDigest,
  computeMdStageAssessmentDigest,
  computeMdStageResultDigest,
  computeMdStageSpecDigest,
  computeMdWorkflowProtocolDigest,
  type ApprovalRequest,
  type MdStageAssessment,
  type MdStageResult,
} from "@eigengrid/scientific-schema";
import {
  compileMdWorkflowProtocol,
  computeMdCompilerPolicyDigest,
  computeMdEnvironmentDigest,
  type MdProtocolCompilationInput,
  type MdNextStageCompilationInput,
  type MdProductionSegmentCompilationInput,
} from "./md-protocol-compiler";

const timestamp = "2026-08-23T12:00:00.000Z";
const digest = (value: string): string => value.repeat(64);
const actor = { id: "scientist-1", kind: "human" as const, role: "scientific_reviewer" };

export function approval(input: {
  id: string;
  missionId?: string;
  subjectType: ApprovalRequest["subjectType"];
  subjectId: string;
  subjectVersion: number;
  subjectRevision: number;
  payloadDigest: string;
  policyDigest?: string;
}): ApprovalRequest {
  const policyDigest = input.policyDigest ?? digest("e");
  return {
    ...input,
    missionId: input.missionId ?? "mission-md-1",
    state: "approved",
    requestedFromRole: "scientific_reviewer",
    payloadDigest: input.payloadDigest,
    policyDigest,
    editableFields: [],
    requestedBy: { id: "service-1", kind: "service", role: "mission_runtime" },
    requestedAt: timestamp,
    response: {
      id: `response-${input.id}`,
      approvalRequestId: input.id,
      decision: "approved",
      actor,
      role: "scientific_reviewer",
      reason: "Exact scientific revision reviewed",
      subjectVersion: input.subjectVersion,
      subjectRevision: input.subjectRevision,
      payloadDigest: input.payloadDigest,
      policyDigest,
      decidedAt: timestamp,
    },
  };
}

export function makeInput(): MdProtocolCompilationInput {
  const constructDecision = {
    id: "construct-decision-1",
    revision: 1,
    kind: "construct" as const,
    decisionDigest: digest("1"),
    approvalRef: "approval-construct-1",
  };
  const forceFieldDecision = {
    id: "force-field-decision-1",
    revision: 1,
    kind: "force_field_stack" as const,
    decisionDigest: digest("a"),
    approvalRef: "approval-force-field-1",
  };
  const protonationDecision = {
    id: "protonation-decision-1",
    revision: 1,
    kind: "protonation" as const,
    decisionDigest: digest("b"),
    approvalRef: "approval-protonation-1",
  };
  const manifestBase = {
    schemaVersion: PublishedBiomolecularSystemManifestSchemaVersion,
    id: "system-soluble-fixture",
    revision: 1,
    missionId: "mission-md-1",
    name: "Contract-only soluble fixture",
    sourceEvidenceRefs: ["evidence-structure", "evidence-water"],
    constructDecisionId: constructDecision.id,
    forceFieldStackDecisionId: forceFieldDecision.id,
    decisionRefs: [constructDecision, forceFieldDecision, protonationDecision],
    components: {
      proteins: [
        {
          schemaVersion: BiomolecularComponentSchemaVersion,
          id: "protein-1",
          revision: 1,
          kind: "protein" as const,
          name: "Fixture receptor",
          sourceEvidenceRefs: ["evidence-structure"],
          coordinateDigest: digest("2"),
          atomCount: 2,
          moleculeCount: 1,
          formalCharge: 0,
          role: "receptor" as const,
          chainIds: ["A"],
          residueCount: 1,
          sequenceDigest: digest("3"),
          protonationDecisionId: protonationDecision.id,
        },
      ],
      ligands: [],
      lipids: [],
      waters: [
        {
          schemaVersion: BiomolecularComponentSchemaVersion,
          id: "water-1",
          revision: 1,
          kind: "water" as const,
          name: "Fixture water",
          sourceEvidenceRefs: ["evidence-water"],
          coordinateDigest: digest("4"),
          atomCount: 3,
          moleculeCount: 1,
          formalCharge: 0,
          waterModel: "TIP3P",
        },
      ],
      ions: [],
      cofactors: [],
    },
    membrane: null,
    environment: {
      targetPh: 7.4,
      targetTemperatureKelvin: 300,
      targetPressureBar: 1,
      targetIonicStrengthMolar: 0,
    },
    forceFieldStack: { id: "ff-stack-1", revision: 1, digest: digest("5") },
    topologyDigest: digest("6"),
    coordinateDigest: digest("7"),
    atomMapDigest: digest("8"),
    totalCharge: 0,
    atomCount: 5,
    box: {
      shape: "orthorhombic" as const,
      lengthsAngstrom: [20, 20, 20] as [number, number, number],
      anglesDegrees: [90, 90, 90] as [number, number, number],
      periodic: true as const,
    },
    provenance: {
      operationId: "operation-build-1",
      builder: { name: "fixture-builder", version: "1.0.0" },
      createdBy: { id: "service-builder", kind: "service" as const, role: "builder" },
      createdAt: timestamp,
    },
    manifestDigest: digest("9"),
  };
  const system = {
    ...manifestBase,
    manifestDigest: computeBiomolecularSystemManifestDigest(manifestBase),
  };
  const systemReference = {
    id: system.id,
    revision: system.revision,
    systemClass: "soluble" as const,
    manifestDigest: system.manifestDigest,
    topologyDigest: system.topologyDigest,
    coordinateDigest: system.coordinateDigest,
    atomMapDigest: system.atomMapDigest,
  };
  const topology = {
    artifactId: "artifact-topology",
    evidenceRef: "evidence-topology",
    role: "topology" as const,
    contentDigest: system.topologyDigest,
    mediaType: "application/octet-stream",
  };
  const coordinates = {
    artifactId: "artifact-coordinates",
    evidenceRef: "evidence-coordinates",
    role: "coordinates" as const,
    contentDigest: system.coordinateDigest,
    mediaType: "application/octet-stream",
  };
  const criterionBase = {
    schemaVersion: MdAssessmentSchemaVersion,
    id: "criterion-normal-termination",
    kind: "normal_termination" as const,
    description: "Engine reports normal termination",
    required: true,
    evaluatorVersion: "1.0.0",
  };
  const criterion = {
    ...criterionBase,
    criterionDigest: computeMdAcceptanceCriterionDigest(criterionBase),
  };
  const commonDynamicsStage = {
    schemaVersion: MdStageSchemaVersion,
    revision: 1,
    system: systemReference,
    ensemble: "nvt" as const,
    steps: 1_000,
    timeStepPs: 0.002,
    simulatedTimePs: 2,
    temperature: { points: [{ step: 0, kelvin: 300 }] },
    thermostat: { kind: "langevin" as const, collisionFrequencyPerPs: 1 },
    barostat: { kind: "none" as const },
    constraints: { bondsToHydrogen: false },
    restraints: [],
    nonbonded: {
      cutoffAngstrom: 9,
      electrostatics: "pme" as const,
      ewaldTolerance: 0.00001,
      periodicBoundary: true as const,
    },
    randomSeed: { policy: "fixed" as const, seed: 20260823 },
    resourceProfile: {
      backendCapabilityId: "local.cpu",
      cpuCores: 2,
      gpuCount: 0,
      memoryBytes: 1_000_000,
      scratchBytes: 1_000_000,
      wallTimeSeconds: 60,
    },
    checkpoint: { cadenceSteps: 500, retainCount: 2, stopAfterCheckpointSupported: true },
    acceptanceCriteria: [criterion],
    sourceDecisionRefs: [constructDecision.id, forceFieldDecision.id, protonationDecision.id],
    rendererCompatibilityVersion: "1.0.0",
  };
  const equilibrationStageBase = {
    ...commonDynamicsStage,
    id: "stage-equilibration-1",
    sequence: 1,
    kind: "equilibration" as const,
    name: "Fixture equilibration",
    parentStageId: null,
    requiredParentOutputRole: null,
    inputs: [topology, coordinates],
    outputs: [
      { role: "restart" as const, required: true, mediaType: "application/octet-stream" },
      { role: "mdout" as const, required: true, mediaType: "text/plain" },
      { role: "mdinfo" as const, required: true, mediaType: "text/plain" },
    ],
    stageDigest: digest("b"),
  };
  const equilibrationStage = {
    ...equilibrationStageBase,
    stageDigest: computeMdStageSpecDigest(equilibrationStageBase),
  };
  const productionStageBase = {
    ...commonDynamicsStage,
    id: "stage-production-1",
    sequence: 2,
    kind: "production" as const,
    randomSeed: { policy: "replica_segment" as const, segmentCount: 2 },
    name: "Fixture production segment template",
    parentStageId: equilibrationStage.id,
    requiredParentOutputRole: "restart" as const,
    inputs: [topology],
    outputs: [
      { role: "restart" as const, required: true, mediaType: "application/octet-stream" },
      {
        role: "trajectory" as const,
        required: true,
        mediaType: "application/x-netcdf",
        cadenceSteps: 100,
      },
      { role: "mdout" as const, required: true, mediaType: "text/plain" },
      { role: "mdinfo" as const, required: true, mediaType: "text/plain" },
    ],
    stageDigest: digest("b"),
  };
  const productionStage = {
    ...productionStageBase,
    stageDigest: computeMdStageSpecDigest(productionStageBase),
  };
  const productionCapability = {
    id: "amber.production-md",
    version: "1.0.0",
    contractDigest: digest("c"),
  };
  const equilibrationCapability = {
    ...productionCapability,
    id: "amber.membrane-equilibration",
  };
  const productionSkill = {
    skillId: "amber.production-md",
    version: "1.0.0",
    contentDigest: digest("d"),
  };
  const equilibrationSkill = {
    ...productionSkill,
    skillId: "amber.membrane-equilibration",
    contentDigest: digest("e"),
  };
  const protocolBase = {
    schemaVersion: MdProtocolSchemaVersion,
    id: "md-protocol-1",
    missionId: "mission-md-1",
    revision: 1,
    status: "approved" as const,
    system: systemReference,
    forceFieldStack: system.forceFieldStack,
    targetEngine: { family: "amber" as const, versionRange: ">=24" },
    capabilityRefs: [equilibrationCapability, productionCapability],
    stages: [equilibrationStage, productionStage],
    decisionRefs: [constructDecision.id, forceFieldDecision.id, protonationDecision.id],
    assumptions: ["Contract fixture; not scientific evidence"],
    skillRefs: [equilibrationSkill, productionSkill],
    compilerVersion: "2.0.0",
    protocolDigest: digest("e"),
    approvedByRef: "approval-protocol-1",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const protocol = {
    ...protocolBase,
    protocolDigest: computeMdWorkflowProtocolDigest(protocolBase),
  };
  const policyBase = {
    id: "md-policy-1",
    version: "1.0.0",
    minimumApprovalRole: "scientific_reviewer",
    capabilityByStageKind: {
      minimization: { ...productionCapability, id: "amber.minimization" },
      heating: { ...productionCapability, id: "amber.heating" },
      equilibration: equilibrationCapability,
      production: productionCapability,
    },
    riskByStageKind: {
      minimization: 3 as const,
      heating: 3 as const,
      equilibration: 4 as const,
      production: 4 as const,
    },
    retryPolicy: { maximumAttempts: 2, ambiguityRequiresReconciliation: true as const },
  };
  const policy = { ...policyBase, policyDigest: computeMdCompilerPolicyDigest(policyBase) };
  const environmentBase = {
    schemaVersion: MdEnvironmentCapabilitySnapshotSchemaVersion,
    id: "environment-amber-1",
    engine: {
      engine: "amber",
      executable: "pmemd",
      version: "24",
      buildDigest: digest("f"),
      environmentDigest: digest("0"),
      compatibilityVersion: "1.0.0",
    },
    capabilities: [equilibrationCapability, productionCapability],
    targetCompatibility: {
      family: "amber" as const,
      versionRange: ">=24",
      compatible: true as const,
      evaluatorVersion: "1.0.0",
      evidenceDigest: digest("1"),
    },
    observedAt: timestamp,
  };
  const environment = {
    ...environmentBase,
    environmentDigest: computeMdEnvironmentDigest(environmentBase),
  };
  const plan = {
    id: "plan-md-1",
    missionId: "mission-md-1",
    version: 1,
    revision: 3,
    status: "approved" as const,
    planDigest: digest("2"),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return {
    plan,
    planApproval: approval({
      id: "approval-plan-1",
      subjectType: "plan",
      subjectId: plan.id,
      subjectVersion: plan.version,
      subjectRevision: plan.revision,
      payloadDigest: plan.planDigest,
      policyDigest: policy.policyDigest,
    }),
    system,
    systemApproval: approval({
      id: "approval-system-1",
      subjectType: "biomolecular_system_manifest",
      subjectId: system.id,
      subjectVersion: system.revision,
      subjectRevision: system.revision,
      payloadDigest: system.manifestDigest,
      policyDigest: policy.policyDigest,
    }),
    protocol,
    protocolApproval: approval({
      id: protocol.approvedByRef!,
      subjectType: "md_protocol",
      subjectId: protocol.id,
      subjectVersion: protocol.revision,
      subjectRevision: protocol.revision,
      payloadDigest: protocol.protocolDigest,
      policyDigest: policy.policyDigest,
    }),
    decisionRefs: [constructDecision, forceFieldDecision, protonationDecision],
    decisionApprovals: [
      approval({
        id: constructDecision.approvalRef,
        subjectType: "decision",
        subjectId: constructDecision.id,
        subjectVersion: constructDecision.revision,
        subjectRevision: constructDecision.revision,
        payloadDigest: constructDecision.decisionDigest,
        policyDigest: policy.policyDigest,
      }),
      approval({
        id: forceFieldDecision.approvalRef,
        subjectType: "decision",
        subjectId: forceFieldDecision.id,
        subjectVersion: forceFieldDecision.revision,
        subjectRevision: forceFieldDecision.revision,
        payloadDigest: forceFieldDecision.decisionDigest,
        policyDigest: policy.policyDigest,
      }),
      approval({
        id: protonationDecision.approvalRef,
        subjectType: "decision",
        subjectId: protonationDecision.id,
        subjectVersion: protonationDecision.revision,
        subjectRevision: protonationDecision.revision,
        payloadDigest: protonationDecision.decisionDigest,
        policyDigest: policy.policyDigest,
      }),
    ],
    stageSkillBindings: [
      {
        stageId: equilibrationStage.id,
        fragments: [
          {
            ...equilibrationSkill,
            fragmentId: "protocol-equilibration",
            fragmentDigest: digest("3"),
            relativePath: "protocols/equilibration.md",
            selector: "#equilibration",
          },
        ],
      },
      {
        stageId: productionStage.id,
        fragments: [
          {
            ...productionSkill,
            fragmentId: "protocol-production",
            fragmentDigest: digest("3"),
            relativePath: "protocols/production.md",
            selector: "#production",
          },
        ],
      },
    ],
    policy,
    environment,
  };
}

export function makeProductionInput(): MdProductionSegmentCompilationInput {
  const compilation = makeInput();
  const equilibrationStage = compilation.protocol.stages[0]!;
  const productionStage = compilation.protocol.stages[1]!;
  const restart = {
    artifactId: "artifact-equilibration-restart",
    evidenceRef: "evidence-equilibration-restart",
    role: "restart" as const,
    contentDigest: digest("f"),
    mediaType: "application/octet-stream",
  };
  const resultArtifact = (role: "mdout" | "mdinfo", value: string) => ({
    artifactId: `artifact-${role}`,
    evidenceRef: `evidence-${role}`,
    role,
    contentDigest: digest(value),
    mediaType: "text/plain",
  });
  const parentResultBase = {
    schemaVersion: MdStageResultSchemaVersion,
    id: "result-equilibration-1",
    revision: 1,
    missionId: compilation.plan.missionId,
    workUnitId: compileMdWorkflowProtocol(compilation).workUnits[0]!.id,
    operationId: "operation-equilibration-1",
    operationReceiptId: "receipt-equilibration-1",
    protocolId: compilation.protocol.id,
    protocolRevision: compilation.protocol.revision,
    protocolDigest: compilation.protocol.protocolDigest,
    stageId: equilibrationStage.id,
    stageRevision: equilibrationStage.revision,
    stageDigest: equilibrationStage.stageDigest,
    stageKind: "equilibration" as const,
    terminalReason: "completed" as const,
    exitCode: 0,
    signal: null,
    startedAt: timestamp,
    finishedAt: "2026-08-23T12:01:00.000Z",
    startStep: 0,
    endStep: equilibrationStage.steps,
    startTimePs: 0,
    endTimePs: equilibrationStage.simulatedTimePs!,
    engine: compilation.environment.engine,
    artifacts: [restart, resultArtifact("mdout", "4"), resultArtifact("mdinfo", "5")],
    warnings: [],
    errors: [],
    validationStatus: "passed" as const,
    validationRefs: ["validation-equilibration-1"],
    resultDigest: digest("6"),
  };
  const parentStageResult = {
    ...parentResultBase,
    resultDigest: computeMdStageResultDigest(parentResultBase),
  };
  const parentAssessmentBase = {
    schemaVersion: MdAssessmentSchemaVersion,
    id: "assessment-equilibration-1",
    revision: 1,
    missionId: compilation.plan.missionId,
    stageResultId: parentStageResult.id,
    stageResultRevision: parentStageResult.revision,
    stageResultDigest: parentStageResult.resultDigest,
    status: "accepted" as const,
    evaluations: equilibrationStage.acceptanceCriteria.map((criterion) => ({
      criterionId: criterion.id,
      criterionDigest: criterion.criterionDigest,
      required: criterion.required,
      status: "passed" as const,
      summary: "Exact fixture gate passed",
      evidenceRefs: ["validation-equilibration-1"],
    })),
    nextStageEligible: true,
    limitations: ["Contract fixture only"],
    evidenceRefs: ["validation-equilibration-1"],
    assessor: actor,
    createdAt: timestamp,
  };
  const parentStageAssessment = {
    ...parentAssessmentBase,
    assessmentDigest: computeMdStageAssessmentDigest(parentAssessmentBase),
  };
  const replicaSet = {
    schemaVersion: MdReplicaSetSchemaVersion,
    id: "replica-set-1",
    missionId: compilation.plan.missionId,
    revision: 1,
    protocolId: compilation.protocol.id,
    protocolRevision: compilation.protocol.revision,
    protocolDigest: compilation.protocol.protocolDigest,
    systemManifestDigest: compilation.system.manifestDigest,
    replicaCount: 1,
    replicas: [
      {
        id: "replica-1",
        index: 1,
        seed: 771_001,
        segmentSeeds: [771_001, 771_002],
        initialRestart: restart,
      },
    ],
    seedPolicyDigest: digest("7"),
    decisionRef: compilation.decisionRefs[0]!.id,
    createdAt: timestamp,
  };
  replicaSet.seedPolicyDigest = computeMdReplicaSeedPolicyDigest(replicaSet.replicas);
  const replicaSetDigest = computeMdReplicaSetDigest(replicaSet);
  return {
    ...compilation,
    replicaSet,
    replicaSetApproval: approval({
      id: "approval-replica-set-1",
      subjectType: "replica_set",
      subjectId: replicaSet.id,
      subjectVersion: replicaSet.revision,
      subjectRevision: replicaSet.revision,
      payloadDigest: replicaSetDigest,
      policyDigest: compilation.policy.policyDigest,
    }),
    productionStageId: productionStage.id,
    replicaId: replicaSet.replicas[0]!.id,
    segmentIndex: 0,
    parentStageResult,
    parentStageAssessment,
  };
}

export function makeNextStageInput(): MdNextStageCompilationInput {
  const source = makeProductionInput();
  const initialStage = source.protocol.stages[0]!;
  const downstreamStageBase = {
    ...source.protocol.stages[1]!,
    id: "stage-equilibration-2",
    kind: "equilibration" as const,
    name: "Second gated equilibration",
    randomSeed: { policy: "fixed" as const, seed: 771_010 },
    stageDigest: digest("0"),
  };
  const downstreamStage = {
    ...downstreamStageBase,
    stageDigest: computeMdStageSpecDigest(downstreamStageBase),
  };
  const productionStageBase = {
    ...source.protocol.stages[1]!,
    sequence: 3,
    parentStageId: downstreamStage.id,
    stageDigest: digest("0"),
  };
  const productionStage = {
    ...productionStageBase,
    stageDigest: computeMdStageSpecDigest(productionStageBase),
  };
  const protocolBase = {
    ...source.protocol,
    stages: [initialStage, downstreamStage, productionStage],
    protocolDigest: digest("0"),
  };
  const protocol = {
    ...protocolBase,
    protocolDigest: computeMdWorkflowProtocolDigest(protocolBase),
  };
  const parentResultBase = {
    ...source.parentStageResult,
    protocolDigest: protocol.protocolDigest,
    resultDigest: digest("0"),
  };
  const parentStageResult: MdStageResult = {
    ...parentResultBase,
    resultDigest: computeMdStageResultDigest(parentResultBase),
  };
  const parentAssessmentBase = {
    ...source.parentStageAssessment,
    stageResultDigest: parentStageResult.resultDigest,
    assessmentDigest: digest("0"),
  };
  const parentStageAssessment: MdStageAssessment = {
    ...parentAssessmentBase,
    assessmentDigest: computeMdStageAssessmentDigest(parentAssessmentBase),
  };

  return {
    plan: source.plan,
    planApproval: source.planApproval,
    system: source.system,
    systemApproval: source.systemApproval,
    protocol,
    protocolApproval: approval({
      id: protocol.approvedByRef!,
      subjectType: "md_protocol",
      subjectId: protocol.id,
      subjectVersion: protocol.revision,
      subjectRevision: protocol.revision,
      payloadDigest: protocol.protocolDigest,
      policyDigest: source.policy.policyDigest,
    }),
    decisionRefs: source.decisionRefs,
    decisionApprovals: source.decisionApprovals,
    stageSkillBindings: [
      source.stageSkillBindings[0]!,
      {
        stageId: downstreamStage.id,
        fragments: source.stageSkillBindings[0]!.fragments,
      },
      source.stageSkillBindings[1]!,
    ],
    policy: source.policy,
    environment: source.environment,
    nextStageId: downstreamStage.id,
    parentStageResult,
    parentStageAssessment,
  };
}

export function withLegacyDraftSystem<T extends MdProtocolCompilationInput>(input: T): T {
  const {
    forceFieldStackDecisionId: _forceFieldStackDecisionId,
    membraneModelDecisionId: _membraneModelDecisionId,
    ...systemFields
  } = input.system;
  const proteins = input.system.components.proteins.map((protein) => {
    const { protonationDecisionId: _protonationDecisionId, ...proteinFields } = protein;
    return proteinFields;
  });
  const legacyBase = {
    ...systemFields,
    schemaVersion: BiomolecularSystemManifestSchemaVersion,
    decisionRefs: input.system.decisionRefs.filter((reference) =>
      ["construct", "microstate", "pose", "other"].includes(reference.kind),
    ),
    components: { ...input.system.components, proteins },
    manifestDigest: digest("0"),
  };
  const legacy = {
    ...legacyBase,
    manifestDigest: computeBiomolecularSystemManifestDigest(legacyBase),
  };
  return { ...input, system: legacy as unknown as T["system"] };
}
