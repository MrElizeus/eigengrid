import { z } from "zod";
import { canonicalJson, verifyContractDigest } from "./digest";
import {
  AuthoritativeReferenceSchema,
  BaseIdentitySchema,
  BlockerSchema,
  BudgetSchema,
  CasteIdSchema,
  ContextReferenceSchema,
  ContradictionSchema,
  CriterionResultSchema,
  CriterionSchema,
  DigestSchema,
  EscalationConditionSchema,
  ExternalEvidenceReferenceSchema,
  IdentifierSchema,
  ModelHypothesisReferenceSchema,
  ModelIdentitySchema,
  ModelTierSchema,
  OperationAttemptSchema,
  ResourceScopeSchema,
  SchemaReferenceSchema,
  TechnicalIdSchema,
  UntrustedTextReferenceSchema,
  UsageSchema,
  ValidatedSkillReferenceSchema,
  VerdictSchema,
  VerificationPolicySchema,
  distinctValues,
  scopeKey,
} from "./primitives";
import { SpeciesIdentitySchema } from "./species";

const finiteText = (maximum = 8_192) => z.string().min(1).max(maximum);
const VerificationBudgetSchema = BudgetSchema.extend({ effects: z.literal(0) }).strict();
const CorrectionBudgetSchema = BudgetSchema.extend({
  // A correction order can legitimately consume the final allowed attempt;
  // zero remaining corrections is an explicit durable exhaustion state.
  corrections: z.number().int().nonnegative(),
}).strict();

function sameValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function requireSealed(label: string, value: unknown): void {
  if (!verifyContractDigest(value)) throw new TypeError(`${label} canonical digest mismatch`);
}

export const ContextPackSchema = z
  .object({
    schema: z.literal("eigengrid.context-pack.v1"),
    requestId: IdentifierSchema,
    correlationId: IdentifierSchema,
    causationId: IdentifierSchema.optional(),
    objective: finiteText(16_384),
    species: SpeciesIdentitySchema,
    caste: CasteIdSchema,
    baseIdentity: BaseIdentitySchema,
    authoritativeFacts: z.array(AuthoritativeReferenceSchema),
    selectedSkillFragments: z.array(ValidatedSkillReferenceSchema),
    externalEvidence: z.array(ExternalEvidenceReferenceSchema),
    modelHypotheses: z.array(ModelHypothesisReferenceSchema),
    untrustedRetrievedText: z.array(UntrustedTextReferenceSchema),
    allowedEvidenceIds: z.array(IdentifierSchema),
    knownContradictions: z.array(ContradictionSchema),
    constraints: z.array(finiteText(4_096)),
    budgets: BudgetSchema,
    allowedCapabilities: z.array(TechnicalIdSchema),
    prohibitedCapabilities: z.array(TechnicalIdSchema),
    expectedOutputSchema: SchemaReferenceSchema,
    acceptanceCriteria: z.array(CriterionSchema).min(1),
    sensitivePathExclusions: z.array(z.string().min(1).max(2_048)),
    contextDigest: DigestSchema,
  })
  .strict()
  .superRefine((pack, context) => {
    const sources = [
      ...pack.authoritativeFacts,
      ...pack.selectedSkillFragments,
      ...pack.externalEvidence,
      ...pack.modelHypotheses,
      ...pack.untrustedRetrievedText,
    ];
    const sourceIds = sources.map((source) => source.id);
    if (!distinctValues(sourceIds)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Context source IDs must be unique",
      });
    }
    const sourceIdSet = new Set(sourceIds);
    if (!distinctValues(pack.allowedEvidenceIds)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Allowed evidence IDs must be unique",
        path: ["allowedEvidenceIds"],
      });
    }
    for (const [index, id] of pack.allowedEvidenceIds.entries()) {
      if (!sourceIdSet.has(id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Allowed evidence ID ${id} is not present in the context pack`,
          path: ["allowedEvidenceIds", index],
        });
      }
    }
    for (const [contradictionIndex, contradiction] of pack.knownContradictions.entries()) {
      for (const evidenceId of contradiction.evidenceIds) {
        if (!sourceIdSet.has(evidenceId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Contradiction evidence ID ${evidenceId} is not present in the context pack`,
            path: ["knownContradictions", contradictionIndex, "evidenceIds"],
          });
        }
      }
    }
    if (!distinctValues(pack.acceptanceCriteria.map((criterion) => criterion.id))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Acceptance criterion IDs must be unique",
        path: ["acceptanceCriteria"],
      });
    }
    if (!distinctValues(pack.allowedCapabilities)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Allowed capabilities must be unique",
        path: ["allowedCapabilities"],
      });
    }
    if (!distinctValues(pack.prohibitedCapabilities)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Prohibited capabilities must be unique",
        path: ["prohibitedCapabilities"],
      });
    }
    const allowed = new Set(pack.allowedCapabilities);
    const overlap = pack.prohibitedCapabilities.filter((capability) => allowed.has(capability));
    if (overlap.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Capabilities cannot be both allowed and prohibited: ${overlap.join(", ")}`,
        path: ["prohibitedCapabilities"],
      });
    }
  });
export type ContextPack = z.infer<typeof ContextPackSchema>;

export const AgentWorkOrderSchema = z
  .object({
    schema: z.literal("eigengrid.agent-work-order.v1"),
    workOrderId: IdentifierSchema,
    requestId: IdentifierSchema,
    idempotencyKey: IdentifierSchema,
    correlationId: IdentifierSchema,
    causationId: IdentifierSchema.optional(),
    contextPackDigest: DigestSchema,
    objective: finiteText(16_384),
    nonGoals: z.array(finiteText(4_096)),
    species: SpeciesIdentitySchema,
    caste: CasteIdSchema,
    modelTierConstraints: z
      .object({
        allowedTiers: z.array(ModelTierSchema).min(1),
        providerPolicyIds: z.array(TechnicalIdSchema),
      })
      .strict(),
    baseIdentity: BaseIdentitySchema,
    allowedResources: z.array(ResourceScopeSchema),
    forbiddenResources: z.array(ResourceScopeSchema),
    protectedState: z.array(ContextReferenceSchema),
    inputReferences: z.array(ContextReferenceSchema),
    outputContract: SchemaReferenceSchema,
    acceptanceCriteria: z.array(CriterionSchema).min(1),
    verificationRequirements: VerificationPolicySchema,
    budget: BudgetSchema,
    approvalPrerequisites: z.array(ContextReferenceSchema),
    cancellation: z
      .object({
        token: IdentifierSchema,
        deadline: z.string().datetime({ offset: true }),
      })
      .strict(),
    escalationConditions: z.array(EscalationConditionSchema),
    workOrderDigest: DigestSchema,
  })
  .strict()
  .superRefine((order, context) => {
    if (!distinctValues(order.modelTierConstraints.allowedTiers)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Allowed model tiers must be unique",
        path: ["modelTierConstraints", "allowedTiers"],
      });
    }
    if (!distinctValues(order.allowedResources.map(scopeKey))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Allowed resources must be unique",
        path: ["allowedResources"],
      });
    }
    if (!distinctValues(order.forbiddenResources.map(scopeKey))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Forbidden resources must be unique",
        path: ["forbiddenResources"],
      });
    }
    if (!distinctValues(order.acceptanceCriteria.map((criterion) => criterion.id))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Acceptance criterion IDs must be unique",
        path: ["acceptanceCriteria"],
      });
    }
    const allowed = new Set(order.allowedResources.map(scopeKey));
    const overlap = order.forbiddenResources.filter((resource) => allowed.has(scopeKey(resource)));
    if (overlap.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A resource cannot be both allowed and forbidden",
        path: ["forbiddenResources"],
      });
    }
  });
export type AgentWorkOrder = z.infer<typeof AgentWorkOrderSchema>;

export const AgentWorkResultSchema = z
  .object({
    schema: z.literal("eigengrid.agent-work-result.v1"),
    workOrderId: IdentifierSchema,
    requestId: IdentifierSchema,
    idempotencyKey: IdentifierSchema,
    correlationId: IdentifierSchema,
    causationId: IdentifierSchema.optional(),
    species: SpeciesIdentitySchema,
    caste: CasteIdSchema,
    status: z.enum(["success", "partial", "blocked", "failed"]),
    observedBaseIdentity: BaseIdentitySchema,
    summary: finiteText(16_384),
    candidates: z.array(ModelHypothesisReferenceSchema),
    affectedResources: z.array(ResourceScopeSchema),
    attemptedOperations: z.array(OperationAttemptSchema),
    toolReceipts: z.array(ContextReferenceSchema),
    evidence: z.array(ContextReferenceSchema).min(1),
    criteria: z.array(CriterionResultSchema).min(1),
    deviations: z.array(finiteText(4_096)),
    blockers: z.array(BlockerSchema),
    unrelatedChanges: z.array(finiteText(4_096)),
    selfReview: z
      .object({
        summary: finiteText(8_192),
        checks: z.array(finiteText(4_096)),
      })
      .strict(),
    modelIdentity: ModelIdentitySchema,
    usage: UsageSchema,
    confidence: z.number().min(0).max(1),
    limitations: z.array(finiteText(4_096)),
    memoryCandidates: z.array(ModelHypothesisReferenceSchema),
    skillCandidates: z.array(ModelHypothesisReferenceSchema),
    resultDigest: DigestSchema,
  })
  .strict()
  .superRefine((result, context) => {
    if (
      result.status === "success" &&
      result.criteria.some((criterion) => criterion.verdict !== "pass")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A successful result requires every criterion to pass",
        path: ["criteria"],
      });
    }
    if (result.status === "success" && result.blockers.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A successful result cannot contain blockers",
        path: ["blockers"],
      });
    }
    const references = [...result.candidates, ...result.toolReceipts, ...result.evidence];
    const referenceIds = references.map((reference) => reference.id);
    if (!distinctValues(referenceIds)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Candidate, receipt, and evidence IDs must be unique",
      });
    }
    const referenceIdSet = new Set(referenceIds);
    if (!distinctValues(result.criteria.map((criterion) => criterion.criterionId))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Criterion-result IDs must be unique",
        path: ["criteria"],
      });
    }
    for (const [criterionIndex, criterion] of result.criteria.entries()) {
      if (criterion.verdict === "pass" && criterion.evidenceIds.length === 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "A passing criterion requires evidence",
          path: ["criteria", criterionIndex, "evidenceIds"],
        });
      }
      for (const evidenceId of criterion.evidenceIds) {
        if (!referenceIdSet.has(evidenceId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Criterion evidence ID ${evidenceId} is absent from the result`,
            path: ["criteria", criterionIndex, "evidenceIds"],
          });
        }
      }
    }
    const receiptIds = new Set(result.toolReceipts.map((receipt) => receipt.id));
    for (const [operationIndex, operation] of result.attemptedOperations.entries()) {
      if (operation.status === "completed" && operation.receiptIds.length === 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "A completed operation requires at least one receipt",
          path: ["attemptedOperations", operationIndex, "receiptIds"],
        });
      }
      for (const receiptId of operation.receiptIds) {
        if (!receiptIds.has(receiptId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Operation receipt ID ${receiptId} is absent from tool receipts`,
            path: ["attemptedOperations", operationIndex, "receiptIds"],
          });
        }
      }
    }
  });
export type AgentWorkResult = z.infer<typeof AgentWorkResultSchema>;

export const VerificationRequestSchema = z
  .object({
    schema: z.literal("eigengrid.verification-request.v1"),
    verificationId: IdentifierSchema,
    requestId: IdentifierSchema,
    correlationId: IdentifierSchema,
    causationId: IdentifierSchema,
    workOrderId: IdentifierSchema,
    workResultDigest: DigestSchema,
    candidate: ModelHypothesisReferenceSchema,
    expectedBaseIdentity: BaseIdentitySchema,
    species: SpeciesIdentitySchema,
    verifierCaste: CasteIdSchema,
    acceptanceCriteria: z.array(CriterionSchema).min(1),
    protectedState: z.array(ContextReferenceSchema),
    requiredEvidenceIds: z.array(IdentifierSchema),
    writerInvocationId: IdentifierSchema,
    independence: z
      .object({
        differentInvocationRequired: z.literal(true),
        writerPrivateReasoningExcluded: z.literal(true),
        candidateWriteProhibited: z.literal(true),
      })
      .strict(),
    allowedCapabilities: z.array(TechnicalIdSchema),
    prohibitedCapabilities: z.array(TechnicalIdSchema),
    budget: VerificationBudgetSchema,
    requestDigest: DigestSchema,
  })
  .strict()
  .superRefine((request, context) => {
    const allowed = new Set(request.allowedCapabilities);
    const overlap = request.prohibitedCapabilities.filter((capability) => allowed.has(capability));
    if (overlap.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A verification capability cannot be both allowed and prohibited",
        path: ["prohibitedCapabilities"],
      });
    }
    if (
      request.allowedCapabilities.includes("candidate.write") ||
      !request.prohibitedCapabilities.includes("candidate.write")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Independent verification must explicitly prohibit candidate.write",
        path: ["prohibitedCapabilities"],
      });
    }
    if (!distinctValues(request.acceptanceCriteria.map((criterion) => criterion.id))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Verification criterion IDs must be unique",
        path: ["acceptanceCriteria"],
      });
    }
  });
export type VerificationRequest = z.infer<typeof VerificationRequestSchema>;

export const CheckAssessmentSchema = z
  .object({
    verdict: VerdictSchema,
    summary: finiteText(8_192),
    evidenceIds: z.array(IdentifierSchema),
  })
  .strict();

export const VerificationResultSchema = z
  .object({
    schema: z.literal("eigengrid.verification-result.v1"),
    verificationId: IdentifierSchema,
    requestId: IdentifierSchema,
    correlationId: IdentifierSchema,
    causationId: IdentifierSchema,
    workOrderId: IdentifierSchema,
    workResultDigest: DigestSchema,
    candidateDigest: DigestSchema,
    observedBaseIdentity: BaseIdentitySchema,
    verifierInvocationId: IdentifierSchema,
    verifierIdentity: ModelIdentitySchema,
    verdict: VerdictSchema,
    identityAndScope: CheckAssessmentSchema,
    contractConformance: CheckAssessmentSchema,
    protectedState: CheckAssessmentSchema,
    deterministicEvidence: CheckAssessmentSchema,
    scientificAssumptions: CheckAssessmentSchema,
    authorityBoundaries: CheckAssessmentSchema,
    provenanceCompleteness: CheckAssessmentSchema,
    budgetCompliance: CheckAssessmentSchema,
    introducedFailures: z.array(BlockerSchema),
    preExistingFailures: z.array(BlockerSchema),
    criteria: z.array(CriterionResultSchema).min(1),
    evidence: z.array(ContextReferenceSchema).min(1),
    residualRisks: z.array(finiteText(4_096)),
    usage: UsageSchema,
    resultDigest: DigestSchema,
  })
  .strict()
  .superRefine((result, context) => {
    const checks = [
      result.identityAndScope,
      result.contractConformance,
      result.protectedState,
      result.deterministicEvidence,
      result.scientificAssumptions,
      result.authorityBoundaries,
      result.provenanceCompleteness,
      result.budgetCompliance,
      ...result.criteria,
    ];
    if (result.verdict === "pass" && checks.some((check) => check.verdict !== "pass")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A passing verification result requires every check and criterion to pass",
        path: ["verdict"],
      });
    }
    if (result.verdict === "pass" && result.introducedFailures.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A passing verification result cannot contain introduced failures",
        path: ["introducedFailures"],
      });
    }
    if (result.verifierInvocationId !== result.verifierIdentity.invocationId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Verifier invocation identity must be internally consistent",
        path: ["verifierInvocationId"],
      });
    }
    const evidenceIds = new Set(result.evidence.map((evidence) => evidence.id));
    const assessments = [
      result.identityAndScope,
      result.contractConformance,
      result.protectedState,
      result.deterministicEvidence,
      result.scientificAssumptions,
      result.authorityBoundaries,
      result.provenanceCompleteness,
      result.budgetCompliance,
      ...result.criteria,
    ];
    for (const [assessmentIndex, assessment] of assessments.entries()) {
      if (assessment.verdict === "pass" && assessment.evidenceIds.length === 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "A passing verification assessment requires evidence",
          path: ["criteria", assessmentIndex, "evidenceIds"],
        });
      }
      for (const evidenceId of assessment.evidenceIds) {
        if (!evidenceIds.has(evidenceId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Verification evidence ID ${evidenceId} is absent from the result`,
            path: ["criteria", assessmentIndex, "evidenceIds"],
          });
        }
      }
    }
    if (!distinctValues(result.criteria.map((criterion) => criterion.criterionId))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Verification criterion-result IDs must be unique",
        path: ["criteria"],
      });
    }
  });
export type VerificationResult = z.infer<typeof VerificationResultSchema>;

export const CorrectionOrderSchema = z
  .object({
    schema: z.literal("eigengrid.correction-order.v1"),
    correctionId: IdentifierSchema,
    requestId: IdentifierSchema,
    idempotencyKey: IdentifierSchema,
    correlationId: IdentifierSchema,
    causationId: IdentifierSchema,
    originalWorkOrderId: IdentifierSchema,
    attempt: z.number().int().positive(),
    species: SpeciesIdentitySchema,
    caste: CasteIdSchema,
    previousCandidateDigest: DigestSchema,
    previousWorkResultDigest: DigestSchema,
    verificationResultDigest: DigestSchema,
    failedCriteria: z
      .array(
        z
          .object({
            criterionId: IdentifierSchema,
            defect: finiteText(8_192),
            evidenceIds: z.array(IdentifierSchema).min(1),
          })
          .strict(),
      )
      .min(1),
    defectEvidence: z.array(ContextReferenceSchema).min(1),
    permittedScope: z.array(ResourceScopeSchema).min(1),
    preservedSuccess: z
      .array(
        z
          .object({
            criterionId: IdentifierSchema,
            candidateDigest: DigestSchema,
            evidenceIds: z.array(IdentifierSchema).min(1),
          })
          .strict(),
      )
      .min(1),
    remainingBudget: CorrectionBudgetSchema,
    expectedProgressSignal: z
      .object({
        description: finiteText(4_096),
        priorEvidenceDigest: DigestSchema,
        requiredDelta: finiteText(4_096),
      })
      .strict(),
    prohibitedRedesign: z.array(finiteText(4_096)).min(1),
    requiredReverification: z
      .object({
        schema: SchemaReferenceSchema,
        criterionIds: z.array(IdentifierSchema).min(1),
        independent: z.literal(true),
      })
      .strict(),
    escalationCondition: EscalationConditionSchema,
    correctionDigest: DigestSchema,
  })
  .strict()
  .superRefine((order, context) => {
    const failed = new Set(order.failedCriteria.map((criterion) => criterion.criterionId));
    const preservedOverlap = order.preservedSuccess.filter((criterion) =>
      failed.has(criterion.criterionId),
    );
    if (preservedOverlap.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A criterion cannot be both failed and preserved",
        path: ["preservedSuccess"],
      });
    }
    if (!distinctValues(order.failedCriteria.map((criterion) => criterion.criterionId))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Failed criterion IDs must be unique",
        path: ["failedCriteria"],
      });
    }
    const defectEvidenceIds = new Set(order.defectEvidence.map((evidence) => evidence.id));
    for (const [criterionIndex, criterion] of order.failedCriteria.entries()) {
      for (const evidenceId of criterion.evidenceIds) {
        if (!defectEvidenceIds.has(evidenceId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Defect evidence ID ${evidenceId} is absent from the correction order`,
            path: ["failedCriteria", criterionIndex, "evidenceIds"],
          });
        }
      }
    }
    const failedCriterionIds = [...failed].sort();
    const reverifyCriterionIds = [...order.requiredReverification.criterionIds].sort();
    if (!sameValue(failedCriterionIds, reverifyCriterionIds)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Required re-verification must cover exactly the failed criteria",
        path: ["requiredReverification", "criterionIds"],
      });
    }
  });
export type CorrectionOrder = z.infer<typeof CorrectionOrderSchema>;

export function validateWorkOrderContextBinding(
  contextInput: unknown,
  workOrderInput: unknown,
): { context: ContextPack; workOrder: AgentWorkOrder } {
  const context = ContextPackSchema.parse(contextInput);
  const workOrder = AgentWorkOrderSchema.parse(workOrderInput);
  requireSealed("Context pack", context);
  requireSealed("Work order", workOrder);
  const mismatches: string[] = [];
  if (context.contextDigest !== workOrder.contextPackDigest) mismatches.push("contextPackDigest");
  if (context.requestId !== workOrder.causationId) mismatches.push("causationId");
  if (context.correlationId !== workOrder.correlationId) mismatches.push("correlationId");
  if (context.objective !== workOrder.objective) mismatches.push("objective");
  if (!sameValue(context.species, workOrder.species)) mismatches.push("species");
  if (context.caste !== workOrder.caste) mismatches.push("caste");
  if (!sameValue(context.baseIdentity, workOrder.baseIdentity)) mismatches.push("baseIdentity");
  if (!sameValue(context.expectedOutputSchema, workOrder.outputContract)) {
    mismatches.push("outputContract");
  }
  if (!sameValue(context.acceptanceCriteria, workOrder.acceptanceCriteria)) {
    mismatches.push("acceptanceCriteria");
  }
  const contextReferences = new Map(
    [
      ...context.authoritativeFacts,
      ...context.selectedSkillFragments,
      ...context.externalEvidence,
      ...context.modelHypotheses,
      ...context.untrustedRetrievedText,
    ].map((reference) => [reference.id, reference]),
  );
  for (const reference of workOrder.inputReferences) {
    const packed = contextReferences.get(reference.id);
    if (!packed || !sameValue(packed, reference)) mismatches.push(`inputReference:${reference.id}`);
  }
  if (mismatches.length > 0) {
    throw new TypeError(`Work-order/context binding mismatch: ${mismatches.join(", ")}`);
  }
  return { context, workOrder };
}

const USAGE_BUDGET_FIELDS = [
  "wallTimeMs",
  "inputTokens",
  "outputTokens",
  "costMicrounits",
  "effects",
  "corrections",
  "modelCalls",
  "computeSeconds",
  "storageBytes",
  "networkBytes",
] as const;

export function validateWorkResultBinding(
  workOrderInput: unknown,
  resultInput: unknown,
): { workOrder: AgentWorkOrder; result: AgentWorkResult } {
  const workOrder = AgentWorkOrderSchema.parse(workOrderInput);
  const result = AgentWorkResultSchema.parse(resultInput);
  requireSealed("Work order", workOrder);
  requireSealed("Work result", result);
  const mismatches: string[] = [];
  if (workOrder.workOrderId !== result.workOrderId) mismatches.push("workOrderId");
  if (workOrder.requestId !== result.requestId) mismatches.push("requestId");
  if (workOrder.idempotencyKey !== result.idempotencyKey) mismatches.push("idempotencyKey");
  if (workOrder.correlationId !== result.correlationId) mismatches.push("correlationId");
  if (result.causationId !== workOrder.workOrderId) mismatches.push("causationId");
  if (!sameValue(workOrder.species, result.species)) mismatches.push("species");
  if (workOrder.caste !== result.caste) mismatches.push("caste");
  if (!sameValue(workOrder.baseIdentity, result.observedBaseIdentity)) {
    mismatches.push("observedBaseIdentity");
  }
  const allowedScopes = new Set(workOrder.allowedResources.map(scopeKey));
  const forbiddenScopes = new Set(workOrder.forbiddenResources.map(scopeKey));
  for (const resource of result.affectedResources) {
    const key = scopeKey(resource);
    if (!allowedScopes.has(key)) mismatches.push(`affectedResource:notAllowed:${key}`);
    if (forbiddenScopes.has(key)) mismatches.push(`affectedResource:forbidden:${key}`);
  }
  const allowedCapabilities = new Set(
    workOrder.allowedResources
      .filter((resource) => resource.kind === "capability" && resource.access === "invoke")
      .map((resource) => resource.selector),
  );
  for (const operation of result.attemptedOperations) {
    if (!allowedCapabilities.has(operation.capabilityId)) {
      mismatches.push(`operationCapability:${operation.capabilityId}`);
    }
  }
  const requiredCriteria = workOrder.acceptanceCriteria.map((criterion) => criterion.id).sort();
  const observedCriteria = result.criteria.map((criterion) => criterion.criterionId).sort();
  if (!sameValue(requiredCriteria, observedCriteria)) mismatches.push("criteria");
  for (const field of USAGE_BUDGET_FIELDS) {
    if (result.usage[field] > workOrder.budget[field]) mismatches.push(`budget:${field}`);
  }
  if (mismatches.length > 0) {
    throw new TypeError(`Work-result binding mismatch: ${mismatches.join(", ")}`);
  }
  return { workOrder, result };
}

export function validateVerificationBinding(
  requestInput: unknown,
  resultInput: unknown,
): { request: VerificationRequest; result: VerificationResult } {
  const request = VerificationRequestSchema.parse(requestInput);
  const result = VerificationResultSchema.parse(resultInput);
  requireSealed("Verification request", request);
  requireSealed("Verification result", result);
  const mismatches: string[] = [];
  if (request.verificationId !== result.verificationId) mismatches.push("verificationId");
  if (request.requestId !== result.requestId) mismatches.push("requestId");
  if (request.correlationId !== result.correlationId) mismatches.push("correlationId");
  if (request.workOrderId !== result.workOrderId) mismatches.push("workOrderId");
  if (request.workResultDigest !== result.workResultDigest) mismatches.push("workResultDigest");
  if (result.causationId !== request.verificationId) mismatches.push("causationId");
  if (request.candidate.digest !== result.candidateDigest) mismatches.push("candidateDigest");
  if (!sameValue(request.expectedBaseIdentity, result.observedBaseIdentity)) {
    mismatches.push("baseIdentity");
  }
  if (request.writerInvocationId === result.verifierInvocationId) {
    mismatches.push("independentInvocation");
  }
  const requiredCriteria = request.acceptanceCriteria.map((criterion) => criterion.id).sort();
  const observedCriteria = result.criteria.map((criterion) => criterion.criterionId).sort();
  if (!sameValue(requiredCriteria, observedCriteria)) mismatches.push("criteria");
  for (const field of USAGE_BUDGET_FIELDS) {
    if (result.usage[field] > request.budget[field]) mismatches.push(`budget:${field}`);
  }
  if (mismatches.length > 0) {
    throw new TypeError(`Verification binding mismatch: ${mismatches.join(", ")}`);
  }
  return { request, result };
}

export function validateCorrectionBinding(
  correctionInput: unknown,
  workOrderInput: unknown,
  workResultInput: unknown,
  verificationResultInput: unknown,
): {
  correction: CorrectionOrder;
  workOrder: AgentWorkOrder;
  workResult: AgentWorkResult;
  verificationResult: VerificationResult;
} {
  const correction = CorrectionOrderSchema.parse(correctionInput);
  const workOrder = AgentWorkOrderSchema.parse(workOrderInput);
  const workResult = AgentWorkResultSchema.parse(workResultInput);
  const verificationResult = VerificationResultSchema.parse(verificationResultInput);
  requireSealed("Correction order", correction);
  requireSealed("Work order", workOrder);
  requireSealed("Work result", workResult);
  requireSealed("Verification result", verificationResult);
  const mismatches: string[] = [];
  if (correction.originalWorkOrderId !== workOrder.workOrderId) {
    mismatches.push("originalWorkOrderId");
  }
  if (workResult.workOrderId !== workOrder.workOrderId) mismatches.push("workResult.workOrderId");
  if (correction.previousWorkResultDigest !== workResult.resultDigest) {
    mismatches.push("previousWorkResultDigest");
  }
  if (correction.verificationResultDigest !== verificationResult.resultDigest) {
    mismatches.push("verificationResultDigest");
  }
  if (correction.causationId !== verificationResult.verificationId) mismatches.push("causationId");
  if (correction.correlationId !== workOrder.correlationId) mismatches.push("correlationId");
  if (!sameValue(correction.species, workOrder.species)) mismatches.push("species");
  if (correction.caste !== workOrder.caste) mismatches.push("caste");
  if (
    !workResult.candidates.some(
      (candidate) => candidate.digest === correction.previousCandidateDigest,
    )
  ) {
    mismatches.push("previousCandidateDigest");
  }
  const failedCriteria = verificationResult.criteria
    .filter((criterion) => criterion.verdict !== "pass")
    .map((criterion) => criterion.criterionId)
    .sort();
  const correctedCriteria = correction.failedCriteria
    .map((criterion) => criterion.criterionId)
    .sort();
  if (!sameValue(failedCriteria, correctedCriteria)) mismatches.push("failedCriteria");
  const passingCriteria = new Set(
    verificationResult.criteria
      .filter((criterion) => criterion.verdict === "pass")
      .map((criterion) => criterion.criterionId),
  );
  for (const preserved of correction.preservedSuccess) {
    if (!passingCriteria.has(preserved.criterionId)) {
      mismatches.push(`preservedSuccess:${preserved.criterionId}`);
    }
  }
  const allowedScopes = new Set(workOrder.allowedResources.map(scopeKey));
  const forbiddenScopes = new Set(workOrder.forbiddenResources.map(scopeKey));
  for (const scope of correction.permittedScope) {
    const key = scopeKey(scope);
    if (!allowedScopes.has(key) || forbiddenScopes.has(key)) {
      mismatches.push(`permittedScope:${key}`);
    }
  }
  if (correction.attempt + correction.remainingBudget.corrections > workOrder.budget.corrections) {
    mismatches.push("correctionBudget");
  }
  if (mismatches.length > 0) {
    throw new TypeError(`Correction binding mismatch: ${mismatches.join(", ")}`);
  }
  return { correction, workOrder, workResult, verificationResult };
}
