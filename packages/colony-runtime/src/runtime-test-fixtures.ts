import {
  sealContract,
  type AgentWorkOrder,
  type AgentWorkResult,
  type CorrectionOrder,
  type Digest,
  type SpeciesContract,
  type SpeciesIdentity,
  type VerificationRequest,
  type VerificationResult,
} from "@eigengrid/colony-contracts";
import {
  ZERO_DIGEST,
  validCorrectionOrder,
  validFailedVerificationResult,
  validSpeciesContract,
  validVerificationRequest,
  validVerificationResult,
  validWorkOrder,
  validWorkResult,
} from "../../colony-contracts/src/test-fixtures";
import type { ColonyBudget } from "./budget";
import { sealCampaignDefinition, type CampaignDefinition, type CampaignWorkUnit } from "./state";

export const T0 = "2026-08-30T00:00:00.000Z";

export function speciesContract(
  promotionStatus: SpeciesContract["promotionStatus"] = "unqualified",
  correctionBudget = 32,
): SpeciesContract {
  const base = validSpeciesContract();
  return sealContract({
    ...base,
    budgetPolicy: {
      ...base.budgetPolicy,
      wallTimeMs: 1_000_000,
      inputTokens: 64_000,
      outputTokens: 32_000,
      costMicrounits: 4_000_000,
      corrections: correctionBudget,
      modelCalls: 32,
    },
    frontierEscalation: { ...base.frontierEscalation, maximumCalls: 16 },
    promotionStatus,
    contractDigest: ZERO_DIGEST,
  }) as SpeciesContract;
}

export function speciesIdentity(contract: SpeciesContract): SpeciesIdentity {
  return {
    schema: "eigengrid.species-identity.v1",
    coordinate: contract.identity,
    contractDigest: contract.contractDigest,
  };
}

export function workOrder(contract: SpeciesContract, suffix = "1"): AgentWorkOrder {
  const base = validWorkOrder();
  return sealContract({
    ...base,
    workOrderId: `work-order-${suffix}`,
    requestId: `request-work-${suffix}`,
    idempotencyKey: `work-order-${suffix}-attempt-1`,
    species: speciesIdentity(contract),
    budget: { ...base.budget, corrections: 3 },
    cancellation: { token: `cancel-work-order-${suffix}`, deadline: "2026-09-01T00:00:00.000Z" },
    workOrderDigest: ZERO_DIGEST,
  }) as AgentWorkOrder;
}

export function colonyBudget(overrides: Partial<ColonyBudget> = {}): ColonyBudget {
  return {
    modelCalls: 6,
    inputTokens: 12_000,
    outputTokens: 6_000,
    costMicrounits: 750_000,
    wallTimeMs: 180_000,
    corrections: 3,
    frontierCalls: 1,
    effects: 0,
    computeSeconds: 0,
    ...overrides,
  };
}

export function workUnit(
  order: AgentWorkOrder,
  id = "unit-1",
  dependencies: string[] = [],
  budget = colonyBudget(),
): CampaignWorkUnit {
  return {
    id,
    workOrder: order,
    dependencies,
    ownershipKey: `candidate:${id}`,
    budget,
    requiresIndependentVerification: true,
  };
}

export function campaignDefinition(
  contract: SpeciesContract,
  units: CampaignWorkUnit[] = [workUnit(workOrder(contract))],
  overrides: Partial<Omit<CampaignDefinition, "definitionDigest" | "workUnits" | "species">> = {},
): CampaignDefinition {
  const budget = units.reduce(
    (sum, unit) =>
      Object.fromEntries(
        Object.keys(sum).map((key) => [
          key,
          sum[key as keyof ColonyBudget] + unit.budget[key as keyof ColonyBudget],
        ]),
      ) as ColonyBudget,
    colonyBudget({
      modelCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      costMicrounits: 0,
      wallTimeMs: 0,
      corrections: 0,
      frontierCalls: 0,
      effects: 0,
      computeSeconds: 0,
    }),
  );
  return sealCampaignDefinition({
    schema: "eigengrid.colony-campaign.v1",
    campaignId: "campaign-1",
    objective: "Produce and independently verify a finite candidate",
    species: speciesIdentity(contract),
    baseIdentity: units[0]!.workOrder.baseIdentity,
    createdAt: T0,
    executionMode: "shadow",
    budget,
    maxCorrectionsPerUnit: 2,
    leaseDurationMs: 10_000,
    maximumParallelism: 1,
    workUnits: units,
    ...overrides,
  });
}

export function workResult(
  order: AgentWorkOrder,
  candidateDigest: Digest,
  suffix = "1",
): AgentWorkResult {
  const base = validWorkResult();
  return sealContract({
    ...base,
    workOrderId: order.workOrderId,
    requestId: order.requestId,
    idempotencyKey: order.idempotencyKey,
    correlationId: order.correlationId,
    causationId: order.workOrderId,
    species: order.species,
    caste: order.caste,
    observedBaseIdentity: order.baseIdentity,
    candidates: [
      {
        ...base.candidates[0]!,
        id: `candidate-${suffix}`,
        digest: candidateDigest,
      },
    ],
    criteria: order.acceptanceCriteria.map((criterion) => ({
      criterionId: criterion.id,
      verdict: "pass" as const,
      evidenceIds: ["candidate-evidence"],
      explanation: "Fixture work check passed",
    })),
    modelIdentity: { ...base.modelIdentity, invocationId: `writer-${suffix}` },
    resultDigest: ZERO_DIGEST,
  }) as AgentWorkResult;
}

export function verification(
  order: AgentWorkOrder,
  result: AgentWorkResult,
  verdict: "pass" | "fail",
  suffix = "1",
): { request: VerificationRequest; result: VerificationResult } {
  const requestBase = validVerificationRequest();
  const request = sealContract({
    ...requestBase,
    verificationId: `verification-${suffix}`,
    requestId: `request-verification-${suffix}`,
    correlationId: order.correlationId,
    causationId: result.requestId,
    workOrderId: order.workOrderId,
    workResultDigest: result.resultDigest,
    candidate: result.candidates[0]!,
    expectedBaseIdentity: order.baseIdentity,
    species: order.species,
    acceptanceCriteria: order.acceptanceCriteria,
    protectedState: order.protectedState,
    writerInvocationId: result.modelIdentity.invocationId,
    budget: { ...order.budget, effects: 0, corrections: 0 },
    requestDigest: ZERO_DIGEST,
  }) as VerificationRequest;

  const base = verdict === "pass" ? validVerificationResult() : validFailedVerificationResult();
  const verificationResult = sealContract({
    ...base,
    verificationId: request.verificationId,
    requestId: request.requestId,
    correlationId: request.correlationId,
    causationId: request.verificationId,
    workOrderId: request.workOrderId,
    workResultDigest: request.workResultDigest,
    candidateDigest: request.candidate.digest,
    observedBaseIdentity: request.expectedBaseIdentity,
    verifierInvocationId: `verifier-${suffix}`,
    verifierIdentity: { ...base.verifierIdentity, invocationId: `verifier-${suffix}` },
    criteria: base.criteria.map((criterion) => ({
      ...criterion,
      criterionId:
        criterion.criterionId === base.criteria[0]!.criterionId
          ? order.acceptanceCriteria[0]!.id
          : order.acceptanceCriteria[1]!.id,
    })),
    resultDigest: ZERO_DIGEST,
  }) as VerificationResult;
  return { request, result: verificationResult };
}

export function correction(
  order: AgentWorkOrder,
  result: AgentWorkResult,
  verificationResult: VerificationResult,
  attempt: number,
): CorrectionOrder {
  const base = validCorrectionOrder();
  const failed = verificationResult.criteria.filter((criterion) => criterion.verdict !== "pass");
  const passing = verificationResult.criteria.filter((criterion) => criterion.verdict === "pass");
  return sealContract({
    ...base,
    correctionId: `correction-${attempt}`,
    requestId: `request-correction-${attempt}`,
    idempotencyKey: `correction-${attempt}-idempotency`,
    correlationId: order.correlationId,
    causationId: verificationResult.verificationId,
    originalWorkOrderId: order.workOrderId,
    attempt,
    species: order.species,
    caste: order.caste,
    previousCandidateDigest: result.candidates[0]!.digest,
    previousWorkResultDigest: result.resultDigest,
    verificationResultDigest: verificationResult.resultDigest,
    failedCriteria: failed.map((criterion) => ({
      criterionId: criterion.criterionId,
      defect: "Independent verification found a bounded defect",
      evidenceIds: ["defect-evidence"],
    })),
    preservedSuccess: passing.map((criterion) => ({
      criterionId: criterion.criterionId,
      candidateDigest: result.candidates[0]!.digest,
      evidenceIds: ["candidate-evidence"],
    })),
    remainingBudget: {
      ...order.budget,
      corrections: Math.max(1, order.budget.corrections - attempt),
    },
    requiredReverification: {
      ...base.requiredReverification,
      criterionIds: failed.map((criterion) => criterion.criterionId),
    },
    correctionDigest: ZERO_DIGEST,
  }) as CorrectionOrder;
}
