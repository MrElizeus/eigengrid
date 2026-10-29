import {
  BiomolecularSystemBuildRequestSchema,
  BiomolecularSystemBuildRequestSchemaVersion,
  BiomolecularSystemBuildWorkUnitParametersSchema,
  WorkUnitSchema,
  canonicalJson,
  digestCanonical,
  type EvidenceReference,
  type BiomolecularDecision,
  type WorkUnit,
  type BiomolecularSystemBuildRequest,
} from "@eigengrid/scientific-schema";

const requiredEvidenceKinds = ["topology", "coordinates", "atom_map"] as const;

function canonicalSet(values: readonly string[], label: string): string[] {
  const sorted = [...values].sort();
  if (new Set(sorted).size !== sorted.length) throw new Error(`${label} must be unique`);
  return sorted;
}

function exactEvidence(
  evidence: readonly EvidenceReference[],
  missionId: string,
  id: string,
  label: string,
): EvidenceReference {
  const matches = evidence.filter((item) => item.id === id);
  if (
    matches.length !== 1 ||
    matches[0]!.missionId !== missionId ||
    !matches[0]!.immutable ||
    !matches[0]!.contentDigest
  ) {
    throw new Error(`${label} must resolve to one immutable evidence reference in this mission`);
  }
  return matches[0]!;
}

/** Stable identity before the operation crosses its durable effect boundary. */
export function systemPreparationEffectIdentity(workUnitValue: unknown): {
  jobId: string;
  attemptId: string;
  operationId: string;
  reservationId: string;
  idempotencyKey: string;
} {
  const workUnit = WorkUnitSchema.parse(workUnitValue);
  if (
    workUnit.kind !== "scientific_capability" ||
    workUnit.protocolFragment.kind !== "scientific_capability" ||
    workUnit.protocolFragment.capability.id !== "biomolecular.build-system" ||
    workUnit.executionPolicy.capability !== "biomolecular.build-system" ||
    workUnit.executionPolicy.riskClass !== 3
  ) {
    throw new Error("Amber system preparation requires its exact typed build-system WorkUnit");
  }
  const parameters = BiomolecularSystemBuildWorkUnitParametersSchema.parse(
    workUnit.protocolFragment.parameters,
  );
  const token = digestCanonical({
    schemaVersion: "eigengrid.amber-system-preparation-effect-identity/v1",
    missionId: workUnit.missionId,
    planId: workUnit.planId,
    planVersion: workUnit.planVersion,
    workUnitId: workUnit.id,
    parametersDigest: digestCanonical(parameters),
    outputContractDigest: digestCanonical(workUnit.outputContract),
  }).slice(0, 32);
  const jobId = `job-amber-prep-${token}`;
  const attemptId = `attempt-amber-prep-${token}-1`;
  if (
    (workUnit.jobId != null && workUnit.jobId !== jobId) ||
    (workUnit.attemptId != null && workUnit.attemptId !== attemptId)
  ) {
    throw new Error("Amber system-preparation WorkUnit has a conflicting durable job identity");
  }
  return {
    jobId,
    attemptId,
    operationId: `operation-amber-prep-${token}`,
    reservationId: `reservation-amber-prep-${token}`,
    idempotencyKey: `amber-system-preparation/${workUnit.missionId}/${workUnit.planId}/${workUnit.id}/${token}`,
  };
}

/** Compose the v2 effect request exclusively from the claimed WorkUnit and
 * immutable mission evidence. It carries no executable, argv, path or shell. */
export function createBiomolecularSystemBuildRequest(input: {
  workUnit: WorkUnit;
  evidence: readonly EvidenceReference[];
  /** Decisions returned by the durable biomolecular-decision projection. */
  decisions: readonly Pick<
    BiomolecularDecision,
    "id" | "missionId" | "revision" | "kind" | "status" | "decisionDigest" | "approvalRef"
  >[];
}) {
  const workUnit = WorkUnitSchema.parse(input.workUnit);
  if (
    workUnit.state !== "claimed" ||
    workUnit.protocolFragment.kind !== "scientific_capability" ||
    workUnit.protocolFragment.capability.id !== "biomolecular.build-system" ||
    workUnit.protocolFragment.capability.version !== "1.0.0" ||
    workUnit.executionPolicy.capability !== "biomolecular.build-system" ||
    workUnit.executionPolicy.riskClass !== 3 ||
    workUnit.protocolFragment.riskClass !== 3
  ) {
    throw new Error("Amber system preparation requires a claimed v1 typed build-system WorkUnit");
  }
  const parameters = BiomolecularSystemBuildWorkUnitParametersSchema.parse(
    workUnit.protocolFragment.parameters,
  );
  const binding = parameters.systemBuild;
  const identity = systemPreparationEffectIdentity(workUnit);
  const sourceIds = canonicalSet(binding.sourceEvidenceRefs, "System-build source evidence");
  const inputIds = canonicalSet(
    [...sourceIds, binding.forceFieldStackEvidenceRef],
    "System-build WorkUnit input evidence",
  );
  if (
    canonicalJson(canonicalSet(workUnit.inputRefs, "WorkUnit input evidence")) !==
    canonicalJson(inputIds)
  ) {
    throw new Error(
      "System-build WorkUnit inputs must be exactly its source and force-field evidence",
    );
  }
  for (const kind of requiredEvidenceKinds) {
    if (!workUnit.outputContract.requiredEvidenceKinds.includes(kind)) {
      throw new Error(`System-build output contract is missing ${kind} evidence`);
    }
  }
  for (const kind of ["artifact_integrity", "topology_integrity"] as const) {
    if (!workUnit.outputContract.requiredObservationKinds.includes(kind)) {
      throw new Error(`System-build output contract is missing ${kind} QC observation`);
    }
  }
  const sourceEvidence = sourceIds.map((id) => {
    const item = exactEvidence(input.evidence, workUnit.missionId, id, "System-build source");
    return { id: item.id, contentDigest: item.contentDigest };
  });
  const primary = exactEvidence(
    input.evidence,
    workUnit.missionId,
    binding.primaryInputEvidenceId,
    "Primary system-build input",
  );
  const stackEvidence = exactEvidence(
    input.evidence,
    workUnit.missionId,
    binding.forceFieldStackEvidenceRef,
    "Force-field stack input",
  );
  if (stackEvidence.contentDigest !== binding.forceFieldStack.digest) {
    throw new Error("Force-field stack evidence digest differs from the exact stack binding");
  }
  if (stackEvidence.kind !== "force_field_stack") {
    throw new Error("Force-field stack input must use force_field_stack evidence kind");
  }
  const decisionRefs = [...binding.decisionRefs].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const requiredDecisions = new Set(decisionRefs.map((decision) => decision.id));
  if (requiredDecisions.size !== decisionRefs.length) {
    throw new Error("System-build decision references must be unique");
  }
  const approvedDecisionRefs = input.decisions
    .map((decision) => {
      if (
        decision.missionId !== workUnit.missionId ||
        decision.status !== "approved" ||
        !decision.approvalRef
      ) {
        throw new Error("System-build decisions must be durably approved in this mission");
      }
      return {
        id: decision.id,
        revision: decision.revision,
        kind: decision.kind,
        decisionDigest: decision.decisionDigest,
        approvalRef: decision.approvalRef,
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  if (canonicalJson(approvedDecisionRefs) !== canonicalJson(decisionRefs)) {
    throw new Error("System-build decision references differ from the exact approved revisions");
  }
  const request = BiomolecularSystemBuildRequestSchema.parse({
    schemaVersion: BiomolecularSystemBuildRequestSchemaVersion,
    missionId: workUnit.missionId,
    planId: workUnit.planId,
    planVersion: workUnit.planVersion,
    intendedJobId: identity.jobId,
    intendedAttemptId: identity.attemptId,
    inputEvidenceId: primary.id,
    inputContentDigest: primary.contentDigest,
    workUnitId: workUnit.id,
    capability: workUnit.protocolFragment.capability,
    systemManifest: { id: parameters.manifestId, revision: parameters.manifestRevision },
    sourceEvidence,
    decisionRefs,
    forceFieldStack: binding.forceFieldStack,
    outputArtifacts: binding.outputArtifacts,
    parametersDigest: digestCanonical(workUnit.protocolFragment.parameters),
    outputContractDigest: digestCanonical(workUnit.outputContract),
  });
  if (request.schemaVersion !== BiomolecularSystemBuildRequestSchemaVersion) {
    throw new Error("New system-build effects require the v2 operation request");
  }
  return request as Extract<
    BiomolecularSystemBuildRequest,
    { schemaVersion: typeof BiomolecularSystemBuildRequestSchemaVersion }
  >;
}
