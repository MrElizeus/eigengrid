import { z } from "zod";

export const COLONY_PROTOCOL_ID = "eigengrid.colony" as const;
export const COLONY_PROTOCOL_VERSION = "1.0.0" as const;
export const COLONY_CONTRACT_PACKAGE_VERSION = "0.1.0" as const;

export const CONTRACT_SCHEMA_IDS = [
  "eigengrid.context-pack.v1",
  "eigengrid.agent-work-order.v1",
  "eigengrid.agent-work-result.v1",
  "eigengrid.verification-request.v1",
  "eigengrid.verification-result.v1",
  "eigengrid.correction-order.v1",
  "eigengrid.species-identity.v1",
  "eigengrid.species-contract.v1",
  "eigengrid.colony-compatibility-manifest.v1",
] as const;

export type ContractSchemaId = (typeof CONTRACT_SCHEMA_IDS)[number];
export const ContractSchemaIdSchema = z.enum(CONTRACT_SCHEMA_IDS);

export const IdentifierSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/u, "Expected a stable technical identifier");
export type Identifier = z.infer<typeof IdentifierSchema>;

export const TechnicalIdSchema = z
  .string()
  .min(3)
  .max(160)
  .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u, "Expected a lower-case namespaced technical identifier");
export type TechnicalId = z.infer<typeof TechnicalIdSchema>;

export const DigestSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/u, "Expected a sha256-prefixed lower-case digest");
export type Digest = z.infer<typeof DigestSchema>;

export const SemverSchema = z
  .string()
  .max(128)
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u,
    "Expected a semantic version",
  );
export type Semver = z.infer<typeof SemverSchema>;

export const TimestampSchema = z.string().datetime({ offset: true });

export const TrustClassSchema = z.enum([
  "authoritative_state",
  "validated_skill",
  "external_evidence",
  "model_hypothesis",
  "untrusted_retrieved_text",
]);
export type TrustClass = z.infer<typeof TrustClassSchema>;

export const ModelTierSchema = z.enum(["T0", "T1", "T2", "T3", "T4"]);
export type ModelTier = z.infer<typeof ModelTierSchema>;

export const AutonomyLevelSchema = z.enum(["A0", "A1", "A2", "A3", "A4"]);
export type AutonomyLevel = z.infer<typeof AutonomyLevelSchema>;

export const CasteIdSchema = z.enum([
  "governor",
  "architect",
  "scout",
  "forager",
  "builder",
  "operator",
  "critic",
  "verifier",
  "sentinel",
  "steward",
  "medic",
  "integrator",
]);
export type CasteId = z.infer<typeof CasteIdSchema>;

export const GenusSchema = z.enum([
  "architecture",
  "software-engineering",
  "release",
  "infrastructure",
  "provisioning",
  "incident-response",
  "scientific-planning",
  "scientific-execution",
  "scientific-diagnosis",
  "scientific-validation",
  "research",
  "knowledge-curation",
]);
export type Genus = z.infer<typeof GenusSchema>;

export const RiskClassSchema = z.enum(["R0", "R1", "R2", "R3", "R4", "R5"]);
export type RiskClass = z.infer<typeof RiskClassSchema>;

export const VerdictSchema = z.enum(["pass", "fail", "blocked", "inconclusive"]);
export type Verdict = z.infer<typeof VerdictSchema>;

export const BaseIdentitySchema = z
  .object({
    kind: z.enum(["repository", "mission", "operation", "artifact"]),
    id: IdentifierSchema,
    revision: z.union([z.number().int().nonnegative(), z.string().min(1).max(256)]),
    digest: DigestSchema,
  })
  .strict();
export type BaseIdentity = z.infer<typeof BaseIdentitySchema>;

export const SchemaReferenceSchema = z
  .object({
    id: IdentifierSchema,
    version: SemverSchema,
    digest: DigestSchema,
  })
  .strict();
export type SchemaReference = z.infer<typeof SchemaReferenceSchema>;

export const ContextReferenceSchema = z
  .object({
    id: IdentifierSchema,
    kind: TechnicalIdSchema,
    digest: DigestSchema,
    trustClass: TrustClassSchema,
    uri: z.string().min(1).max(2_048).optional(),
    claim: z.string().min(1).max(16_384).optional(),
    accessedAt: TimestampSchema.optional(),
  })
  .strict();
export type ContextReference = z.infer<typeof ContextReferenceSchema>;

export const AuthoritativeReferenceSchema = ContextReferenceSchema.extend({
  trustClass: z.literal("authoritative_state"),
}).strict();
export const ValidatedSkillReferenceSchema = ContextReferenceSchema.extend({
  trustClass: z.literal("validated_skill"),
}).strict();
export const ExternalEvidenceReferenceSchema = ContextReferenceSchema.extend({
  trustClass: z.literal("external_evidence"),
}).strict();
export const ModelHypothesisReferenceSchema = ContextReferenceSchema.extend({
  trustClass: z.literal("model_hypothesis"),
}).strict();
export const UntrustedTextReferenceSchema = ContextReferenceSchema.extend({
  trustClass: z.literal("untrusted_retrieved_text"),
}).strict();

export const BudgetSchema = z
  .object({
    wallTimeMs: z.number().int().positive(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    costMicrounits: z.number().int().nonnegative(),
    effects: z.number().int().nonnegative(),
    corrections: z.number().int().nonnegative(),
    modelCalls: z.number().int().nonnegative(),
    computeSeconds: z.number().int().nonnegative(),
    storageBytes: z.number().int().nonnegative(),
    networkBytes: z.number().int().nonnegative(),
    deadline: TimestampSchema.optional(),
  })
  .strict();
export type Budget = z.infer<typeof BudgetSchema>;

export const UsageSchema = z
  .object({
    wallTimeMs: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    costMicrounits: z.number().int().nonnegative(),
    effects: z.number().int().nonnegative(),
    corrections: z.number().int().nonnegative(),
    modelCalls: z.number().int().nonnegative(),
    computeSeconds: z.number().int().nonnegative(),
    storageBytes: z.number().int().nonnegative(),
    networkBytes: z.number().int().nonnegative(),
  })
  .strict();
export type Usage = z.infer<typeof UsageSchema>;

export const CriterionSchema = z
  .object({
    id: IdentifierSchema,
    statement: z.string().min(1).max(8_192),
    verification: z.string().min(1).max(8_192),
    scientificallyMaterial: z.boolean(),
  })
  .strict();
export type Criterion = z.infer<typeof CriterionSchema>;

export const CriterionResultSchema = z
  .object({
    criterionId: IdentifierSchema,
    verdict: VerdictSchema,
    evidenceIds: z.array(IdentifierSchema),
    explanation: z.string().min(1).max(8_192),
  })
  .strict();
export type CriterionResult = z.infer<typeof CriterionResultSchema>;

export const ContradictionSchema = z
  .object({
    id: IdentifierSchema,
    statement: z.string().min(1).max(8_192),
    evidenceIds: z.array(IdentifierSchema).min(1),
  })
  .strict();

export const ResourceScopeSchema = z
  .object({
    kind: z.enum([
      "repository_path",
      "mission_object",
      "operation",
      "artifact",
      "evidence",
      "skill",
      "capability",
      "network_origin",
    ]),
    selector: z.string().min(1).max(2_048),
    access: z.enum(["read", "candidate_write", "invoke"]),
  })
  .strict();
export type ResourceScope = z.infer<typeof ResourceScopeSchema>;

export const VerificationPolicySchema = z
  .object({
    independent: z.boolean(),
    requiredVerifierCastes: z.array(CasteIdSchema),
    deterministicChecks: z.array(TechnicalIdSchema),
    requiredEvidenceKinds: z.array(TechnicalIdSchema),
    acceptedVerdicts: z.array(VerdictSchema).min(1),
  })
  .strict();

export const EscalationConditionSchema = z
  .object({
    id: IdentifierSchema,
    trigger: z.string().min(1).max(4_096),
    destination: z.enum(["frontier", "human", "owner", "blocked"]),
  })
  .strict();

export const BlockerSchema = z
  .object({
    code: TechnicalIdSchema,
    message: z.string().min(1).max(8_192),
    evidenceIds: z.array(IdentifierSchema),
    retryable: z.boolean(),
  })
  .strict();

export const ModelIdentitySchema = z
  .object({
    provider: TechnicalIdSchema,
    model: IdentifierSchema,
    revision: IdentifierSchema,
    qualificationId: IdentifierSchema,
    invocationId: IdentifierSchema,
  })
  .strict();

export const OperationAttemptSchema = z
  .object({
    operationId: IdentifierSchema,
    idempotencyKey: IdentifierSchema,
    capabilityId: TechnicalIdSchema,
    status: z.enum(["requested", "denied", "completed", "failed", "unknown"]),
    receiptIds: z.array(IdentifierSchema),
  })
  .strict();

export function distinctValues(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

export function scopeKey(scope: ResourceScope): string {
  return `${scope.kind}\u0000${scope.selector}\u0000${scope.access}`;
}
