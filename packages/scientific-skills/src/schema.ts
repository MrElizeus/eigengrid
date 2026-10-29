import { z } from "zod";
import {
  CapabilityMaturitySchema,
  DigestSchema,
  KnowledgeMaturitySchema,
  SemverSchema,
} from "@eigengrid/scientific-schema";

export const ScientificSkillSchemaVersion = "eigengrid.scientific-skill/v1" as const;

export const ScientificSkillIdSchema = z
  .string()
  .min(3)
  .max(160)
  .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u, "Expected a stable dotted lower-case skill id");

export const SkillDependencySchema = z
  .object({
    id: ScientificSkillIdSchema,
    range: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();

export const SkillConflictSchema = z
  .object({
    id: ScientificSkillIdSchema,
    range: z.string().min(1).default("*"),
    when: z.string().min(1).optional(),
    reason: z.string().min(1),
  })
  .strict();

const EngineRangeMapSchema = z.record(z.string().min(1), z.string().min(1));
const EngineBooleanMapSchema = z.record(z.string().min(1), z.boolean());

export const SkillCapabilityLevelsSchema = z
  .object({
    reference: z.literal(true),
    advisory: z.boolean(),
    plannable: z.boolean(),
    renderable: EngineRangeMapSchema.default({}),
    executable: EngineRangeMapSchema.default({}),
    validated: EngineBooleanMapSchema.default({}),
  })
  .strict();

const RelativeAssetPathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.split(/[\\/]/u).includes("..") &&
      !value.includes("\\") &&
      value !== ".",
    "Asset paths must be repository-relative and may not traverse directories",
  );

export const ScientificSkillManifestSchema = z
  .object({
    schema: z.literal(ScientificSkillSchemaVersion),
    id: ScientificSkillIdSchema,
    version: SemverSchema,
    title: z.string().min(3),
    status: z.enum(["active", "deprecated", "withdrawn"]),
    summary: z.string().min(20),
    knowledge_level: KnowledgeMaturitySchema,
    capability_levels: SkillCapabilityLevelsSchema,
    domains: z.array(z.string().min(1)).min(1),
    domain_maturity: z.record(z.string().min(1), CapabilityMaturitySchema),
    engine_compatibility: EngineRangeMapSchema.default({}),
    requires: z.array(SkillDependencySchema).default([]),
    recommends: z.array(SkillDependencySchema).default([]),
    conflicts: z.array(SkillConflictSchema).default([]),
    required_inputs: z.array(z.string().min(1)).default([]),
    missing_input_behavior: z.string().min(10),
    assets: z.record(z.string().min(1), RelativeAssetPathSchema),
    helpers: z
      .array(
        z
          .object({
            id: z.string().min(1),
            path: RelativeAssetPathSchema,
            digest: DigestSchema,
            interface: z.literal("eigengrid.deterministic-helper/v1"),
          })
          .strict(),
      )
      .default([]),
    review: z
      .object({
        status: z.enum(["unreviewed", "reference_checked", "expert_reviewed"]),
        owner_role: z.string().min(1),
        last_reviewed: z.string().date().optional(),
        review_before: z.string().date().optional(),
        evidence_ids: z.array(z.string().min(1)).default([]),
        notes: z.string().min(1),
      })
      .strict(),
    provenance: z
      .object({
        created_by: z.enum(["human", "model", "human-and-model"]),
        source_commit: z.string().min(7).optional(),
        content_digest: DigestSchema.optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, context) => {
    const domains = new Set(manifest.domains);
    for (const domain of Object.keys(manifest.domain_maturity)) {
      if (!domains.has(domain)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["domain_maturity", domain],
          message: `Domain maturity is declared for unlisted domain ${domain}`,
        });
      }
    }
    for (const dependency of [...manifest.requires, ...manifest.recommends]) {
      if (dependency.id === manifest.id) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["requires"],
          message: "A skill may not depend on itself",
        });
      }
    }
  });

export type ScientificSkillManifest = z.infer<typeof ScientificSkillManifestSchema>;

export const SkillMarkdownFrontmatterSchema = z
  .object({
    name: z.string().min(2),
    id: ScientificSkillIdSchema,
    description: z.string().min(20),
    version: SemverSchema,
  })
  .passthrough();

export type SkillMarkdownFrontmatter = z.infer<typeof SkillMarkdownFrontmatterSchema>;

export const TriggerEvaluationCaseSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["positive", "negative", "ambiguous", "planning", "rendering", "diagnostic"]),
    query: z.string().min(1),
    expected_included: z.array(ScientificSkillIdSchema).default([]),
    expected_excluded: z.array(ScientificSkillIdSchema).default([]),
    expected_top: ScientificSkillIdSchema.nullable().optional(),
  })
  .strict();
export type TriggerEvaluationCase = z.infer<typeof TriggerEvaluationCaseSchema>;

export const CompositionEvaluationCaseSchema = z
  .object({
    id: z.string().min(1),
    requested: z.array(ScientificSkillIdSchema).min(1),
    include_optional: z.boolean().default(false),
    expected_nodes: z.array(ScientificSkillIdSchema).min(1),
    expected_absent: z.array(ScientificSkillIdSchema).default([]),
    engine: z
      .object({ id: z.string().min(1), version: SemverSchema })
      .strict()
      .optional(),
    domains: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type CompositionEvaluationCase = z.infer<typeof CompositionEvaluationCaseSchema>;
