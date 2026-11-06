import {
  ApprovalRequestSchema,
  ApprovalResponseSchema,
  AtomMapPublicationRequestSchema,
  AtomMapPublicationRequestSchemaVersion,
  BiomolecularMaterialPublicationBindingSchema,
  BiomolecularSystemBuildRequestSchema,
  BiomolecularSystemBuildRequestSchemaVersion,
  BiomolecularSystemBuildWorkUnitParametersSchema,
  ForceFieldStackPublicationRequestSchema,
  ForceFieldStackPublicationRequestSchemaVersion,
  ScientificPlanSchema,
  canonicalJson,
  digestCanonical,
  type ExternalOperation,
  type WorkUnit,
} from "@eigengrid/scientific-schema";
import { ScientificIntegrityError } from "../errors";

export const EFFECT_COMPATIBLE_MISSION_STATES = new Set([
  "ready",
  "executing",
  "observing",
  "diagnosing",
  "validating",
]);

export function computeExactPlanDigest(
  plan: ReturnType<typeof ScientificPlanSchema.parse>,
): string {
  const {
    planDigest: _planDigest,
    status: _status,
    updatedAt: _updatedAt,
    ...immutablePlan
  } = plan;
  return digestCanonical(immutablePlan);
}

export function assertTypedSystemPreparationIntent(
  operation: ExternalOperation,
  workUnit: WorkUnit,
): void {
  if (operation.kind !== "system_preparation") return;
  if (workUnit.protocolFragment.kind !== "scientific_capability") {
    throw new ScientificIntegrityError(
      "System-preparation effects require a typed scientific-capability WorkUnit",
    );
  }
  const capabilityId = workUnit.protocolFragment.capability.id;
  if (capabilityId === "biomolecular.build-system") {
    const request = BiomolecularSystemBuildRequestSchema.parse(operation.request);
    const parameters = BiomolecularSystemBuildWorkUnitParametersSchema.parse(
      workUnit.protocolFragment.parameters,
    );
    const binding = parameters.systemBuild;
    const sourceIds = request.sourceEvidence.map((item) => item.id).sort();
    const bindingSourceIds = [...binding.sourceEvidenceRefs].sort();
    const inputIds = [...binding.sourceEvidenceRefs, binding.forceFieldStackEvidenceRef].sort();
    if (
      request.schemaVersion !== BiomolecularSystemBuildRequestSchemaVersion ||
      request.missionId !== operation.missionId ||
      request.planId !== workUnit.planId ||
      request.planVersion !== workUnit.planVersion ||
      request.workUnitId !== workUnit.id ||
      request.inputEvidenceId !== binding.primaryInputEvidenceId ||
      canonicalJson([...workUnit.inputRefs].sort()) !== canonicalJson(inputIds) ||
      canonicalJson(request.capability) !== canonicalJson(workUnit.protocolFragment.capability) ||
      request.parametersDigest !== digestCanonical(workUnit.protocolFragment.parameters) ||
      request.outputContractDigest !== digestCanonical(workUnit.outputContract) ||
      request.systemManifest.id !== parameters.manifestId ||
      request.systemManifest.revision !== parameters.manifestRevision ||
      canonicalJson(sourceIds) !== canonicalJson(bindingSourceIds) ||
      request.sourceEvidence.find((item) => item.id === request.inputEvidenceId)?.contentDigest !==
        request.inputContentDigest ||
      canonicalJson(request.decisionRefs) !== canonicalJson(binding.decisionRefs) ||
      canonicalJson(request.forceFieldStack) !== canonicalJson(binding.forceFieldStack) ||
      canonicalJson(request.outputArtifacts) !== canonicalJson(binding.outputArtifacts) ||
      !["topology", "coordinates", "atom_map"].every((kind) =>
        workUnit.outputContract.requiredEvidenceKinds.includes(kind),
      ) ||
      !["artifact_integrity", "topology_integrity"].every((kind) =>
        workUnit.outputContract.requiredObservationKinds.includes(kind),
      )
    ) {
      throw new ScientificIntegrityError(
        "System-build effect does not match its exact typed WorkUnit and manifest target",
        { operationId: operation.id, workUnitId: workUnit.id },
      );
    }
    return;
  }
  if (
    capabilityId === "amber.force-field-stack" ||
    capabilityId === "biomolecular.force-field-compatibility"
  ) {
    const request = ForceFieldStackPublicationRequestSchema.parse(operation.request);
    const binding = BiomolecularMaterialPublicationBindingSchema.parse(
      workUnit.protocolFragment.parameters,
    );
    const requestEvidenceIds = request.sourceEvidence.map((evidence) => evidence.id).sort();
    const bindingEvidenceIds = [...binding.sourceEvidenceRefs].sort();
    if (
      request.schemaVersion !== ForceFieldStackPublicationRequestSchemaVersion ||
      request.missionId !== operation.missionId ||
      request.planId !== workUnit.planId ||
      request.planVersion !== workUnit.planVersion ||
      request.workUnitId !== workUnit.id ||
      !workUnit.inputRefs.includes(request.inputEvidenceId) ||
      request.capability.id !== capabilityId ||
      request.parametersDigest !== digestCanonical(binding) ||
      request.outputContractDigest !== digestCanonical(workUnit.outputContract) ||
      binding.subjectKind !== "force_field_stack" ||
      canonicalJson(request.stack) !== canonicalJson(binding.subject) ||
      request.outputArtifact.evidenceRef !== binding.artifactEvidenceRef ||
      canonicalJson(requestEvidenceIds) !== canonicalJson(bindingEvidenceIds)
    ) {
      throw new ScientificIntegrityError(
        "Force-field stack effect does not match its exact typed WorkUnit and material binding",
        { operationId: operation.id, workUnitId: workUnit.id },
      );
    }
    return;
  }
  if (
    capabilityId === "amber.topology-coordinate-validation" ||
    capabilityId === "biomolecular.system-provenance"
  ) {
    const request = AtomMapPublicationRequestSchema.parse(operation.request);
    const binding = BiomolecularMaterialPublicationBindingSchema.parse(
      workUnit.protocolFragment.parameters,
    );
    if (
      request.schemaVersion !== AtomMapPublicationRequestSchemaVersion ||
      request.missionId !== operation.missionId ||
      request.planId !== workUnit.planId ||
      request.planVersion !== workUnit.planVersion ||
      request.workUnitId !== workUnit.id ||
      !workUnit.inputRefs.includes(request.inputEvidenceId) ||
      request.capability.id !== capabilityId ||
      request.parametersDigest !== digestCanonical(binding) ||
      request.outputContractDigest !== digestCanonical(workUnit.outputContract) ||
      binding.subjectKind !== "atom_map" ||
      canonicalJson(request.atomMap) !== canonicalJson(binding.subject) ||
      canonicalJson(request.systemManifest) !== canonicalJson(binding.systemManifest) ||
      request.sourceArtifact.evidenceRef !== binding.artifactEvidenceRef
    ) {
      throw new ScientificIntegrityError(
        "AtomMap effect does not match its exact typed WorkUnit and publication binding",
        { operationId: operation.id, workUnitId: workUnit.id },
      );
    }
    return;
  }
  throw new ScientificIntegrityError(
    "System-preparation capability has no registered typed effect contract",
    { operationId: operation.id, workUnitId: workUnit.id, capabilityId },
  );
}

/** Plan approval does not authorize a later material build by itself. Every
 * system-preparation effect needs a prior human decision on its exact request. */
export function assertApprovedSystemPreparationOperation(input: {
  operation: ExternalOperation;
  approvalValue: unknown;
  responseValue: unknown;
  currentPolicyDigest: string;
  requiredRole: string;
  at: string;
}): void {
  const { operation } = input;
  const approval = ApprovalRequestSchema.parse(input.approvalValue);
  const response = ApprovalResponseSchema.parse(input.responseValue);
  const at = Date.parse(input.at);
  if (
    operation.kind !== "system_preparation" ||
    operation.state !== "intent" ||
    operation.revision !== 1 ||
    operation.requestDigest !== digestCanonical(operation.request) ||
    operation.policyDigest !== input.currentPolicyDigest ||
    approval.missionId !== operation.missionId ||
    approval.subjectType !== "operation" ||
    approval.subjectId !== operation.id ||
    approval.subjectVersion !== 1 ||
    approval.subjectRevision !== 1 ||
    approval.state !== "approved" ||
    approval.requestedFromRole !== input.requiredRole ||
    approval.payloadDigest !== operation.requestDigest ||
    approval.policyDigest !== input.currentPolicyDigest ||
    !approval.response ||
    response.approvalRequestId !== approval.id ||
    response.decision !== "approved" ||
    response.actor.kind !== "human" ||
    response.actor.role !== input.requiredRole ||
    response.role !== input.requiredRole ||
    response.subjectVersion !== 1 ||
    response.subjectRevision !== 1 ||
    response.payloadDigest !== operation.requestDigest ||
    response.policyDigest !== input.currentPolicyDigest ||
    canonicalJson(response) !== canonicalJson(approval.response) ||
    !Number.isFinite(at) ||
    Date.parse(approval.requestedAt) > at ||
    Date.parse(response.decidedAt) < Date.parse(approval.requestedAt) ||
    Date.parse(response.decidedAt) > at ||
    (approval.expiresAt !== undefined && Date.parse(approval.expiresAt) <= at)
  ) {
    throw new ScientificIntegrityError(
      "System-preparation effect requires a prior exact human approval of its immutable operation request",
      { operationId: operation.id },
    );
  }
}

export function exactPlanApprovalRole(plan: ReturnType<typeof ScientificPlanSchema.parse>): string {
  if (plan.requiredApprovals.length !== 1) {
    throw new ScientificIntegrityError("Executable plans require exactly one approval role", {
      planId: plan.id,
      requiredApprovals: plan.requiredApprovals,
    });
  }
  return plan.requiredApprovals[0]!;
}
