import {
  installedScientificSkillRoot,
  loadScientificSkillCorpus,
  loadScientificSkillFragments,
  ScientificSkillRegistry,
  searchScientificSkills,
  type LoadedScientificSkill,
} from "@eigengrid/scientific-skills";
import type { Tool } from "@eigengrid/tool-registry";
import {
  MdWorkflowProtocolSchema,
  assertMdWorkflowProtocolDigest,
} from "@eigengrid/scientific-schema";
import { z } from "zod";

interface CatalogSnapshot {
  root: string;
  registry: ScientificSkillRegistry;
  protocolSkills: LoadedScientificSkill[];
  protocolAssetCount: number;
}

let cachedCatalog: CatalogSnapshot | undefined;

function catalogRoot(): string {
  return installedScientificSkillRoot();
}

function protocolAssets(skill: LoadedScientificSkill): string[] {
  return skill.files.filter((path) => path.startsWith("protocols/"));
}

function catalog(): CatalogSnapshot {
  const root = catalogRoot();
  if (cachedCatalog?.root === root) return cachedCatalog;
  const registry = new ScientificSkillRegistry(loadScientificSkillCorpus(root));
  const protocolSkills = registry.all().filter((skill) => protocolAssets(skill).length > 0);
  cachedCatalog = {
    root,
    registry,
    protocolSkills,
    protocolAssetCount: protocolSkills.reduce(
      (count, skill) => count + protocolAssets(skill).length,
      0,
    ),
  };
  return cachedCatalog;
}

function protocolSummary(skill: LoadedScientificSkill) {
  return {
    id: skill.manifest.id,
    version: skill.manifest.version,
    title: skill.manifest.title,
    status: skill.manifest.status,
    summary: skill.manifest.summary,
    domains: skill.manifest.domains,
    engines: Object.keys(skill.manifest.engine_compatibility).sort(),
    knowledgeLevel: skill.manifest.knowledge_level,
    reviewStatus: skill.manifest.review.status,
    capabilityLevels: skill.manifest.capability_levels,
    protocolAssets: protocolAssets(skill),
  };
}

const protocolSummarySchema = z.object({
  id: z.string(),
  version: z.string(),
  title: z.string(),
  status: z.string(),
  summary: z.string(),
  domains: z.array(z.string()),
  engines: z.array(z.string()),
  knowledgeLevel: z.string(),
  reviewStatus: z.string(),
  capabilityLevels: z.any(),
  protocolAssets: z.array(z.string()),
});

const listProtocolsInput = z.object({
  query: z
    .string()
    .max(240)
    .optional()
    .describe(
      "Short scientific terms or an exact protocol ID; common Spanish terms are supported. Omit for a catalog overview.",
    ),
  domain: z
    .string()
    .min(1)
    .max(80)
    .optional()
    .describe("Exact domain key from availableDomains; omit if unknown."),
  engine: z
    .string()
    .min(1)
    .max(80)
    .optional()
    .describe("Exact engine key from availableEngines; omit if unknown."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Maximum entries, default 20. Use up to 100 when matched exceeds returned."),
});
const listProtocolsOutput = z.object({
  corpusDigest: z.string(),
  totalCapabilities: z.number().int().nonnegative(),
  totalProtocolCapabilities: z.number().int().nonnegative(),
  totalProtocolAssets: z.number().int().nonnegative(),
  matched: z.number().int().nonnegative(),
  returned: z.number().int().nonnegative(),
  protocols: z.array(protocolSummarySchema),
  availableDomains: z.array(z.string()),
  availableEngines: z.array(z.string()),
  searchHint: z.string().optional(),
});

export const listProtocolsTool: Tool<
  z.infer<typeof listProtocolsInput>,
  z.infer<typeof listProtocolsOutput>
> = {
  name: "list-protocols",
  description:
    "Browse the installed scientific protocol catalog. For a general overview, call with no filters. Search short terms or an exact ID; empty filtered results include available filter keys and a recovery hint. Installed guidance does not authorize execution.",
  inputSchema: listProtocolsInput,
  outputSchema: listProtocolsOutput,
  async execute(_ctx, input) {
    try {
      const snapshot = catalog();
      const ranking = input.query?.trim()
        ? new Map(
            searchScientificSkills(snapshot.registry, input.query, { limit: 500 }).hits.map(
              (hit, index) => [hit.skill.skillId, index],
            ),
          )
        : undefined;
      const domain = input.domain?.toLowerCase();
      const engine = input.engine?.toLowerCase();
      const matching = snapshot.protocolSkills.filter((skill) => {
        if (ranking && !ranking.has(skill.manifest.id)) return false;
        if (domain && !skill.manifest.domains.some((item) => item.toLowerCase() === domain)) {
          return false;
        }
        if (
          engine &&
          !Object.keys(skill.manifest.engine_compatibility).some(
            (item) => item.toLowerCase() === engine,
          )
        ) {
          return false;
        }
        return true;
      });
      if (ranking)
        matching.sort(
          (left, right) => ranking.get(left.manifest.id)! - ranking.get(right.manifest.id)!,
        );
      const protocols = matching.slice(0, input.limit ?? 20).map(protocolSummary);
      return {
        ok: true,
        data: {
          corpusDigest: snapshot.registry.corpusDigest,
          totalCapabilities: snapshot.registry.all().length,
          totalProtocolCapabilities: snapshot.protocolSkills.length,
          totalProtocolAssets: snapshot.protocolAssetCount,
          matched: matching.length,
          returned: protocols.length,
          protocols,
          availableDomains: [
            ...new Set(snapshot.protocolSkills.flatMap((skill) => skill.manifest.domains)),
          ].sort(),
          availableEngines: [
            ...new Set(
              snapshot.protocolSkills.flatMap((skill) =>
                Object.keys(skill.manifest.engine_compatibility),
              ),
            ),
          ].sort(),
          ...(matching.length === 0
            ? {
                searchHint:
                  "No installed protocol matches these filters. Omit filters to browse the inventory, or use exact keys from availableDomains and availableEngines. Search short scientific terms or an exact protocol ID instead of repeating the unsuccessful query.",
              }
            : {}),
        },
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "SCIENTIFIC_CATALOG_ERROR",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  },
};

const inspectProtocolInput = z.object({
  id: z.string().min(3).max(160),
  version: z.string().min(1).max(40).optional(),
  assetKinds: z
    .array(
      z.enum([
        "protocols",
        "decision_rules",
        "validation",
        "diagnostics",
        "engine_mappings",
        "concepts",
        "references",
      ]),
    )
    .min(1)
    .max(7)
    .optional(),
});
const inspectProtocolOutput = z.object({
  protocol: protocolSummarySchema,
  requiredInputs: z.array(z.string()),
  missingInputBehavior: z.string(),
  requires: z.array(z.any()),
  recommends: z.array(z.any()),
  fragments: z.array(
    z.object({
      relativePath: z.string(),
      mediaType: z.string(),
      digest: z.string(),
      content: z.string(),
    }),
  ),
});

export const inspectProtocolTool: Tool<
  z.infer<typeof inspectProtocolInput>,
  z.infer<typeof inspectProtocolOutput>
> = {
  name: "inspect-protocol",
  description:
    "Inspect a scientific protocol, required inputs, decision rules, diagnostics and validation criteria with exact content digests. Guidance does not grant execution authority.",
  inputSchema: inspectProtocolInput,
  outputSchema: inspectProtocolOutput,
  async execute(_ctx, input) {
    try {
      const snapshot = catalog();
      const skill = input.version
        ? snapshot.registry.exact(input.id, input.version)
        : snapshot.registry.versions(input.id)[0];
      if (!skill || protocolAssets(skill).length === 0) {
        return {
          ok: false,
          error: {
            code: "PROTOCOL_NOT_FOUND",
            message: `Protocol '${input.id}'${input.version ? `@${input.version}` : ""} was not found`,
          },
        };
      }
      const fragments = loadScientificSkillFragments(skill, {
        assetKinds: input.assetKinds ?? [
          "protocols",
          "decision_rules",
          "validation",
          "diagnostics",
        ],
      }).map((fragment) => ({
        relativePath: fragment.reference.relativePath,
        mediaType: fragment.mediaType,
        digest: fragment.reference.fragmentDigest,
        content: fragment.content,
      }));
      return {
        ok: true,
        data: {
          protocol: protocolSummary(skill),
          requiredInputs: skill.manifest.required_inputs,
          missingInputBehavior: skill.manifest.missing_input_behavior,
          requires: skill.manifest.requires,
          recommends: skill.manifest.recommends,
          fragments,
        },
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "SCIENTIFIC_CATALOG_ERROR",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  },
};

const validateMdInput = z.object({ protocol: z.record(z.unknown()) }).strict();
const validateMdOutput = z.object({
  valid: z.boolean(),
  executionAuthorized: z.literal(false),
  protocolDigest: z.string().optional(),
  stageCount: z.number().int().nonnegative().optional(),
  issues: z.array(z.object({ path: z.string(), message: z.string() })),
});

export const validateMdProtocolTool: Tool<
  z.infer<typeof validateMdInput>,
  z.infer<typeof validateMdOutput>
> = {
  name: "validate-md-protocol",
  description:
    "Validate a supplied MD protocol against the canonical schema and its content digest, without executing, approving or changing anything. Reports structural errors; physical and site qualification require independent evidence.",
  inputSchema: validateMdInput,
  outputSchema: validateMdOutput,
  async execute(_ctx, input) {
    const parsed = MdWorkflowProtocolSchema.safeParse(input.protocol);
    if (!parsed.success)
      return {
        ok: true,
        data: {
          valid: false,
          executionAuthorized: false,
          issues: parsed.error.issues
            .slice(0, 20)
            .map((issue) => ({ path: issue.path.join("."), message: issue.message })),
        },
      };
    try {
      assertMdWorkflowProtocolDigest(parsed.data);
      return {
        ok: true,
        data: {
          valid: true,
          executionAuthorized: false,
          protocolDigest: parsed.data.protocolDigest,
          stageCount: parsed.data.stages.length,
          issues: [],
        },
      };
    } catch (error) {
      return {
        ok: true,
        data: {
          valid: false,
          executionAuthorized: false,
          issues: [
            {
              path: "protocolDigest",
              message: error instanceof Error ? error.message : String(error),
            },
          ],
        },
      };
    }
  },
};
