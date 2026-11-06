import { type MissionProvenance } from "@eigengrid/mission-runtime";
import {
  AtomMapPublicationRequestSchema,
  AtomMapPublicationRequestSchemaVersion,
  BiomolecularSystemBuildRequestSchema,
  BiomolecularSystemBuildRequestSchemaVersion,
  BiomolecularSystemBuildWorkUnitParametersSchema,
  ForceFieldStackPublicationRequestSchema,
  ForceFieldStackPublicationRequestSchemaVersion,
  canonicalJson,
  digestCanonical,
  type ApprovalRequest,
} from "@eigengrid/scientific-schema";
import { systemPreparationEffectIdentity } from "../system-preparation-binding";
import { type MissionCandidate } from "./requests";

/** Operation approvals are reviewable only when their immutable v2 request is
 * bound to this candidate's system manifest, exact WorkUnit and CAS inputs.
 * Historical v1 operation payloads remain importable by the prepared-system
 * reader, but they cannot authorize a new application decision.
 */
export function approvalBelongsToMissionCandidate(
  approval: ApprovalRequest,
  candidate: MissionCandidate,
  provenance: MissionProvenance,
): boolean {
  if (approval.subjectType !== "operation") return false;
  const operation = provenance.operations.find((item) => item.id === approval.subjectId);
  if (
    !operation ||
    operation.kind !== "system_preparation" ||
    operation.missionId !== candidate.plan.missionId ||
    operation.requestDigest !== digestCanonical(operation.request) ||
    candidate.plan.requiredApprovals.length !== 1 ||
    approval.requestedFromRole !== candidate.plan.requiredApprovals[0] ||
    approval.missionId !== operation.missionId ||
    approval.subjectVersion !== 1 ||
    approval.subjectRevision !== 1 ||
    approval.payloadDigest !== operation.requestDigest ||
    approval.policyDigest !== operation.policyDigest
  ) {
    return false;
  }
  const workUnit = provenance.workUnits.find((item) => item.id === operation.workUnitId);
  if (
    !workUnit ||
    workUnit.missionId !== operation.missionId ||
    workUnit.planId !== candidate.plan.id ||
    workUnit.planVersion !== candidate.plan.version ||
    workUnit.protocolFragment.kind !== "scientific_capability" ||
    workUnit.executionPolicy.capability !== workUnit.protocolFragment.capability.id
  ) {
    return false;
  }
  const capability = workUnit.protocolFragment.capability;
  const parametersDigest = digestCanonical(workUnit.protocolFragment.parameters);
  const outputContractDigest = digestCanonical(workUnit.outputContract);
  const hasMissionEvidence = (id: string, contentDigest: string) => {
    const evidence = provenance.evidence.find((item) => item.id === id);
    return (
      evidence?.missionId === operation.missionId &&
      evidence.immutable &&
      evidence.contentDigest === contentDigest
    );
  };
  const hasExactInput = (id: string, contentDigest: string) =>
    workUnit.inputRefs.includes(id) && hasMissionEvidence(id, contentDigest);
  const exactCoordinator = (request: {
    missionId: string;
    planId: string;
    planVersion: number;
    workUnitId: string;
    intendedJobId: string;
    intendedAttemptId: string;
    inputEvidenceId: string;
    inputContentDigest: string;
    capability: { id: string; version: string; contractDigest: string };
    parametersDigest: string;
    outputContractDigest: string;
  }) =>
    request.missionId === operation.missionId &&
    request.planId === candidate.plan.id &&
    request.planVersion === candidate.plan.version &&
    request.workUnitId === workUnit.id &&
    (!workUnit.jobId || request.intendedJobId === workUnit.jobId) &&
    (!workUnit.attemptId || request.intendedAttemptId === workUnit.attemptId) &&
    canonicalJson(request.capability) === canonicalJson(capability) &&
    request.parametersDigest === parametersDigest &&
    request.outputContractDigest === outputContractDigest &&
    hasExactInput(request.inputEvidenceId, request.inputContentDigest);

  const build = BiomolecularSystemBuildRequestSchema.safeParse(operation.request);
  if (build.success) {
    const request = build.data;
    const parameters = BiomolecularSystemBuildWorkUnitParametersSchema.safeParse(
      workUnit.protocolFragment.parameters,
    );
    if (
      request.schemaVersion === BiomolecularSystemBuildRequestSchemaVersion &&
      parameters.success &&
      workUnit.kind === "scientific_capability" &&
      workUnit.protocolFragment.kind === "scientific_capability" &&
      workUnit.protocolFragment.capability.id === "biomolecular.build-system" &&
      workUnit.executionPolicy.capability === "biomolecular.build-system" &&
      workUnit.executionPolicy.riskClass === 3 &&
      workUnit.protocolFragment.riskClass === 3
    ) {
      const binding = parameters.data.systemBuild;
      const sourceEvidence = binding.sourceEvidenceRefs.map((id) => {
        const matches = provenance.evidence.filter((item) => item.id === id);
        if (
          matches.length !== 1 ||
          matches[0]!.missionId !== operation.missionId ||
          !matches[0]!.immutable ||
          !matches[0]!.contentDigest
        ) {
          return null;
        }
        return { id, contentDigest: matches[0]!.contentDigest };
      });
      const stackEvidence = provenance.evidence.filter(
        (item) => item.id === binding.forceFieldStackEvidenceRef,
      );
      let identity: ReturnType<typeof systemPreparationEffectIdentity> | undefined;
      try {
        identity = systemPreparationEffectIdentity(workUnit);
      } catch {
        return false;
      }
      const expectedInputIds = [
        ...binding.sourceEvidenceRefs,
        binding.forceFieldStackEvidenceRef,
      ].sort();
      const expectedDecisionRefs = [...binding.decisionRefs].sort((left, right) =>
        left.id.localeCompare(right.id),
      );
      if (
        sourceEvidence.some((item) => item === null) ||
        stackEvidence.length !== 1 ||
        stackEvidence[0]!.missionId !== operation.missionId ||
        !stackEvidence[0]!.immutable ||
        stackEvidence[0]!.kind !== "force_field_stack" ||
        stackEvidence[0]!.contentDigest !== binding.forceFieldStack.digest ||
        canonicalJson([...workUnit.inputRefs].sort()) !== canonicalJson(expectedInputIds) ||
        canonicalJson(sourceEvidence.sort((left, right) => left!.id.localeCompare(right!.id))) !==
          canonicalJson(request.sourceEvidence) ||
        request.inputEvidenceId !== binding.primaryInputEvidenceId ||
        request.schemaVersion !== BiomolecularSystemBuildRequestSchemaVersion ||
        request.workUnitId !== workUnit.id ||
        request.systemManifest.id !== parameters.data.manifestId ||
        request.systemManifest.revision !== parameters.data.manifestRevision ||
        canonicalJson(request.decisionRefs) !== canonicalJson(expectedDecisionRefs) ||
        canonicalJson(request.forceFieldStack) !== canonicalJson(binding.forceFieldStack) ||
        canonicalJson(request.outputArtifacts) !== canonicalJson(binding.outputArtifacts) ||
        request.intendedJobId !== identity.jobId ||
        request.intendedAttemptId !== identity.attemptId ||
        request.parametersDigest !== parametersDigest ||
        request.outputContractDigest !== outputContractDigest ||
        operation.id !== identity.operationId ||
        operation.idempotencyKey !== identity.idempotencyKey
      ) {
        return false;
      }
      if (!candidate.md) return true;
      return (
        operation.id === candidate.md.system.provenance.operationId &&
        request.systemManifest.id === candidate.md.system.id &&
        request.systemManifest.revision === candidate.md.system.revision &&
        canonicalJson(request.forceFieldStack) ===
          canonicalJson(candidate.md.system.forceFieldStack) &&
        canonicalJson(request.decisionRefs) === canonicalJson(candidate.md.decisionRefs)
      );
    }
    if (!candidate.md) return false;
    return (
      operation.id === candidate.md.system.provenance.operationId &&
      request.schemaVersion === BiomolecularSystemBuildRequestSchemaVersion &&
      request.capability.id === "biomolecular.build-system" &&
      exactCoordinator(request) &&
      request.systemManifest.id === candidate.md.system.id &&
      request.systemManifest.revision === candidate.md.system.revision &&
      canonicalJson(request.forceFieldStack) ===
        canonicalJson(candidate.md.system.forceFieldStack) &&
      canonicalJson(request.decisionRefs) === canonicalJson(candidate.md.decisionRefs) &&
      request.sourceEvidence.every((item) => hasMissionEvidence(item.id, item.contentDigest))
    );
  }

  if (!candidate.md) return false;
  const stack = ForceFieldStackPublicationRequestSchema.safeParse(operation.request);
  if (stack.success) {
    const request = stack.data;
    return (
      request.schemaVersion === ForceFieldStackPublicationRequestSchemaVersion &&
      request.capability.id === "amber.force-field-stack" &&
      exactCoordinator(request) &&
      request.stack.id === candidate.md.system.forceFieldStack.id &&
      request.stack.revision === candidate.md.system.forceFieldStack.revision &&
      request.stack.digest === candidate.md.system.forceFieldStack.digest &&
      request.sourceEvidence.every((item) => hasMissionEvidence(item.id, item.contentDigest))
    );
  }

  const atomMap = AtomMapPublicationRequestSchema.safeParse(operation.request);
  if (!atomMap.success) return false;
  const request = atomMap.data;
  return (
    request.schemaVersion === AtomMapPublicationRequestSchemaVersion &&
    ["amber.topology-coordinate-validation", "biomolecular.system-provenance"].includes(
      request.capability.id,
    ) &&
    exactCoordinator(request) &&
    request.systemManifest.id === candidate.md.system.id &&
    request.systemManifest.revision === candidate.md.system.revision &&
    request.systemManifest.digest === candidate.md.system.manifestDigest &&
    request.atomMap.digest === candidate.md.system.atomMapDigest &&
    request.sourceArtifact.evidenceRef === request.inputEvidenceId &&
    provenance.evidence.some(
      (item) =>
        item.id === request.sourceArtifact.evidenceRef &&
        item.mediaType === request.sourceArtifact.mediaType,
    )
  );
}

export function missionBelongsToCandidate(
  request: ApprovalRequest,
  candidate: MissionCandidate,
  provenance?: MissionProvenance,
): boolean {
  if (request.subjectType === "operation")
    return !!provenance && approvalBelongsToMissionCandidate(request, candidate, provenance);
  if (request.subjectType === "plan")
    return (
      request.subjectId === candidate.plan.id && request.payloadDigest === candidate.plan.planDigest
    );
  if (!candidate.md) return false;
  return (
    (request.subjectType === "md_protocol" &&
      request.subjectId === candidate.md.protocol.id &&
      request.payloadDigest === candidate.md.protocol.protocolDigest) ||
    (request.subjectType === "biomolecular_system_manifest" &&
      request.subjectId === candidate.md.system.id &&
      request.payloadDigest === candidate.md.system.manifestDigest) ||
    (request.subjectType === "decision" &&
      candidate.md.decisionRefs.some(
        (item) => item.id === request.subjectId && item.decisionDigest === request.payloadDigest,
      ))
  );
}
