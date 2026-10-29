import { type ColonyCompatibilityManifest, type CompatibilityRequirement } from "./compatibility";
import {
  type AgentWorkOrder,
  type AgentWorkResult,
  type ContextPack,
  type CorrectionOrder,
  type VerificationRequest,
  type VerificationResult,
} from "./contracts";
import { sealContract } from "./digest";
import { packageCompatibilityManifest } from "./json-schema-artifacts";
import {
  CONTRACT_SCHEMA_IDS,
  type Budget,
  type ContextReference,
  type Criterion,
  type Digest,
  type SchemaReference,
} from "./primitives";
import { CONTRACT_VERSIONS, type ColonyContract } from "./registry";
import type { SpeciesContract, SpeciesIdentity } from "./species";

export const ZERO_DIGEST = `sha256:${"0".repeat(64)}` as Digest;
export const A_DIGEST = `sha256:${"a".repeat(64)}` as Digest;
export const B_DIGEST = `sha256:${"b".repeat(64)}` as Digest;

export const budget: Budget = {
  wallTimeMs: 60_000,
  inputTokens: 4_000,
  outputTokens: 2_000,
  costMicrounits: 250_000,
  effects: 0,
  corrections: 2,
  modelCalls: 2,
  computeSeconds: 0,
  storageBytes: 65_536,
  networkBytes: 0,
  deadline: "2026-09-01T00:00:00.000Z",
};

export const criteria: Criterion[] = [
  {
    id: "criterion-contract",
    statement: "The candidate conforms to its declared output contract",
    verification: "Validate the exact candidate bytes against the schema",
    scientificallyMaterial: false,
  },
  {
    id: "criterion-scope",
    statement: "The candidate remains inside the granted scope",
    verification: "Compare every affected resource with the work-order grant",
    scientificallyMaterial: true,
  },
];

export function schemaReference(id = "eigengrid.agent-work-result.v1"): SchemaReference {
  return { id, version: "1.0.0", digest: A_DIGEST };
}

export function reference(
  id: string,
  trustClass: ContextReference["trustClass"],
): ContextReference {
  return {
    id,
    kind: "evidence.fixture",
    digest: A_DIGEST,
    trustClass,
    uri: `fixture://${id}`,
    claim: `Bounded fixture ${id}`,
    accessedAt: "2026-08-30T00:00:00.000Z",
  };
}

export function validSpeciesContract(): SpeciesContract {
  return sealContract({
    schema: "eigengrid.species-contract.v1",
    identity: { id: "eigengrid.scientific-plan/v1", version: "1.0.0" },
    genus: "scientific-planning",
    displayName: "Scientific plan",
    aliases: ["Plan colony"],
    objectiveSchema: schemaReference("eigengrid.scientific-objective.v1"),
    castes: [
      {
        id: "builder",
        required: true,
        maxInstances: 1,
        responsibilities: ["Produce one plan candidate"],
        allowedCapabilities: ["candidate.write"],
        prohibitedCapabilities: ["authoritative.write", "execution.invoke"],
        stateReadScopes: ["mission:exact-revision"],
        candidateWriteScopes: ["candidate:plan"],
        allowedModelTiers: ["T2", "T3"],
        providerPolicyIds: ["model-policy.scientific-plan"],
        contextSchema: schemaReference("eigengrid.context-pack.v1"),
        resultSchema: schemaReference("eigengrid.agent-work-result.v1"),
        ownership: ["candidate:plan"],
        verificationDuties: [],
        mayDelegate: false,
        maximumChildDepth: 0,
      },
      {
        id: "verifier",
        required: true,
        maxInstances: 1,
        responsibilities: ["Independently verify the exact candidate"],
        allowedCapabilities: ["evidence.read"],
        prohibitedCapabilities: ["candidate.write", "execution.invoke"],
        stateReadScopes: ["mission:exact-revision", "candidate:plan"],
        candidateWriteScopes: [],
        allowedModelTiers: ["T2", "T3"],
        providerPolicyIds: ["model-policy.scientific-verification"],
        contextSchema: schemaReference("eigengrid.context-pack.v1"),
        resultSchema: schemaReference("eigengrid.verification-result.v1"),
        ownership: ["candidate:verification"],
        verificationDuties: ["Check every acceptance criterion"],
        mayDelegate: false,
        maximumChildDepth: 0,
      },
    ],
    ownershipBoundaries: ["one writer per candidate plan"],
    capabilityAllowlist: ["candidate.write", "evidence.read"],
    authority: {
      stateReadScopes: ["mission:exact-revision", "candidate:plan"],
      candidateWriteScopes: ["candidate:plan", "candidate:verification"],
      explicitlyProhibited: [
        "authoritative mission mutation",
        "approval",
        "runner or scheduler invocation",
      ],
    },
    contextPolicy: {
      maximumBytes: 262_144,
      allowedTrustClasses: [
        "authoritative_state",
        "validated_skill",
        "external_evidence",
        "model_hypothesis",
        "untrusted_retrieved_text",
      ],
      sensitiveExclusionsRequired: true,
    },
    memoryPolicy: {
      readableScopes: ["memory.project"],
      candidateWriteAllowed: true,
      directPromotionAllowed: false,
    },
    skillPolicy: {
      requiredSkillIds: ["skill.scientific-planning"],
      candidateWriteAllowed: false,
      directPromotionAllowed: false,
    },
    evidencePolicy: {
      requiredKinds: ["evidence.mission", "evidence.skill"],
      contentDigestsRequired: true,
      independentEvidenceRequired: true,
    },
    budgetPolicy: budget,
    approvalPolicy: {
      maximumAutonomy: "A1",
      approvalRequiredAtOrAboveRisk: "R2",
      exactSubjectBindingRequired: true,
    },
    riskCeiling: "R2",
    verificationTopology: {
      independent: true,
      requiredVerifierCastes: ["verifier"],
      deterministicChecks: ["schema.validate", "digest.verify", "scope.verify"],
      requiredEvidenceKinds: ["evidence.mission"],
      acceptedVerdicts: ["pass"],
    },
    correctionTopology: {
      maximumCorrections: 2,
      measurableProgressRequired: true,
      preservedSuccessRequired: true,
      independentReverificationRequired: true,
    },
    frontierEscalation: {
      maximumCalls: 1,
      triggers: ["critic_disagreement", "repeated_non_progress"],
      effectCapabilities: [],
    },
    terminationConditions: ["Every required candidate is terminal and verified"],
    failureSemantics: ["Unknown or incompatible state blocks without fallback"],
    supportedAutonomyLevels: ["A0", "A1"],
    compatibility: [
      {
        kind: "protocol",
        id: "eigengrid.colony",
        range: { minimumInclusive: "1.0.0", maximumExclusive: "2.0.0" },
        requiredFeatureFlags: ["strict-unknown-fields"],
      },
    ],
    evaluationSuiteIds: ["eval.scientific-plan.v1"],
    promotionStatus: "unqualified",
    contractDigest: ZERO_DIGEST,
  }) as SpeciesContract;
}

export function validSpeciesIdentity(): SpeciesIdentity {
  const contract = validSpeciesContract();
  return {
    schema: "eigengrid.species-identity.v1",
    coordinate: contract.identity,
    contractDigest: contract.contractDigest,
  };
}

export function validContextPack(): ContextPack {
  return sealContract({
    schema: "eigengrid.context-pack.v1",
    requestId: "request-context-1",
    correlationId: "correlation-1",
    objective: "Produce one bounded candidate plan",
    species: validSpeciesIdentity(),
    caste: "builder",
    baseIdentity: {
      kind: "mission",
      id: "mission-1",
      revision: 7,
      digest: B_DIGEST,
    },
    authoritativeFacts: [reference("mission-state", "authoritative_state")],
    selectedSkillFragments: [reference("planning-skill", "validated_skill")],
    externalEvidence: [reference("reviewed-paper", "external_evidence")],
    modelHypotheses: [reference("prior-hypothesis", "model_hypothesis")],
    untrustedRetrievedText: [reference("retrieved-text", "untrusted_retrieved_text")],
    allowedEvidenceIds: ["mission-state", "planning-skill", "reviewed-paper"],
    knownContradictions: [
      {
        id: "contradiction-1",
        statement: "Two sources disagree about the selected method",
        evidenceIds: ["reviewed-paper", "mission-state"],
      },
    ],
    constraints: ["Do not mutate authoritative mission state"],
    budgets: budget,
    allowedCapabilities: ["candidate.write", "evidence.read"],
    prohibitedCapabilities: ["execution.invoke", "authoritative.write"],
    expectedOutputSchema: schemaReference(),
    acceptanceCriteria: criteria,
    sensitivePathExclusions: [".env", "secrets/**"],
    contextDigest: ZERO_DIGEST,
  }) as ContextPack;
}

export function validWorkOrder(): AgentWorkOrder {
  const context = validContextPack();
  return sealContract({
    schema: "eigengrid.agent-work-order.v1",
    workOrderId: "work-order-1",
    requestId: "request-work-1",
    idempotencyKey: "work-order-1-attempt-1",
    correlationId: context.correlationId,
    causationId: context.requestId,
    contextPackDigest: context.contextDigest,
    objective: context.objective,
    nonGoals: ["Do not execute the plan", "Do not approve the plan"],
    species: context.species,
    caste: context.caste,
    modelTierConstraints: {
      allowedTiers: ["T2", "T3"],
      providerPolicyIds: ["model-policy.scientific-plan"],
    },
    baseIdentity: context.baseIdentity,
    allowedResources: [
      { kind: "mission_object", selector: "candidate:plan", access: "candidate_write" },
      { kind: "evidence", selector: "evidence:*", access: "read" },
    ],
    forbiddenResources: [
      { kind: "operation", selector: "backend:*", access: "invoke" },
      { kind: "mission_object", selector: "authoritative:*", access: "candidate_write" },
    ],
    protectedState: [reference("protected-plan", "authoritative_state")],
    inputReferences: [reference("mission-state", "authoritative_state")],
    outputContract: schemaReference(),
    acceptanceCriteria: criteria,
    verificationRequirements: {
      independent: true,
      requiredVerifierCastes: ["verifier"],
      deterministicChecks: ["schema.validate", "digest.verify"],
      requiredEvidenceKinds: ["evidence.mission"],
      acceptedVerdicts: ["pass"],
    },
    budget,
    approvalPrerequisites: [],
    cancellation: { token: "cancel-work-order-1", deadline: "2026-09-01T00:00:00.000Z" },
    escalationConditions: [
      {
        id: "escalate-no-progress",
        trigger: "No measurable correction progress",
        destination: "owner",
      },
    ],
    workOrderDigest: ZERO_DIGEST,
  }) as AgentWorkOrder;
}

export function validWorkResult(): AgentWorkResult {
  const order = validWorkOrder();
  return sealContract({
    schema: "eigengrid.agent-work-result.v1",
    workOrderId: order.workOrderId,
    requestId: order.requestId,
    idempotencyKey: order.idempotencyKey,
    correlationId: order.correlationId,
    causationId: order.workOrderId,
    species: order.species,
    caste: order.caste,
    status: "success",
    observedBaseIdentity: order.baseIdentity,
    summary: "Produced one bounded candidate with cited evidence",
    candidates: [reference("candidate-plan", "model_hypothesis")],
    affectedResources: [
      { kind: "mission_object", selector: "candidate:plan", access: "candidate_write" },
    ],
    attemptedOperations: [],
    toolReceipts: [reference("read-receipt", "external_evidence")],
    evidence: [reference("candidate-evidence", "external_evidence")],
    criteria: criteria.map((criterion) => ({
      criterionId: criterion.id,
      verdict: "pass" as const,
      evidenceIds: ["candidate-evidence"],
      explanation: "Deterministic fixture check passed",
    })),
    deviations: [],
    blockers: [],
    unrelatedChanges: [],
    selfReview: { summary: "Checked contract and scope", checks: ["schema", "scope"] },
    modelIdentity: {
      provider: "provider.fixture",
      model: "fixture-model",
      revision: "fixture-model-v1",
      qualificationId: "qualification-1",
      invocationId: "writer-invocation-1",
    },
    usage: {
      wallTimeMs: 1_000,
      inputTokens: 500,
      outputTokens: 200,
      costMicrounits: 100,
      effects: 0,
      corrections: 0,
      modelCalls: 1,
      computeSeconds: 0,
      storageBytes: 1_024,
      networkBytes: 0,
    },
    confidence: 0.8,
    limitations: ["Fixture evidence only"],
    memoryCandidates: [],
    skillCandidates: [],
    resultDigest: ZERO_DIGEST,
  }) as AgentWorkResult;
}

export function validVerificationRequest(): VerificationRequest {
  const order = validWorkOrder();
  const result = validWorkResult();
  return sealContract({
    schema: "eigengrid.verification-request.v1",
    verificationId: "verification-1",
    requestId: "request-verification-1",
    correlationId: order.correlationId,
    causationId: result.requestId,
    workOrderId: order.workOrderId,
    workResultDigest: result.resultDigest,
    candidate: result.candidates[0]!,
    expectedBaseIdentity: order.baseIdentity,
    species: order.species,
    verifierCaste: "verifier",
    acceptanceCriteria: criteria,
    protectedState: order.protectedState,
    requiredEvidenceIds: ["candidate-evidence"],
    writerInvocationId: result.modelIdentity.invocationId,
    independence: {
      differentInvocationRequired: true,
      writerPrivateReasoningExcluded: true,
      candidateWriteProhibited: true,
    },
    allowedCapabilities: ["evidence.read"],
    prohibitedCapabilities: ["candidate.write", "execution.invoke"],
    budget: { ...budget, effects: 0, corrections: 0 },
    requestDigest: ZERO_DIGEST,
  }) as VerificationRequest;
}

const passingCheck = {
  verdict: "pass" as const,
  summary: "Deterministic fixture check passed",
  evidenceIds: ["verification-evidence"],
};

export function validVerificationResult(): VerificationResult {
  const request = validVerificationRequest();
  return sealContract({
    schema: "eigengrid.verification-result.v1",
    verificationId: request.verificationId,
    requestId: request.requestId,
    correlationId: request.correlationId,
    causationId: request.verificationId,
    workOrderId: request.workOrderId,
    workResultDigest: request.workResultDigest,
    candidateDigest: request.candidate.digest,
    observedBaseIdentity: request.expectedBaseIdentity,
    verifierInvocationId: "verifier-invocation-1",
    verifierIdentity: {
      provider: "provider.fixture",
      model: "fixture-verifier",
      revision: "fixture-verifier-v1",
      qualificationId: "qualification-verifier-1",
      invocationId: "verifier-invocation-1",
    },
    verdict: "pass",
    identityAndScope: passingCheck,
    contractConformance: passingCheck,
    protectedState: passingCheck,
    deterministicEvidence: passingCheck,
    scientificAssumptions: passingCheck,
    authorityBoundaries: passingCheck,
    provenanceCompleteness: passingCheck,
    budgetCompliance: passingCheck,
    introducedFailures: [],
    preExistingFailures: [],
    criteria: criteria.map((criterion) => ({
      criterionId: criterion.id,
      verdict: "pass" as const,
      evidenceIds: ["verification-evidence"],
      explanation: "Independent fixture verification passed",
    })),
    evidence: [reference("verification-evidence", "external_evidence")],
    residualRisks: ["Fixture evidence is not scientific qualification"],
    usage: {
      wallTimeMs: 500,
      inputTokens: 200,
      outputTokens: 100,
      costMicrounits: 50,
      effects: 0,
      corrections: 0,
      modelCalls: 1,
      computeSeconds: 0,
      storageBytes: 512,
      networkBytes: 0,
    },
    resultDigest: ZERO_DIGEST,
  }) as VerificationResult;
}

export function validFailedVerificationResult(): VerificationResult {
  const passing = validVerificationResult();
  return sealContract({
    ...passing,
    verdict: "fail",
    identityAndScope: {
      ...passing.identityAndScope,
      verdict: "fail",
      summary: "The candidate escaped one declared resource selector",
    },
    criteria: passing.criteria.map((criterion) =>
      criterion.criterionId === criteria[1]!.id
        ? {
            ...criterion,
            verdict: "fail" as const,
            explanation: "The scope criterion failed",
          }
        : criterion,
    ),
    resultDigest: ZERO_DIGEST,
  }) as VerificationResult;
}

export function validCorrectionOrder(): CorrectionOrder {
  const order = validWorkOrder();
  const result = validWorkResult();
  const verification = validFailedVerificationResult();
  return sealContract({
    schema: "eigengrid.correction-order.v1",
    correctionId: "correction-1",
    requestId: "request-correction-1",
    idempotencyKey: "correction-1-attempt-1",
    correlationId: order.correlationId,
    causationId: verification.verificationId,
    originalWorkOrderId: order.workOrderId,
    attempt: 1,
    species: order.species,
    caste: "builder",
    previousCandidateDigest: result.candidates[0]!.digest,
    previousWorkResultDigest: result.resultDigest,
    verificationResultDigest: verification.resultDigest,
    failedCriteria: [
      {
        criterionId: criteria[1]!.id,
        defect: "Candidate escaped one declared resource selector",
        evidenceIds: ["defect-evidence"],
      },
    ],
    defectEvidence: [reference("defect-evidence", "external_evidence")],
    permittedScope: [
      { kind: "mission_object", selector: "candidate:plan", access: "candidate_write" },
    ],
    preservedSuccess: [
      {
        criterionId: criteria[0]!.id,
        candidateDigest: result.candidates[0]!.digest,
        evidenceIds: ["candidate-evidence"],
      },
    ],
    remainingBudget: { ...budget, corrections: 1 },
    expectedProgressSignal: {
      description: "The affected-resource set loses the escaped selector",
      priorEvidenceDigest: A_DIGEST,
      requiredDelta: "A new scope check passes while the preserved candidate digest remains cited",
    },
    prohibitedRedesign: ["Do not replace the accepted contract structure"],
    requiredReverification: {
      schema: schemaReference("eigengrid.verification-request.v1"),
      criterionIds: [criteria[1]!.id],
      independent: true,
    },
    escalationCondition: {
      id: "escalate-repeat",
      trigger: "The same scope defect repeats without a candidate digest delta",
      destination: "owner",
    },
    correctionDigest: ZERO_DIGEST,
  }) as CorrectionOrder;
}

export function validCompatibilityManifest(): ColonyCompatibilityManifest {
  return packageCompatibilityManifest();
}

export function compatibilityConsumer(
  overrides: Partial<ColonyCompatibilityManifest> = {},
): ColonyCompatibilityManifest {
  const requirements: CompatibilityRequirement[] = CONTRACT_SCHEMA_IDS.map((schemaId) => ({
    kind: "contract",
    id: schemaId,
    range: { minimumInclusive: CONTRACT_VERSIONS[schemaId], maximumExclusive: "2.0.0" },
    requiredFeatureFlags: ["strict-unknown-fields"],
  }));
  return sealContract({
    ...packageCompatibilityManifest(),
    package: { name: "@eigengrid/compatibility-consumer", version: "1.0.0" },
    provides: [{ kind: "protocol", id: "eigengrid.colony", version: "1.0.0" }],
    requires: requirements,
    ...overrides,
    manifestDigest: ZERO_DIGEST,
  }) as ColonyCompatibilityManifest;
}

export function everyValidContract(): ColonyContract[] {
  return [
    validContextPack(),
    validWorkOrder(),
    validWorkResult(),
    validVerificationRequest(),
    validVerificationResult(),
    validCorrectionOrder(),
    validSpeciesIdentity(),
    validSpeciesContract(),
    validCompatibilityManifest(),
  ];
}
