import { z } from "zod";
import { CompatibilityRequirementSchema } from "./compatibility";
import { canonicalJson, verifyContractDigest } from "./digest";
import {
  AutonomyLevelSchema,
  BudgetSchema,
  CasteIdSchema,
  DigestSchema,
  GenusSchema,
  ModelTierSchema,
  RiskClassSchema,
  SchemaReferenceSchema,
  SemverSchema,
  TechnicalIdSchema,
  VerificationPolicySchema,
  distinctValues,
} from "./primitives";

export const SpeciesProtocolIdSchema = z
  .string()
  .min(16)
  .max(180)
  .regex(
    /^eigengrid\.[a-z0-9]+(?:-[a-z0-9]+)*\/v[1-9]\d*$/u,
    "Expected an eigengrid.<species>/v<major> protocol identifier",
  );
export type SpeciesProtocolId = z.infer<typeof SpeciesProtocolIdSchema>;

export const SpeciesCoordinateSchema = z
  .object({
    id: SpeciesProtocolIdSchema,
    version: SemverSchema,
  })
  .strict()
  .superRefine((identity, context) => {
    const protocolMajor = Number(identity.id.slice(identity.id.lastIndexOf("/v") + 2));
    const versionMajor = Number(identity.version.split(".", 1)[0]);
    if (protocolMajor !== versionMajor) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Species protocol major must match exact contract version major",
        path: ["version"],
      });
    }
  });
export type SpeciesCoordinate = z.infer<typeof SpeciesCoordinateSchema>;

export const SpeciesIdentitySchema = z
  .object({
    schema: z.literal("eigengrid.species-identity.v1"),
    coordinate: SpeciesCoordinateSchema,
    contractDigest: DigestSchema,
  })
  .strict();
export type SpeciesIdentity = z.infer<typeof SpeciesIdentitySchema>;

export const CasteContractSchema = z
  .object({
    id: CasteIdSchema,
    required: z.boolean(),
    maxInstances: z.number().int().positive(),
    responsibilities: z.array(z.string().min(1).max(4_096)).min(1),
    allowedCapabilities: z.array(TechnicalIdSchema),
    prohibitedCapabilities: z.array(TechnicalIdSchema).min(1),
    stateReadScopes: z.array(z.string().min(1).max(2_048)),
    candidateWriteScopes: z.array(z.string().min(1).max(2_048)),
    allowedModelTiers: z.array(ModelTierSchema).min(1),
    providerPolicyIds: z.array(TechnicalIdSchema),
    contextSchema: SchemaReferenceSchema,
    resultSchema: SchemaReferenceSchema,
    ownership: z.array(z.string().min(1).max(2_048)),
    verificationDuties: z.array(z.string().min(1).max(4_096)),
    mayDelegate: z.boolean(),
    maximumChildDepth: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((caste, context) => {
    const allowed = new Set(caste.allowedCapabilities);
    const overlap = caste.prohibitedCapabilities.filter((capability) => allowed.has(capability));
    if (overlap.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Capabilities cannot be both allowed and prohibited: ${overlap.join(", ")}`,
        path: ["prohibitedCapabilities"],
      });
    }
    if (!distinctValues(caste.allowedCapabilities)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Allowed capabilities must be unique",
        path: ["allowedCapabilities"],
      });
    }
    if (!distinctValues(caste.prohibitedCapabilities)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Prohibited capabilities must be unique",
        path: ["prohibitedCapabilities"],
      });
    }
    if (!distinctValues(caste.allowedModelTiers)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Allowed model tiers must be unique",
        path: ["allowedModelTiers"],
      });
    }
    if (!caste.mayDelegate && caste.maximumChildDepth !== 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A non-delegating caste must have maximumChildDepth zero",
        path: ["maximumChildDepth"],
      });
    }
  });
export type CasteContract = z.infer<typeof CasteContractSchema>;

export const SpeciesContractSchema = z
  .object({
    schema: z.literal("eigengrid.species-contract.v1"),
    identity: SpeciesCoordinateSchema,
    genus: GenusSchema,
    displayName: z.string().min(1).max(200),
    aliases: z.array(z.string().min(1).max(200)),
    objectiveSchema: SchemaReferenceSchema,
    castes: z.array(CasteContractSchema).min(1),
    ownershipBoundaries: z.array(z.string().min(1).max(2_048)).min(1),
    capabilityAllowlist: z.array(TechnicalIdSchema),
    authority: z
      .object({
        stateReadScopes: z.array(z.string().min(1).max(2_048)),
        candidateWriteScopes: z.array(z.string().min(1).max(2_048)),
        explicitlyProhibited: z.array(z.string().min(1).max(2_048)).min(1),
      })
      .strict(),
    contextPolicy: z
      .object({
        maximumBytes: z.number().int().positive(),
        allowedTrustClasses: z.array(
          z.enum([
            "authoritative_state",
            "validated_skill",
            "external_evidence",
            "model_hypothesis",
            "untrusted_retrieved_text",
          ]),
        ),
        sensitiveExclusionsRequired: z.boolean(),
      })
      .strict(),
    memoryPolicy: z
      .object({
        readableScopes: z.array(TechnicalIdSchema),
        candidateWriteAllowed: z.boolean(),
        directPromotionAllowed: z.literal(false),
      })
      .strict(),
    skillPolicy: z
      .object({
        requiredSkillIds: z.array(TechnicalIdSchema),
        candidateWriteAllowed: z.boolean(),
        directPromotionAllowed: z.literal(false),
      })
      .strict(),
    evidencePolicy: z
      .object({
        requiredKinds: z.array(TechnicalIdSchema),
        contentDigestsRequired: z.boolean(),
        independentEvidenceRequired: z.boolean(),
      })
      .strict(),
    budgetPolicy: BudgetSchema,
    approvalPolicy: z
      .object({
        maximumAutonomy: AutonomyLevelSchema,
        approvalRequiredAtOrAboveRisk: RiskClassSchema,
        exactSubjectBindingRequired: z.literal(true),
      })
      .strict(),
    riskCeiling: RiskClassSchema,
    verificationTopology: VerificationPolicySchema,
    correctionTopology: z
      .object({
        maximumCorrections: z.number().int().nonnegative(),
        measurableProgressRequired: z.literal(true),
        preservedSuccessRequired: z.literal(true),
        independentReverificationRequired: z.boolean(),
      })
      .strict(),
    frontierEscalation: z
      .object({
        maximumCalls: z.number().int().nonnegative(),
        triggers: z.array(
          z.enum([
            "architectural_lock_in",
            "novel_scientific_decision",
            "critic_disagreement",
            "repeated_non_progress",
            "objective_change",
            "material_protocol_choice",
            "compatibility_risk",
            "production_qualification",
          ]),
        ),
        effectCapabilities: z.array(TechnicalIdSchema).length(0),
      })
      .strict(),
    terminationConditions: z.array(z.string().min(1).max(4_096)).min(1),
    failureSemantics: z.array(z.string().min(1).max(4_096)).min(1),
    supportedAutonomyLevels: z.array(AutonomyLevelSchema).min(1),
    compatibility: z.array(CompatibilityRequirementSchema).min(1),
    evaluationSuiteIds: z.array(TechnicalIdSchema).min(1),
    promotionStatus: z.enum([
      "unqualified",
      "shadow",
      "canary",
      "qualified",
      "preferred",
      "degraded",
      "quarantined",
      "retired",
    ]),
    contractDigest: DigestSchema,
  })
  .strict()
  .superRefine((species, context) => {
    const casteIds = species.castes.map((caste) => caste.id);
    if (!distinctValues(casteIds)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Caste IDs must be unique" });
    }
    if (!species.castes.some((caste) => caste.required)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A species must declare at least one required caste",
        path: ["castes"],
      });
    }
    if (!distinctValues(species.aliases)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Species aliases must be unique",
        path: ["aliases"],
      });
    }
    if (!distinctValues(species.supportedAutonomyLevels)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Supported autonomy levels must be unique",
        path: ["supportedAutonomyLevels"],
      });
    }
    if (!distinctValues(species.capabilityAllowlist)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Species capability allow-list entries must be unique",
        path: ["capabilityAllowlist"],
      });
    }
    const maximumAutonomy = Number(species.approvalPolicy.maximumAutonomy.slice(1));
    for (const [index, autonomy] of species.supportedAutonomyLevels.entries()) {
      if (Number(autonomy.slice(1)) > maximumAutonomy) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${autonomy} exceeds the species maximum autonomy ${species.approvalPolicy.maximumAutonomy}`,
          path: ["supportedAutonomyLevels", index],
        });
      }
    }
    if (species.correctionTopology.maximumCorrections > species.budgetPolicy.corrections) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Correction topology cannot exceed the correction budget",
        path: ["correctionTopology", "maximumCorrections"],
      });
    }
    if (species.frontierEscalation.maximumCalls > species.budgetPolicy.modelCalls) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Frontier calls cannot exceed the total model-call budget",
        path: ["frontierEscalation", "maximumCalls"],
      });
    }
    const declaredCapabilities = new Set(species.capabilityAllowlist);
    for (const [index, caste] of species.castes.entries()) {
      for (const capability of caste.allowedCapabilities) {
        if (!declaredCapabilities.has(capability)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Caste capability ${capability} is outside the species allow-list`,
            path: ["castes", index, "allowedCapabilities"],
          });
        }
      }
      const stateReadScopes = new Set(species.authority.stateReadScopes);
      for (const scope of caste.stateReadScopes) {
        if (!stateReadScopes.has(scope)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Caste read scope ${scope} is outside species authority`,
            path: ["castes", index, "stateReadScopes"],
          });
        }
      }
      const candidateWriteScopes = new Set(species.authority.candidateWriteScopes);
      for (const scope of caste.candidateWriteScopes) {
        if (!candidateWriteScopes.has(scope)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Caste candidate-write scope ${scope} is outside species authority`,
            path: ["castes", index, "candidateWriteScopes"],
          });
        }
      }
      if (
        caste.id === "verifier" &&
        (caste.candidateWriteScopes.length > 0 ||
          caste.allowedCapabilities.includes("candidate.write") ||
          !caste.prohibitedCapabilities.includes("candidate.write"))
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Verifier castes must explicitly prohibit candidate writes",
          path: ["castes", index],
        });
      }
    }
  });
export type SpeciesContract = z.infer<typeof SpeciesContractSchema>;

/** Bind the compact species identity carried on work to one exact sealed contract. */
export function validateSpeciesIdentityBinding(
  identityInput: unknown,
  contractInput: unknown,
): { identity: SpeciesIdentity; contract: SpeciesContract } {
  const identity = SpeciesIdentitySchema.parse(identityInput);
  const contract = SpeciesContractSchema.parse(contractInput);
  if (!verifyContractDigest(contract)) throw new TypeError("Species contract digest mismatch");
  if (canonicalJson(identity.coordinate) !== canonicalJson(contract.identity)) {
    throw new TypeError("Species identity coordinate does not match the species contract");
  }
  if (identity.contractDigest !== contract.contractDigest) {
    throw new TypeError("Species identity does not bind the exact species contract digest");
  }
  return { identity, contract };
}
