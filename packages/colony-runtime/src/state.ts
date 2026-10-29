import {
  AgentWorkOrderSchema,
  AgentWorkResultSchema,
  BaseIdentitySchema,
  CorrectionOrderSchema,
  DigestSchema,
  IdentifierSchema,
  SpeciesIdentitySchema,
  TimestampSchema,
  VerificationRequestSchema,
  VerificationResultSchema,
  canonicalJson,
  digestCanonical,
  verifyContractDigest,
  type AgentWorkOrder,
  type AgentWorkResult,
  type BaseIdentity,
  type CorrectionOrder,
  type Digest,
  type SpeciesIdentity,
  type VerificationRequest,
  type VerificationResult,
} from "@eigengrid/colony-contracts";
import { z } from "zod";
import {
  ColonyBudgetSchema,
  ColonyUsageSchema,
  ZERO_COLONY_USAGE,
  assertNestedBudgets,
  assertUsageWithin,
  contractBudgetToColonyBudget,
  type ColonyUsage,
} from "./budget";

export const CAMPAIGN_SCHEMA_ID = "eigengrid.colony-campaign.v1" as const;
export const CHECKPOINT_SCHEMA_ID = "eigengrid.colony-checkpoint-record.v1" as const;
export const CHECKPOINT_GENESIS_DIGEST = `sha256:${"0".repeat(64)}` as Digest;

export const CampaignStatusSchema = z.enum([
  "admitted",
  "active",
  "verifying",
  "correcting",
  "completed",
  "blocked",
  "cancelled",
]);
export type CampaignStatus = z.infer<typeof CampaignStatusSchema>;

export const WorkUnitStatusSchema = z.enum([
  "pending",
  "ready",
  "leased",
  "awaiting_verification",
  "correction_required",
  "correction_ready",
  "completed",
  "blocked",
  "cancelled",
]);
export type WorkUnitStatus = z.infer<typeof WorkUnitStatusSchema>;

export const CampaignWorkUnitSchema = z
  .object({
    id: IdentifierSchema,
    workOrder: AgentWorkOrderSchema,
    dependencies: z.array(IdentifierSchema),
    ownershipKey: z.string().min(1).max(2_048),
    budget: ColonyBudgetSchema,
    requiresIndependentVerification: z.literal(true),
  })
  .strict();
export type CampaignWorkUnit = z.infer<typeof CampaignWorkUnitSchema>;

function reaches(
  from: string,
  target: string,
  dependencies: ReadonlyMap<string, readonly string[]>,
  seen = new Set<string>(),
): boolean {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return (dependencies.get(from) ?? []).some((dependency) =>
    reaches(dependency, target, dependencies, seen),
  );
}

export const CampaignDefinitionShapeSchema = z
  .object({
    schema: z.literal(CAMPAIGN_SCHEMA_ID),
    campaignId: IdentifierSchema,
    objective: z.string().min(1).max(16_384),
    species: SpeciesIdentitySchema,
    baseIdentity: BaseIdentitySchema,
    createdAt: TimestampSchema,
    executionMode: z.enum(["shadow", "qualified"]),
    budget: ColonyBudgetSchema,
    maxCorrectionsPerUnit: z.number().int().nonnegative().max(2),
    leaseDurationMs: z.number().int().positive().safe(),
    maximumParallelism: z.number().int().positive().max(128),
    workUnits: z.array(CampaignWorkUnitSchema).min(1).max(128),
    definitionDigest: DigestSchema,
  })
  .strict()
  .superRefine((campaign, context) => {
    const unitIds = campaign.workUnits.map((unit) => unit.id);
    if (new Set(unitIds).size !== unitIds.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Work-unit IDs must be unique" });
    }
    const workOrderIds = campaign.workUnits.map((unit) => unit.workOrder.workOrderId);
    if (new Set(workOrderIds).size !== workOrderIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Work-order IDs must be unique inside a campaign",
      });
    }
    if (campaign.maximumParallelism > campaign.workUnits.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "maximumParallelism cannot exceed the finite work-unit count",
        path: ["maximumParallelism"],
      });
    }
    const idSet = new Set(unitIds);
    const dependencyMap = new Map(
      campaign.workUnits.map((unit) => [unit.id, unit.dependencies] as const),
    );
    for (const [unitIndex, unit] of campaign.workUnits.entries()) {
      if (new Set(unit.dependencies).size !== unit.dependencies.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Dependencies must be unique",
          path: ["workUnits", unitIndex, "dependencies"],
        });
      }
      for (const dependency of unit.dependencies) {
        if (!idSet.has(dependency)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Unknown work-unit dependency ${dependency}`,
            path: ["workUnits", unitIndex, "dependencies"],
          });
        }
        if (dependency === unit.id) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "A work unit cannot depend on itself",
            path: ["workUnits", unitIndex, "dependencies"],
          });
        }
      }
      if (!verifyContractDigest(unit.workOrder)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Work order canonical digest mismatch",
          path: ["workUnits", unitIndex, "workOrder", "workOrderDigest"],
        });
      }
      if (canonicalJson(unit.workOrder.species) !== canonicalJson(campaign.species)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Work-order species must match the campaign species",
          path: ["workUnits", unitIndex, "workOrder", "species"],
        });
      }
      if (canonicalJson(unit.workOrder.baseIdentity) !== canonicalJson(campaign.baseIdentity)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Work-order base identity must match the campaign base",
          path: ["workUnits", unitIndex, "workOrder", "baseIdentity"],
        });
      }
      if (
        !unit.workOrder.verificationRequirements.independent ||
        !unit.workOrder.verificationRequirements.requiredVerifierCastes.includes("verifier") ||
        !unit.workOrder.verificationRequirements.acceptedVerdicts.includes("pass")
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Every work unit requires an independent verifier and an explicit pass verdict",
          path: ["workUnits", unitIndex, "workOrder", "verificationRequirements"],
        });
      }
      try {
        assertUsageWithin(
          ColonyUsageSchema.parse(contractBudgetToColonyBudget(unit.workOrder.budget)),
          unit.budget,
          `work unit ${unit.id}`,
        );
      } catch (error) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: error instanceof Error ? error.message : String(error),
          path: ["workUnits", unitIndex, "budget"],
        });
      }
      if (campaign.maxCorrectionsPerUnit > unit.budget.corrections) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Per-unit correction allowance exceeds its nested budget",
          path: ["workUnits", unitIndex, "budget", "corrections"],
        });
      }
    }

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): boolean => {
      if (visiting.has(id)) return false;
      if (visited.has(id)) return true;
      visiting.add(id);
      for (const dependency of dependencyMap.get(id) ?? []) {
        if (!visit(dependency)) return false;
      }
      visiting.delete(id);
      visited.add(id);
      return true;
    };
    if (unitIds.some((id) => !visit(id))) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Campaign DAG contains a cycle" });
    }

    for (let leftIndex = 0; leftIndex < campaign.workUnits.length; leftIndex += 1) {
      const left = campaign.workUnits[leftIndex]!;
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < campaign.workUnits.length;
        rightIndex += 1
      ) {
        const right = campaign.workUnits[rightIndex]!;
        if (
          left.ownershipKey === right.ownershipKey &&
          !reaches(left.id, right.id, dependencyMap) &&
          !reaches(right.id, left.id, dependencyMap)
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Unordered work units ${left.id} and ${right.id} compete for one writer scope`,
            path: ["workUnits", rightIndex, "ownershipKey"],
          });
        }
      }
    }

    try {
      assertNestedBudgets(
        campaign.budget,
        campaign.workUnits.map((unit) => ({ id: unit.id, budget: unit.budget })),
      );
    } catch (error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : String(error),
        path: ["budget"],
      });
    }
  });
export type CampaignDefinition = z.infer<typeof CampaignDefinitionShapeSchema>;

function campaignUnsigned(definition: CampaignDefinition): Record<string, unknown> {
  const unsigned = { ...definition } as Record<string, unknown>;
  delete unsigned.definitionDigest;
  return unsigned;
}

export function sealCampaignDefinition(
  input: Omit<CampaignDefinition, "definitionDigest"> & { definitionDigest?: Digest },
): CampaignDefinition {
  const candidate = CampaignDefinitionShapeSchema.parse({
    ...input,
    definitionDigest: input.definitionDigest ?? CHECKPOINT_GENESIS_DIGEST,
  });
  return { ...candidate, definitionDigest: digestCanonical(campaignUnsigned(candidate)) };
}

export function parseCampaignDefinition(input: unknown): CampaignDefinition {
  const definition = CampaignDefinitionShapeSchema.parse(input);
  if (definition.definitionDigest !== digestCanonical(campaignUnsigned(definition))) {
    throw new TypeError("Campaign definition canonical digest mismatch");
  }
  return definition;
}

export const FencedLeaseSchema = z
  .object({
    leaseId: IdentifierSchema,
    unitId: IdentifierSchema,
    ownerId: IdentifierSchema,
    fencingToken: z.number().int().positive().safe(),
    acquiredAt: TimestampSchema,
    heartbeatAt: TimestampSchema,
    expiresAt: TimestampSchema,
    hardDeadline: TimestampSchema,
  })
  .strict();
export type FencedLease = z.infer<typeof FencedLeaseSchema>;

const EscalationSchema = z
  .object({
    unitId: IdentifierSchema,
    destination: z.enum(["frontier", "human", "owner", "blocked"]),
    reason: z.string().min(1).max(8_192),
  })
  .strict();

export const ColonyEventSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("campaign_admitted"), definition: CampaignDefinitionShapeSchema })
    .strict(),
  z.object({ type: z.literal("campaign_started") }).strict(),
  z
    .object({
      type: z.literal("lease_acquired"),
      unitId: IdentifierSchema,
      lease: FencedLeaseSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("lease_renewed"),
      unitId: IdentifierSchema,
      ownerId: IdentifierSchema,
      fencingToken: z.number().int().positive().safe(),
      heartbeatAt: TimestampSchema,
      expiresAt: TimestampSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("lease_expired"),
      unitId: IdentifierSchema,
      fencingToken: z.number().int().positive().safe(),
      reason: z.string().min(1).max(4_096),
    })
    .strict(),
  z
    .object({
      type: z.literal("result_accepted"),
      unitId: IdentifierSchema,
      fencingToken: z.number().int().positive().safe(),
      result: AgentWorkResultSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("result_duplicate"),
      unitId: IdentifierSchema,
      fencingToken: z.number().int().positive().safe(),
      resultDigest: DigestSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("result_stale"),
      unitId: IdentifierSchema,
      fencingToken: z.number().int().positive().safe(),
      resultDigest: DigestSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("result_conflict"),
      unitId: IdentifierSchema,
      fencingToken: z.number().int().positive().safe(),
      acceptedDigest: DigestSchema,
      conflictingDigest: DigestSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("verification_accepted"),
      unitId: IdentifierSchema,
      request: VerificationRequestSchema,
      result: VerificationResultSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("correction_issued"),
      unitId: IdentifierSchema,
      order: CorrectionOrderSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("frontier_usage_recorded"),
      unitId: IdentifierSchema,
      usage: ColonyUsageSchema,
    })
    .strict(),
  z.object({ type: z.literal("unit_escalated"), escalation: EscalationSchema }).strict(),
  z
    .object({
      type: z.literal("campaign_recovered"),
      expiredLeaseCount: z.number().int().nonnegative().safe(),
      tornTailRepaired: z.boolean(),
    })
    .strict(),
  z.object({ type: z.literal("campaign_completed") }).strict(),
  z
    .object({ type: z.literal("campaign_cancelled"), reason: z.string().min(1).max(4_096) })
    .strict(),
]);
export type ColonyEvent = z.infer<typeof ColonyEventSchema>;

export const CheckpointRecordSchema = z
  .object({
    schema: z.literal(CHECKPOINT_SCHEMA_ID),
    eventId: IdentifierSchema,
    campaignId: IdentifierSchema,
    sequence: z.number().int().positive().safe(),
    at: TimestampSchema,
    previousDigest: DigestSchema,
    event: ColonyEventSchema,
    recordDigest: DigestSchema,
  })
  .strict();
export type CheckpointRecord = z.infer<typeof CheckpointRecordSchema>;

export interface UnitRuntimeState {
  readonly definition: CampaignWorkUnit;
  status: WorkUnitStatus;
  lastFencingToken: number;
  activeLease?: FencedLease;
  acceptedFencingToken?: number;
  acceptedResult?: AgentWorkResult;
  verificationRequest?: VerificationRequest;
  verificationResult?: VerificationResult;
  corrections: CorrectionOrder[];
  usage: ColonyUsage;
  staleResultDigests: Digest[];
  duplicateResultDigests: Digest[];
  conflictingResultDigests: Digest[];
  escalation?: z.infer<typeof EscalationSchema>;
}

export interface CampaignSnapshot {
  definition: CampaignDefinition;
  status: CampaignStatus;
  sequence: number;
  lastRecordDigest: Digest;
  lastEventAt: string;
  units: Record<string, UnitRuntimeState>;
  usage: ColonyUsage;
  recoveryCount: number;
}

export function initialUnitState(definition: CampaignWorkUnit): UnitRuntimeState {
  return {
    definition,
    status: definition.dependencies.length === 0 ? "ready" : "pending",
    lastFencingToken: 0,
    corrections: [],
    usage: ColonyUsageSchema.parse(ZERO_COLONY_USAGE),
    staleResultDigests: [],
    duplicateResultDigests: [],
    conflictingResultDigests: [],
  };
}

export type { AgentWorkOrder, BaseIdentity, SpeciesIdentity };
