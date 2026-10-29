import { z } from "zod";
import type { Tool } from "../types";

const inspectNodeInput = z.object({
  nodeId: z.string().describe("Compute node ID to inspect"),
});

const inspectNodeOutput = z.object({
  ok: z.boolean(),
  node: z.any().optional(),
  message: z.string().optional(),
});

export const inspectNodeTool: Tool<
  z.infer<typeof inspectNodeInput>,
  z.infer<typeof inspectNodeOutput>
> = {
  name: "inspect-node",
  description: "Inspect the status and configuration of a compute node",
  inputSchema: inspectNodeInput,
  outputSchema: inspectNodeOutput,
  async execute(ctx, input) {
    try {
      const node = await ctx.db.getNode(input.nodeId);
      if (!node) {
        return {
          ok: false,
          error: {
            code: "NODE_NOT_FOUND",
            message: `Node '${input.nodeId}' not found.`,
            hint: "Use 'list-nodes' to see available nodes.",
          },
        };
      }

      return {
        ok: true,
        data: {
          ok: true,
          node: node,
          message: `Node ${input.nodeId}: ${node.status ?? "unknown"} (${node.host ?? "?"})`,
        },
      };
    } catch (err) {
      return {
        ok: false,
        error: {
          code: "INSPECT_ERROR",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  },
};
