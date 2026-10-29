import { tool as aiTool, jsonSchema } from "ai";
import type { ToolContext, Materialization } from "@eigengrid/tool-registry";
import { randomUUID } from "node:crypto";

type AiToolDefinition = ReturnType<typeof aiTool>;

export function adaptMaterializedToolsForAI(
  materialized: Materialization,
  ctx: ToolContext,
): Record<string, AiToolDefinition> {
  const adapted: Record<string, AiToolDefinition> = {};

  for (const def of materialized.definitions) {
    // aiTool is the only SDK boundary here; application input remains unknown
    // until ToolRegistry.settle performs its schema validation.
    const createAiTool = aiTool as unknown as (definition: {
      description: string;
      inputSchema: ReturnType<typeof jsonSchema>;
      execute: (input: unknown) => Promise<unknown>;
    }) => AiToolDefinition;
    adapted[def.name] = createAiTool({
      description: def.description,
      inputSchema: jsonSchema(def.inputSchema),
      execute: async (input: unknown) => {
        try {
          const settlement = await materialized.settle(
            {
              name: def.name,
              input,
              id: randomUUID(),
            },
            ctx,
          );
          if (settlement.ok) {
            return { ok: true, data: settlement.output, content: settlement.content };
          }
          return {
            ok: false,
            error: settlement.error ?? { code: "SETTLEMENT_ERROR", message: "Tool call failed" },
          };
        } catch (err) {
          return {
            ok: false,
            error: {
              code: "EXECUTION_ERROR",
              message: err instanceof Error ? err.message : String(err),
            },
          };
        }
      },
    });
  }

  return adapted;
}
