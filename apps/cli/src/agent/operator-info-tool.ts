import { getLlmConfig, DEFAULT_OPERATOR_MAXIMUM_STEPS } from "@eigengrid/agent";
import type { Tool, ToolRegistry } from "@eigengrid/tool-registry";
import { z } from "zod";
import { SlashCommands } from "../tui/slash-commands";
import { loadOperatorPermissions } from "../services/operator-permission-store";
import { permissionPreset } from "@eigengrid/agent/execution-permissions";

const operatorInfoInput = z.object({}).describe("No input required");
const operatorInfoOutput = z.object({
  agent: z.object({
    engine: z.literal("eigengrid-native"),
    loop: z.literal("bounded-tool-loop"),
    durableMissionRuntime: z.boolean(),
    codexCoupled: z.boolean(),
    defaultMaximumToolSteps: z.number().int().positive(),
  }),
  provider: z.object({
    id: z.string(),
    endpoint: z.string(),
    model: z.string(),
    temperature: z.number(),
    apiKeyConfigured: z.boolean(),
  }),
  tools: z.object({
    executable: z.array(z.string()),
    approvalRequired: z.array(z.string()),
  }),
  permissions: z.object({
    preset: z.string(),
    name: z.string(),
    approvalPolicy: z.string(),
    executionScope: z.string(),
  }),
  slashCommands: z.array(z.object({ name: z.string(), description: z.string() })),
});

export function createOperatorInfoTool(
  registry: ToolRegistry,
): Tool<z.infer<typeof operatorInfoInput>, z.infer<typeof operatorInfoOutput>> {
  return {
    name: "operator-info",
    description:
      "Inspect EigenGrid Operator identity, provider/model, native agent architecture, registered tools, and supported slash commands",
    inputSchema: operatorInfoInput,
    outputSchema: operatorInfoOutput,
    async execute() {
      const config = getLlmConfig();
      const materialized = registry.materialize();
      const permissions = permissionPreset(loadOperatorPermissions().preset);
      return {
        ok: true,
        data: {
          agent: {
            engine: "eigengrid-native",
            loop: "bounded-tool-loop",
            durableMissionRuntime: false,
            codexCoupled: false,
            defaultMaximumToolSteps: DEFAULT_OPERATOR_MAXIMUM_STEPS,
          },
          provider: {
            id: config.providerName ?? "eigengrid-llm",
            endpoint: config.baseUrl,
            model: config.model,
            temperature: config.temperature ?? 0.7,
            apiKeyConfigured: Boolean(
              config.apiKey ||
              process.env.LLM_API_KEY ||
              process.env.OPENCODE_API_KEY ||
              process.env.OPENAI_API_KEY ||
              process.env.ANTHROPIC_API_KEY,
            ),
          },
          tools: {
            executable: materialized.definitions.map((tool) => tool.name).sort(),
            approvalRequired: materialized.approvalRequiredDefinitions
              .map((tool) => tool.name)
              .sort(),
          },
          permissions: {
            preset: permissions.id,
            name: permissions.name,
            approvalPolicy: permissions.approvalPolicy,
            executionScope: permissions.executionScope,
          },
          slashCommands: [...SlashCommands].map(([name, description]) => ({
            name: `/${name}`,
            description,
          })),
        },
      };
    },
  };
}
