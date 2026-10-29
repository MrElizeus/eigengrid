import type { MdToolPayload } from "./contracts";

export interface MdToolSubject {
  readonly id: string;
  readonly revision: number;
  readonly digest: string;
}

export type MdToolSubjectBindings = (payload: MdToolPayload) => readonly MdToolSubject[];

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("MD subject binding requires an object payload");
  }
  return value as Record<string, unknown>;
}

function subject(
  value: Record<string, unknown>,
  id: string,
  revision: string,
  digest: string,
): MdToolSubject {
  return {
    id: String(value[id]),
    revision: Number(value[revision]),
    digest: String(value[digest]),
  };
}

function reference(value: unknown): MdToolSubject {
  const decoded = record(value);
  return {
    id: String(decoded.id),
    revision: Number(decoded.revision),
    digest: String(decoded.contentDigest),
  };
}

function references(value: Record<string, unknown>, field: string): readonly MdToolSubject[] {
  const decoded = value[field];
  if (!Array.isArray(decoded)) {
    throw new TypeError(`MD subject reference field ${field} is not an array`);
  }
  return decoded.map(reference);
}

function decisionReference(value: unknown): readonly MdToolSubject[] {
  const decoded = record(value);
  return [
    reference(decoded),
    {
      id: String(decoded.approvalRequestId),
      revision: Number(decoded.approvalRequestRevision),
      digest: String(decoded.approvalRequestDigest),
    },
  ];
}

function decisionReferences(value: Record<string, unknown>): readonly MdToolSubject[] {
  const decoded = value.decisionRefs;
  if (!Array.isArray(decoded)) throw new TypeError("MD decisionRefs is not an array");
  return decoded.flatMap(decisionReference);
}

function protocol(value: Record<string, unknown>): MdToolSubject {
  return subject(value, "protocolId", "protocolRevision", "protocolDigest");
}

function stage(value: Record<string, unknown>): MdToolSubject {
  return subject(value, "stageId", "stageRevision", "stageDigest");
}

function workUnit(value: Record<string, unknown>): MdToolSubject {
  return subject(value, "workUnitId", "workUnitRevision", "workUnitDigest");
}

function operation(value: Record<string, unknown>): MdToolSubject {
  return subject(value, "operationId", "expectedOperationRevision", "operationDigest");
}

/** Tools whose payload has no scientific subject authority. */
export const noSubjectBindings: MdToolSubjectBindings = () => [];

/** A descriptor for a payload bound to one exact subject revision. */
export const singleSubjectBindings: MdToolSubjectBindings = (payload) => {
  const value = record(payload);
  return [subject(value, "subjectId", "subjectRevision", "subjectDigest")];
};

/** Planning tools bind their plan and system manifest, plus an optional protocol. */
export const planningBindings: MdToolSubjectBindings = (payload) => {
  const value = record(payload);
  const subjects = [
    subject(value, "planId", "planRevision", "planDigest"),
    subject(value, "systemManifestId", "systemManifestRevision", "systemManifestDigest"),
  ];
  if (value.protocolId !== undefined) subjects.push(protocol(value));
  return subjects;
};

export const protocolDiffBindings: MdToolSubjectBindings = (payload) => {
  const value = record(payload);
  return [
    subject(value, "rightProtocolId", "rightProtocolRevision", "rightProtocolDigest"),
    subject(value, "leftProtocolId", "leftProtocolRevision", "leftProtocolDigest"),
  ];
};

export const evidenceBindings: MdToolSubjectBindings = (payload) => {
  const value = record(payload);
  return [subject(value, "evidenceId", "evidenceRevision", "expectedContentDigest")];
};

export const systemManifestBindings: MdToolSubjectBindings = (payload) => {
  const value = record(payload);
  return [
    subject(value, "systemManifestId", "systemManifestRevision", "systemManifestDigest"),
    subject(value, "forceFieldStackId", "forceFieldStackRevision", "forceFieldStackDigest"),
    subject(value, "parameterManifestId", "parameterManifestRevision", "parameterManifestDigest"),
    ...decisionReferences(value),
  ];
};

export const decisionApprovalBindings: MdToolSubjectBindings = (payload) => {
  const value = record(payload);
  return [
    subject(value, "decisionId", "decisionRevision", "decisionDigest"),
    subject(value, "approvalRequestId", "expectedApprovalRevision", "approvalRequestDigest"),
  ];
};

/** Component and system preparation share the manifest/decision contract. */
export const componentPreparationBindings: MdToolSubjectBindings = (payload) => {
  const value = record(payload);
  const subjects = [
    subject(value, "systemManifestId", "systemManifestRevision", "systemManifestDigest"),
    subject(value, "parameterManifestId", "parameterManifestRevision", "parameterManifestDigest"),
    ...decisionReferences(value),
  ];
  if (value.componentId !== undefined) {
    subjects.splice(1, 0, subject(value, "componentId", "componentRevision", "componentDigest"));
  }
  if (value.pocketDefinitionRef !== undefined) {
    subjects.push(reference(value.pocketDefinitionRef));
    subjects.push(reference(value.poseStrategyRef));
  }
  if (value.poseCandidateSetRef !== undefined) {
    subjects.push(reference(value.poseCandidateSetRef));
    subjects.push(reference(value.selectedPoseCandidateRef));
    subjects.push(...decisionReference(value.poseDecisionRef));
  }
  return subjects;
};

export const systemPreparationBindings: MdToolSubjectBindings = (payload) => {
  const value = record(payload);
  return [
    subject(value, "systemManifestId", "systemManifestRevision", "systemManifestDigest"),
    subject(value, "parameterManifestId", "parameterManifestRevision", "parameterManifestDigest"),
    ...decisionReferences(value),
  ];
};

export const stageResultBindings: MdToolSubjectBindings = (payload) => {
  const value = record(payload);
  return [subject(value, "stageResultId", "stageResultRevision", "stageResultDigest")];
};

export const replicaSetBindings: MdToolSubjectBindings = (payload) => {
  const value = record(payload);
  return [
    subject(value, "replicaSetId", "replicaSetRevision", "replicaSetDigest"),
    protocol(value),
    subject(value, "systemManifestId", "systemManifestRevision", "systemManifestDigest"),
    ...decisionReference(value.decisionRef),
  ];
};

export const productionExtensionBindings: MdToolSubjectBindings = (payload) => {
  const value = record(payload);
  return [
    subject(value, "replicaSetId", "replicaSetRevision", "replicaSetDigest"),
    subject(
      value,
      "convergenceAssessmentId",
      "convergenceAssessmentRevision",
      "convergenceAssessmentDigest",
    ),
    subject(value, "extensionDecisionId", "extensionDecisionRevision", "extensionDecisionDigest"),
    subject(value, "approvalRequestId", "approvalRequestRevision", "approvalRequestDigest"),
  ];
};

export const stageExecutionBindings: MdToolSubjectBindings = (payload) => {
  const value = record(payload);
  return [stage(value), protocol(value), workUnit(value)];
};

export const stageStatusBindings: MdToolSubjectBindings = (payload) => {
  const value = record(payload);
  const subjects = [stage(value), protocol(value), workUnit(value), operation(value)];
  if (value.replicaSegment !== null && value.replicaSegment !== undefined) {
    const segment = record(value.replicaSegment);
    subjects.push(
      subject(segment, "replicaSetId", "replicaSetRevision", "replicaSetDigest"),
      subject(segment, "segmentId", "segmentRevision", "segmentDigest"),
    );
  }
  return subjects;
};

export const stageOperationBindings: MdToolSubjectBindings = (payload) => {
  const value = record(payload);
  return [stage(value), protocol(value), workUnit(value), operation(value)];
};

export const replicaAnalysisBindings: MdToolSubjectBindings = (payload) => {
  const value = record(payload);
  return [
    subject(value, "replicaSetId", "replicaSetRevision", "replicaSetDigest"),
    subject(value, "analysisPlanId", "analysisPlanRevision", "analysisPlanDigest"),
  ];
};

export const remediationBindings: MdToolSubjectBindings = (payload) => {
  const value = record(payload);
  return [subject(value, "diagnosisId", "diagnosisRevision", "diagnosisDigest"), stage(value)];
};

export const assessmentBindings: MdToolSubjectBindings = (payload) => {
  const value = record(payload);
  return [
    subject(value, "systemManifestId", "systemManifestRevision", "systemManifestDigest"),
    protocol(value),
  ];
};

export const trajectoryAnalysisBindings: MdToolSubjectBindings = (payload) => {
  const value = record(payload);
  return [
    subject(value, "analysisPlanId", "analysisPlanRevision", "analysisPlanDigest"),
    subject(value, "systemManifestId", "systemManifestRevision", "systemManifestDigest"),
    subject(value, "replicaSetId", "replicaSetRevision", "replicaSetDigest"),
    ...references(value, "stageResultRefs"),
    ...references(value, "trajectorySegmentRefs"),
  ];
};

export const comparisonBindings: MdToolSubjectBindings = (payload) => {
  const value = record(payload);
  return [
    subject(value, "leftSubjectId", "leftRevision", "leftDigest"),
    subject(value, "rightSubjectId", "rightRevision", "rightDigest"),
  ];
};

/** Provenance and simple read/verification descriptors bind one exact subject. */
export const provenanceBindings: MdToolSubjectBindings = singleSubjectBindings;
