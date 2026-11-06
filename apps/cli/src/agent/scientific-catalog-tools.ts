import {
  installedScientificSkillRoot,
  type ScientificSkillRegistry,
  resolveScientificSkillGraph,
  type LoadedScientificSkill,
} from "@eigengrid/scientific-skills";
import {
  installedScientificRetrieval,
  skillKey,
  type CatalogSnapshot as AuthorizedSnapshot,
  type ScientificRetrievalService,
} from "@eigengrid/scientific-retrieval";
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
  authorized: AuthorizedSnapshot;
  retrieval: ScientificRetrievalService;
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
  const retrieval = installedScientificRetrieval(root);
  const authorized = retrieval.snapshot();
  if (
    cachedCatalog?.root === root &&
    cachedCatalog.authorized.revision === authorized.revision &&
    cachedCatalog.retrieval === retrieval
  )
    return cachedCatalog;
  const registry = authorized.registry;
  const protocolSkills = registry.all().filter((skill) => protocolAssets(skill).length > 0);
  cachedCatalog = {
    root,
    registry,
    authorized,
    retrieval,
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
  catalogRoot: z.string(),
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
            (
              await snapshot.retrieval.search({
                query: input.query,
                limit: 1000,
                candidateLimit: 1000,
              })
            ).hits.map((hit, index) => [skillKey(hit.skill.skillId, hit.skill.version), index]),
          )
        : undefined;
      if (snapshot.retrieval.snapshot().revision !== snapshot.authorized.revision)
        throw new Error("Scientific catalog changed during discovery; retry the search.");
      const domain = input.domain?.toLowerCase();
      const engine = input.engine?.toLowerCase();
      const matching = snapshot.protocolSkills.filter((skill) => {
        if (ranking && !ranking.has(skillKey(skill.manifest.id, skill.manifest.version)))
          return false;
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
          (left, right) =>
            ranking.get(skillKey(left.manifest.id, left.manifest.version))! -
            ranking.get(skillKey(right.manifest.id, right.manifest.version))!,
        );
      const protocols = matching.slice(0, input.limit ?? 20).map(protocolSummary);
      return {
        ok: true,
        data: {
          corpusDigest: snapshot.registry.corpusDigest,
          totalCapabilities: snapshot.registry.all().length,
          catalogRoot: snapshot.root,
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
  includeDependencies: z
    .boolean()
    .optional()
    .describe("Resolve required knowledge dependencies as exact versions; default false."),
  corpusDigest: z.string().optional().describe("Pin the corpus returned on the first page."),
  cursor: z
    .object({ fragment: z.number().int().nonnegative(), character: z.number().int().nonnegative() })
    .optional(),
  maxCharacters: z.number().int().min(1000).max(32000).optional(),
  assetKinds: z
    .array(
      z.enum([
        "summary",
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
    .max(8)
    .optional(),
});
const inspectProtocolOutput = z.object({
  catalogRoot: z.string(),
  corpusDigest: z.string(),
  resolvedSkills: z.array(
    z.object({ id: z.string(), version: z.string(), contentDigest: z.string() }),
  ),
  nextCursor: z.object({ fragment: z.number(), character: z.number() }).nullable(),
  totalFragments: z.number(),
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
      fragmentId: z.string(),
      characterOffset: z.number(),
      complete: z.boolean(),
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
    "Load versioned scientific procedures, inputs, decisions, diagnostics and validation. Set includeDependencies for required knowledge. Follow nextCursor with identical options and corpusDigest to read every page; digest identifies the full fragment, complete=false marks a chunk. Guidance does not grant execution authority.",
  inputSchema: inspectProtocolInput,
  outputSchema: inspectProtocolOutput,
  async execute(_ctx, input) {
    try {
      const snapshot = catalog();
      if (input.corpusDigest && input.corpusDigest !== snapshot.registry.corpusDigest) {
        throw new Error("Scientific corpus changed; restart inspection against its new digest.");
      }
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
      const skills = input.includeDependencies
        ? resolveScientificSkillGraph(snapshot.registry, {
            requested: [{ id: input.id, range: skill.manifest.version }],
          }).skills
        : [skill];
      // Root first, then deterministic dependency order. Never cut a procedure silently.
      skills.sort(
        (a, b) =>
          Number(b.manifest.id === input.id) - Number(a.manifest.id === input.id) ||
          a.manifest.id.localeCompare(b.manifest.id),
      );
      const allFragments = skills.flatMap((entry) =>
        snapshot.authorized.fragments.filter(
          (fragment) =>
            fragment.reference.skillId === entry.manifest.id &&
            fragment.reference.version === entry.manifest.version &&
            (input.assetKinds ?? ["protocols", "decision_rules", "validation", "diagnostics"]).some(
              (kind) => kind === fragment.assetKind,
            ),
        ),
      );
      let index = input.cursor?.fragment ?? 0;
      let character = input.cursor?.character ?? 0;
      if (
        index > allFragments.length ||
        (index === allFragments.length && character !== 0) ||
        (index < allFragments.length && character >= allFragments[index].content.length)
      )
        throw new Error("Invalid scientific fragment cursor");
      let remaining = input.maxCharacters ?? 16000;
      const fragments: z.infer<typeof inspectProtocolOutput>["fragments"] = [];
      while (index < allFragments.length && remaining > 0 && fragments.length < 40) {
        const fragment = allFragments[index];
        const content = fragment.content.slice(character, character + remaining);
        fragments.push({
          relativePath: fragment.reference.relativePath,
          fragmentId: fragment.reference.fragmentId,
          mediaType: fragment.mediaType,
          digest: fragment.reference.fragmentDigest,
          characterOffset: character,
          complete: character === 0 && content.length === fragment.content.length,
          content,
        });
        remaining -= content.length;
        character += content.length;
        if (character === fragment.content.length) {
          index++;
          character = 0;
        }
      }
      return {
        ok: true,
        data: {
          corpusDigest: snapshot.registry.corpusDigest,
          resolvedSkills: skills.map((entry) => ({
            id: entry.manifest.id,
            version: entry.manifest.version,
            contentDigest: entry.contentDigest,
          })),
          totalFragments: allFragments.length,
          catalogRoot: snapshot.root,
          nextCursor: index < allFragments.length ? { fragment: index, character } : null,
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
