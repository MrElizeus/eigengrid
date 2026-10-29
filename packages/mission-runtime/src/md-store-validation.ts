/** Pure MD projection validation and canonical identities; no persistence or engine execution. */
import {
  MdExecutionBindingParametersSchema,
  MdExecutionBindingParametersSchemaVersion,
  MdScientificAssessmentSchema,
  MdStageAssessmentSchema,
  MdStageOperationRequestSchema,
  ReplicaConvergenceAssessmentSchema,
  WorkUnitSchema,
  assertBiomolecularDecisionDigest,
  assertMdStageResultDigest,
  canonicalJson,
  computeBiomolecularDecisionDigest,
  computeMdWorkflowProtocolDigest,
  digestCanonical,
  mdForceFieldParameterDigests,
  type AtomMap,
  type BiomolecularSystemManifest,
  type ConstructDecision,
  type ForceFieldStackDecision,
  type ForceFieldStackManifest,
  type MdScientificAssessment,
  type MdStageAssessment,
  type MdStageOperationRequest,
  type MdStageResult,
  type MdWorkflowProtocol,
  type MembraneModelDecision,
  type MicrostateDecision,
  type PoseDecision,
  type ReceptorProtonationDecision,
  type ReplicaConvergenceAssessment,
  type ReplicaSet,
  type WorkUnit,
} from "@eigengrid/scientific-schema";
import { ScientificDigestMismatchError, ScientificIntegrityError } from "./errors";

export type BiomolecularDecision =
  | ConstructDecision
  | MicrostateDecision
  | PoseDecision
  | ForceFieldStackDecision
  | MembraneModelDecision
  | ReceptorProtonationDecision;

export type MdAssessment =
  | MdStageAssessment
  | ReplicaConvergenceAssessment
  | MdScientificAssessment;

export interface CompleteMdWorkUnitAuthority {
  stageResultId: string;
  stageResultDigest: string;
  assessmentId: string;
  assessmentRevision: number;
  assessmentDigest: string;
  completedAt: string;
}

export const MdStageAssessmentOperationRequestSchemaVersion =
  "eigengrid.md-stage-assessment-operation-request/v1" as const;

export interface MdStageAssessmentOperationRequest {
  schemaVersion: typeof MdStageAssessmentOperationRequestSchemaVersion;
  workUnitId: string;
  stageResult: { id: string; revision: number; digest: string };
  assessment: { id: string; revision: number; digest: string };
}

export function createMdStageAssessmentOperationRequest(input: {
  workUnitId: string;
  stageResult: Pick<MdStageResult, "id" | "revision" | "resultDigest">;
  assessment: Pick<MdStageAssessment, "id" | "revision" | "assessmentDigest">;
}): MdStageAssessmentOperationRequest {
  return {
    schemaVersion: MdStageAssessmentOperationRequestSchemaVersion,
    workUnitId: input.workUnitId,
    stageResult: {
      id: input.stageResult.id,
      revision: input.stageResult.revision,
      digest: input.stageResult.resultDigest,
    },
    assessment: {
      id: input.assessment.id,
      revision: input.assessment.revision,
      digest: input.assessment.assessmentDigest,
    },
  };
}

export const SYSTEM_MANIFEST_BUILD_CAPABILITIES = Object.freeze([
  "biomolecular.build-system",
  "biomolecular.system-assembly",
  "amber.tleap-complex-assembly",
] as const);

export function isSystemManifestBuildCapability(capabilityId: string): boolean {
  return SYSTEM_MANIFEST_BUILD_CAPABILITIES.some((candidate) => candidate === capabilityId);
}

export const FORCE_FIELD_STACK_PUBLICATION_CAPABILITIES = Object.freeze([
  "amber.force-field-stack",
  "biomolecular.force-field-compatibility",
] as const);

export const ATOM_MAP_PUBLICATION_CAPABILITIES = Object.freeze([
  "amber.topology-coordinate-validation",
  "biomolecular.system-provenance",
] as const);

export function isOneOfCapabilities(capabilityId: string, allowed: readonly string[]): boolean {
  return allowed.some((candidate) => candidate === capabilityId);
}

export interface BiomolecularMaterialPublicationAuthority {
  missionId: string;
  operationId: string;
  operationReceiptId: string;
}

export type MaterialSubjectType = "system_manifest" | "force_field_stack" | "atom_map";

export interface ForceFieldEvidenceRequirement {
  evidenceRef: string;
  roles: string[];
}

export function forceFieldEvidenceRequirements(
  stack: ForceFieldStackManifest,
): ForceFieldEvidenceRequirement[] {
  const rolesByEvidence = new Map<string, Set<string>>();
  const add = (evidenceRefs: readonly string[], role: string): void => {
    for (const evidenceRef of evidenceRefs) {
      const roles = rolesByEvidence.get(evidenceRef) ?? new Set<string>();
      roles.add(role);
      rolesByEvidence.set(evidenceRef, roles);
    }
  };
  add(stack.protein.sourceEvidenceRefs, "parameter:protein");
  add(stack.lipid.sourceEvidenceRefs, "parameter:lipid");
  add(stack.water.parameterSet.sourceEvidenceRefs, "parameter:water");
  add(stack.ions.sourceEvidenceRefs, "parameter:ions");
  for (const ligand of stack.ligands) {
    add(ligand.parameterSet.sourceEvidenceRefs, `parameter:ligand:${ligand.componentId}`);
  }
  for (const cofactor of stack.cofactors) {
    add(cofactor.parameterSet.sourceEvidenceRefs, `parameter:cofactor:${cofactor.componentId}`);
  }
  add(stack.compatibilityEvidenceRefs, "compatibility");
  return [...rolesByEvidence.entries()]
    .map(([evidenceRef, roles]) => ({ evidenceRef, roles: [...roles].sort() }))
    .sort((left, right) => left.evidenceRef.localeCompare(right.evidenceRef));
}

export function assertForceFieldMaterialDigests(
  stack: ForceFieldStackManifest,
  evidenceDigests: ReadonlyMap<string, string>,
  linkedDigests: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): void {
  const requireDigest = (
    subject: string,
    digest: string,
    evidenceRefs: readonly string[],
  ): void => {
    if (
      !evidenceRefs.some(
        (evidenceRef) =>
          evidenceDigests.get(evidenceRef) === digest ||
          linkedDigests.get(evidenceRef)?.has(digest),
      )
    ) {
      throw new ScientificIntegrityError(`Force-field ${subject} digest lacks exact CAS evidence`, {
        stackId: stack.id,
        digest,
      });
    }
  };
  requireDigest(
    "protein parameters",
    stack.protein.parameterDigest,
    stack.protein.sourceEvidenceRefs,
  );
  requireDigest("lipid parameters", stack.lipid.parameterDigest, stack.lipid.sourceEvidenceRefs);
  requireDigest(
    "water parameters",
    stack.water.parameterSet.parameterDigest,
    stack.water.parameterSet.sourceEvidenceRefs,
  );
  requireDigest("ion parameters", stack.ions.parameterDigest, stack.ions.sourceEvidenceRefs);
  for (const ligand of stack.ligands) {
    const prefix = `ligand ${ligand.componentId}`;
    requireDigest(
      `${prefix} parameters`,
      ligand.parameterSet.parameterDigest,
      ligand.parameterSet.sourceEvidenceRefs,
    );
    requireDigest(
      `${prefix} atom types`,
      ligand.atomTypeDigest,
      ligand.parameterSet.sourceEvidenceRefs,
    );
    requireDigest(`${prefix} charges`, ligand.chargeDigest, ligand.parameterSet.sourceEvidenceRefs);
  }
  for (const cofactor of stack.cofactors) {
    requireDigest(
      `cofactor ${cofactor.componentId} parameters`,
      cofactor.parameterSet.parameterDigest,
      cofactor.parameterSet.sourceEvidenceRefs,
    );
  }
}

export function assertForceFieldStackCoversSystem(
  stack: ForceFieldStackManifest,
  manifest: BiomolecularSystemManifest,
): void {
  const expectedLigands = [...manifest.components.ligands]
    .map((component) => ({ id: component.id, formalCharge: component.formalCharge }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const observedLigands = [...stack.ligands]
    .map((entry) => ({ id: entry.componentId, formalCharge: entry.formalCharge }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const expectedCofactors = manifest.components.cofactors.map((component) => component.id).sort();
  const observedCofactors = stack.cofactors.map((entry) => entry.componentId).sort();
  if (
    canonicalJson(expectedLigands) !== canonicalJson(observedLigands) ||
    canonicalJson(expectedCofactors) !== canonicalJson(observedCofactors) ||
    manifest.components.waters.some((water) => water.waterModel !== stack.water.model)
  ) {
    throw new ScientificIntegrityError(
      "Force-field stack does not cover the exact system components",
      { manifestId: manifest.id, stackId: stack.id },
    );
  }
}

export function assertMdProtocolForceFieldAuthority(
  protocol: MdWorkflowProtocol,
  manifest: BiomolecularSystemManifest,
  stack: ForceFieldStackManifest,
): void {
  if (
    protocol.system.id !== manifest.id ||
    protocol.system.revision !== manifest.revision ||
    protocol.system.manifestDigest !== manifest.manifestDigest ||
    protocol.system.topologyDigest !== manifest.topologyDigest ||
    protocol.system.coordinateDigest !== manifest.coordinateDigest ||
    protocol.system.atomMapDigest !== manifest.atomMapDigest
  ) {
    throw new ScientificIntegrityError(
      "MD protocol does not bind the exact system manifest authority",
      { protocolId: protocol.id, manifestId: manifest.id },
    );
  }
  if (
    canonicalJson(protocol.forceFieldStack) !== canonicalJson(manifest.forceFieldStack) ||
    stack.id !== manifest.forceFieldStack.id ||
    stack.revision !== manifest.forceFieldStack.revision ||
    stack.stackDigest !== manifest.forceFieldStack.digest
  ) {
    throw new ScientificIntegrityError(
      "MD protocol does not bind the exact system force-field stack authority",
      { protocolId: protocol.id, manifestId: manifest.id, stackId: stack.id },
    );
  }
  const admission = protocol.forceFieldEngineAdmission?.admission;
  if (
    admission !== undefined &&
    (protocol.purpose !== "technical_pilot" ||
      admission.missionId !== protocol.missionId ||
      canonicalJson(admission.system) !== canonicalJson(protocol.system) ||
      canonicalJson(admission.forceFieldStack) !== canonicalJson(protocol.forceFieldStack) ||
      canonicalJson(admission.targetEngine) !== canonicalJson(protocol.targetEngine) ||
      canonicalJson([...admission.parameterDigests].sort()) !==
        canonicalJson(mdForceFieldParameterDigests(stack)))
  )
    throw new ScientificIntegrityError(
      "Technical engine admission does not bind the exact protocol and frozen parameters",
      { protocolId: protocol.id },
    );
  if (
    admission === undefined &&
    !stack.engineCompatibility.some(
      (compatibility) =>
        compatibility.engine === protocol.targetEngine.family &&
        compatibility.versionRange === protocol.targetEngine.versionRange,
    )
  ) {
    throw new ScientificIntegrityError(
      "MD protocol target engine lacks an exact force-field compatibility entry",
      {
        protocolId: protocol.id,
        engine: protocol.targetEngine.family,
        versionRange: protocol.targetEngine.versionRange,
      },
    );
  }
}

export function assertAtomMapCoversSystem(
  atomMap: AtomMap,
  manifest: BiomolecularSystemManifest,
): void {
  const componentCounts = new Map<string, number>();
  for (const components of Object.values(manifest.components)) {
    for (const component of components) componentCounts.set(component.id, component.atomCount);
  }
  const observedCounts = new Map<string, number>();
  for (const entry of atomMap.entries) {
    if (!componentCounts.has(entry.componentId)) {
      throw new ScientificIntegrityError("Atom map references a component outside its system", {
        atomMapId: atomMap.id,
        componentId: entry.componentId,
      });
    }
    observedCounts.set(entry.componentId, (observedCounts.get(entry.componentId) ?? 0) + 1);
  }
  for (const [componentId, atomCount] of componentCounts) {
    if (observedCounts.get(componentId) !== atomCount) {
      throw new ScientificIntegrityError("Atom map component atom count is not exact", {
        atomMapId: atomMap.id,
        componentId,
      });
    }
  }
}

/** Detect the versioned MD execution contract without treating every capability WorkUnit as MD. */
export function workUnitUsesMdExecutionBinding(workUnit: WorkUnit): boolean {
  if (workUnit.protocolFragment.kind !== "scientific_capability") return false;
  const parameters = workUnit.protocolFragment.parameters;
  return (
    typeof parameters === "object" &&
    parameters !== null &&
    "schemaVersion" in parameters &&
    parameters.schemaVersion === MdExecutionBindingParametersSchemaVersion
  );
}

/**
 * Validates the command-free v2 execution authority against its canonical
 * WorkUnit and, when supplied, the exact observed result. This intentionally
 * does not reconstruct an adapter command inside the runtime.
 */
export function assertMdStageOperationRequestAuthority(
  workUnitValue: unknown,
  requestValue: unknown,
  resultValue?: unknown,
): MdStageOperationRequest {
  const workUnit = WorkUnitSchema.parse(workUnitValue);
  if (!workUnitUsesMdExecutionBinding(workUnit)) {
    throw new ScientificIntegrityError("MD stage authority requires an MD execution WorkUnit", {
      workUnitId: workUnit.id,
    });
  }
  const binding = MdExecutionBindingParametersSchema.parse(workUnit.protocolFragment.parameters);
  const request = MdStageOperationRequestSchema.parse(requestValue);
  if (
    request.workUnitId !== workUnit.id ||
    request.bindingDigest !== digestCanonical(binding) ||
    request.outputContractDigest !== digestCanonical(workUnit.outputContract) ||
    request.stage.id !== binding.stage.id ||
    request.stage.revision !== binding.stage.revision ||
    request.stage.digest !== binding.stage.digest ||
    (request.stage.kind !== undefined && request.stage.kind !== binding.stage.kind)
  ) {
    throw new ScientificIntegrityError(
      "MD stage operation authority is outside its exact WorkUnit binding",
      { workUnitId: workUnit.id },
    );
  }
  assertCanonicalSetEqual(
    "MD stage operation required evidence contract",
    request.outputs.bindings
      .filter((output) => output.required)
      .map((output) => output.canonicalRole),
    workUnit.outputContract.requiredEvidenceKinds,
  );
  if (resultValue === undefined) return request;

  const result = assertMdStageResultDigest(resultValue);
  if (
    result.workUnitId !== workUnit.id ||
    result.stageId !== request.stage.id ||
    result.stageRevision !== request.stage.revision ||
    result.stageDigest !== request.stage.digest ||
    canonicalJson(result.engine) !== canonicalJson(request.environment.engine)
  ) {
    throw new ScientificIntegrityError(
      "MD stage result does not match its exact stage or engine authorization",
      { workUnitId: workUnit.id, resultId: result.id },
    );
  }
  const authorizedOutputs = new Map(
    request.outputs.bindings.map((output) => [output.canonicalRole, output]),
  );
  for (const artifact of result.artifacts) {
    const authorized = authorizedOutputs.get(
      artifact.role as "restart" | "trajectory" | "mdout" | "mdinfo",
    );
    if (authorized === undefined || authorized.mediaType !== artifact.mediaType) {
      throw new ScientificIntegrityError(
        "MD stage result artifact is outside its exact output-role authorization",
        { workUnitId: workUnit.id, resultId: result.id, artifactRole: artifact.role },
      );
    }
  }
  if (
    result.terminalReason === "completed" &&
    request.outputs.bindings.some(
      (output) =>
        output.required &&
        !result.artifacts.some((artifact) => artifact.role === output.canonicalRole),
    )
  ) {
    throw new ScientificIntegrityError(
      "Completed MD stage result is missing an authorized required output",
      { workUnitId: workUnit.id, resultId: result.id },
    );
  }
  return request;
}

export function omitFields(value: object, excluded: ReadonlySet<string>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!excluded.has(key)) payload[key] = item;
  }
  return payload;
}

export function selfDigest(value: object, field: string): string {
  return digestCanonical(omitFields(value, new Set([field])));
}

export function computeBiomolecularDecisionMaterialDigest(value: BiomolecularDecision): string {
  return computeBiomolecularDecisionDigest(value);
}

export function computeMdProtocolMaterialDigest(value: MdWorkflowProtocol): string {
  return computeMdWorkflowProtocolDigest(value);
}

export function computeMdReplicaSetPayloadDigest(value: ReplicaSet): string {
  return digestCanonical(value);
}

export function assertSelfDigest(
  subject: string,
  value: object,
  field: string,
  actual: string,
): void {
  const expected = selfDigest(value, field);
  if (actual !== expected) throw new ScientificDigestMismatchError(subject, expected, actual);
}

export function parseBiomolecularDecision(input: unknown): BiomolecularDecision {
  return assertBiomolecularDecisionDigest(input);
}

export interface ExactDecisionEvidenceRequirement {
  evidenceRef: string;
  expectedDigest?: string;
}

export function exactDecisionEvidenceRequirements(
  decision: BiomolecularDecision,
): ExactDecisionEvidenceRequirement[] {
  const requirements = new Map<string, string | undefined>(
    decision.evidenceRefs.map((evidenceRef) => [evidenceRef, undefined]),
  );
  const addExact = (evidenceRef: string, expectedDigest: string): void => {
    const existing = requirements.get(evidenceRef);
    if (existing !== undefined && existing !== expectedDigest) {
      throw new ScientificIntegrityError(
        "Scientific decision assigns incompatible digests to one evidence identity",
        { decisionId: decision.id, evidenceRef },
      );
    }
    requirements.set(evidenceRef, expectedDigest);
  };
  if (decision.kind === "pose") {
    for (const candidate of decision.candidates) {
      for (const evidenceRef of candidate.validationEvidenceRefs) {
        if (!requirements.has(evidenceRef)) requirements.set(evidenceRef, undefined);
      }
    }
  } else if (decision.kind === "force_field_stack") {
    for (const candidate of decision.candidates) addExact(candidate.evidenceRef, candidate.digest);
  } else if (decision.kind === "membrane_model") {
    addExact(decision.receptorCoordinateEvidenceRef, decision.receptorCoordinateDigest);
    addExact(decision.orientationEvidenceRef, decision.orientationDigest);
  } else if (decision.kind === "protonation") {
    addExact(decision.inputCoordinateEvidenceRef, decision.inputCoordinateDigest);
    addExact(decision.outputCoordinateEvidenceRef, decision.outputCoordinateDigest);
  }
  return [...requirements.entries()].map(([evidenceRef, expectedDigest]) => ({
    evidenceRef,
    ...(expectedDigest === undefined ? {} : { expectedDigest }),
  }));
}

/**
 * Checks the material scientific identity that an approved decision set grants
 * to one system manifest. Persistence calls this only after loading every exact
 * revision and approval from the durable decision ledger.
 */
export function assertBiomolecularSystemDecisionAuthority(
  manifest: BiomolecularSystemManifest,
  decisions: readonly BiomolecularDecision[],
): void {
  const decisionById = new Map<string, BiomolecularDecision>();
  for (const decision of decisions) {
    if (decisionById.has(decision.id)) {
      throw new ScientificIntegrityError("System manifest decision identity is ambiguous", {
        manifestId: manifest.id,
        decisionId: decision.id,
      });
    }
    decisionById.set(decision.id, decision);
  }
  for (const reference of manifest.decisionRefs) {
    const decision = decisionById.get(reference.id);
    if (
      !decision ||
      decision.missionId !== manifest.missionId ||
      decision.revision !== reference.revision ||
      decision.kind !== reference.kind ||
      decision.status !== "approved" ||
      decision.decisionDigest !== reference.decisionDigest ||
      decision.approvalRef !== reference.approvalRef
    ) {
      throw new ScientificIntegrityError(
        "System manifest decision reference is not an exact approved decision",
        { manifestId: manifest.id, decisionId: reference.id },
      );
    }
  }
  if (decisions.length !== manifest.decisionRefs.length) {
    throw new ScientificIntegrityError("System manifest decision set is not closed", {
      manifestId: manifest.id,
    });
  }

  const requireKind = <K extends BiomolecularDecision["kind"]>(
    id: string | undefined,
    kind: K,
    subject: string,
  ): Extract<BiomolecularDecision, { kind: K }> => {
    if (!id) {
      throw new ScientificIntegrityError(`System manifest lacks its ${subject} decision`, {
        manifestId: manifest.id,
      });
    }
    const decision = decisionById.get(id);
    if (!decision || decision.kind !== kind) {
      throw new ScientificIntegrityError(`System manifest ${subject} decision has the wrong kind`, {
        manifestId: manifest.id,
        decisionId: id,
      });
    }
    return decision as Extract<BiomolecularDecision, { kind: K }>;
  };

  const construct = requireKind(manifest.constructDecisionId, "construct", "construct");
  const forceFieldDecision = requireKind(
    manifest.forceFieldStackDecisionId,
    "force_field_stack",
    "force-field stack",
  );
  if (canonicalJson(forceFieldDecision.selectedStack) !== canonicalJson(manifest.forceFieldStack)) {
    throw new ScientificIntegrityError(
      "System manifest force-field stack differs from the exact approved selection",
      { manifestId: manifest.id, decisionId: forceFieldDecision.id },
    );
  }

  const receptor = manifest.components.proteins.find((component) => component.role === "receptor");
  if (!receptor) {
    throw new ScientificIntegrityError("System manifest has no receptor component", {
      manifestId: manifest.id,
    });
  }
  const protonation = requireKind(
    receptor.protonationDecisionId,
    "protonation",
    "receptor protonation",
  );
  if (
    protonation.subjectComponentId !== receptor.id ||
    protonation.subjectKind !== "protein" ||
    protonation.subjectRole !== "receptor" ||
    protonation.inputCoordinateDigest !== construct.outputConstructDigest ||
    protonation.outputCoordinateDigest !== receptor.coordinateDigest ||
    protonation.selectedFormalCharge !== receptor.formalCharge ||
    protonation.targetPh !== manifest.environment.targetPh ||
    protonation.temperatureKelvin !== manifest.environment.targetTemperatureKelvin
  ) {
    throw new ScientificIntegrityError(
      "Receptor protonation decision does not match the material receptor component",
      { manifestId: manifest.id, receptorId: receptor.id, decisionId: protonation.id },
    );
  }

  if (manifest.membrane === null) {
    if (
      manifest.membraneModelDecisionId !== undefined ||
      decisions.some((decision) => decision.kind === "membrane_model")
    ) {
      throw new ScientificIntegrityError("A soluble system cannot bind a membrane-model decision", {
        manifestId: manifest.id,
      });
    }
  } else {
    const membrane = requireKind(
      manifest.membraneModelDecisionId,
      "membrane_model",
      "membrane-model",
    );
    if (
      membrane.receptorComponentId !== receptor.id ||
      membrane.receptorCoordinateDigest !== receptor.coordinateDigest ||
      membrane.membraneDigest !== digestCanonical(manifest.membrane) ||
      membrane.orientationDigest !== manifest.membrane.orientationDigest ||
      membrane.orientationEvidenceRef !== manifest.membrane.orientationEvidenceRef
    ) {
      throw new ScientificIntegrityError(
        "Membrane-model decision does not match the material membrane and receptor",
        { manifestId: manifest.id, decisionId: membrane.id },
      );
    }
  }

  for (const ligand of manifest.components.ligands) {
    const microstate = requireKind(ligand.microstateDecisionId, "microstate", "ligand microstate");
    const pose = requireKind(ligand.poseDecisionId, "pose", "ligand pose");
    const selectedMicrostate = microstate.alternatives.find(
      (alternative) => alternative.id === microstate.selectedAlternativeId,
    );
    if (
      microstate.subjectKind !== "ligand" ||
      microstate.subjectComponentId !== ligand.id ||
      microstate.selectedFormalCharge !== ligand.formalCharge ||
      !selectedMicrostate ||
      selectedMicrostate.structureDigest !== ligand.coordinateDigest ||
      microstate.targetPh !== manifest.environment.targetPh ||
      microstate.temperatureKelvin !== manifest.environment.targetTemperatureKelvin
    ) {
      throw new ScientificIntegrityError(
        "Ligand microstate decision does not match the material ligand component",
        { manifestId: manifest.id, ligandId: ligand.id, decisionId: microstate.id },
      );
    }
    const selectedPose = pose.candidates.find(
      (candidate) => candidate.id === pose.selectedCandidateId,
    );
    if (
      pose.ligandComponentId !== ligand.id ||
      pose.receptorComponentId !== receptor.id ||
      !selectedPose ||
      selectedPose.coordinateDigest !== ligand.coordinateDigest
    ) {
      throw new ScientificIntegrityError(
        "Ligand pose decision does not match the material receptor-ligand coordinates",
        { manifestId: manifest.id, ligandId: ligand.id, decisionId: pose.id },
      );
    }
  }
}

export function parseMdAssessment(input: unknown): MdAssessment {
  for (const schema of [
    MdStageAssessmentSchema,
    ReplicaConvergenceAssessmentSchema,
    MdScientificAssessmentSchema,
  ] as const) {
    const parsed = schema.safeParse(input);
    if (parsed.success) {
      const assessment = parsed.data as MdAssessment;
      assertSelfDigest(
        "MD assessment",
        assessment,
        "assessmentDigest",
        assessment.assessmentDigest,
      );
      return assessment;
    }
  }
  throw new ScientificIntegrityError("MD assessment failed authoritative schema validation");
}

export const mdEvidenceKindByArtifactRole: Readonly<Record<string, string>> = {
  topology: "topology",
  coordinates: "coordinates",
  parent_restart: "restart",
  restart: "restart",
  trajectory: "trajectory",
  mdout: "mdout",
  mdinfo: "mdinfo",
  energy_series: "normalized_metrics",
  normalized_metrics: "normalized_metrics",
  analysis_plan: "analysis_result",
  analysis_result: "analysis_result",
  atom_map: "atom_map",
};

export function sortedCanonical(values: readonly unknown[]): string[] {
  return values.map((value) => canonicalJson(value)).sort();
}

export function assertCanonicalSetEqual(
  subject: string,
  observed: readonly unknown[],
  expected: readonly unknown[],
): void {
  if (canonicalJson(sortedCanonical(observed)) !== canonicalJson(sortedCanonical(expected))) {
    throw new ScientificIntegrityError(`${subject} differs from its authoritative projection`);
  }
}
