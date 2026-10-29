import { z } from "zod";
import type { Tool } from "../types";

const listNodesInput = z.object({}).describe("No input required");

const listNodesOutput = z.object({
  nodes: z.array(z.any()),
  total: z.number(),
});

export const listNodesTool: Tool<
  z.infer<typeof listNodesInput>,
  z.infer<typeof listNodesOutput>
> = {
  name: "list-nodes",
  description: "List all configured compute nodes and their status",
  inputSchema: listNodesInput,
  outputSchema: listNodesOutput,
  async execute(ctx, _input) {
    try {
      const nodes = await ctx.db.listNodes();

      return {
        ok: true,
        data: {
          nodes,
          total: nodes.length,
        },
      };
    } catch (err) {
      return {
        ok: false,
        error: {
          code: "LIST_ERROR",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  },
};
