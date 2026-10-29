import type { CommandModule } from "yargs";
import {
  runAgent,
  configureLlm,
  loadLlmConfig,
  DEFAULT_OPERATOR_MAXIMUM_STEPS,
} from "@eigengrid/agent";
import { createAgentRuntime } from "../agent/create-agent-runtime";
import { diagnoseCommand } from "./diagnose";
import { approveCommand } from "./approve";
import { executeCommand } from "./execute";

export const agentCommand: CommandModule = {
  command: "agent [prompt]",
  describe: "Run EigenGrid AI agent",
  builder: (y) =>
    y
      .command({ ...diagnoseCommand, command: "diagnose <job-id>" })
      .command({ ...approveCommand, command: "approve <proposal-id>" })
      .command({ ...executeCommand, command: "execute <proposal-id>" })
      .positional("prompt", { describe: "Natural language request", type: "string" })
      .option("json", { describe: "Output as JSON", type: "boolean", default: false })
      .option("max-steps", {
        describe: "Max inference rounds, including a reserved final answer",
        type: "number",
        default: DEFAULT_OPERATOR_MAXIMUM_STEPS,
      })
      .option("allow-actions", {
        describe: "Unavailable in chat; use agent-session for durable per-call approval",
        type: "boolean",
        default: false,
      }),
  async handler(argv) {
    const {
      prompt,
      json,
      "max-steps": maxSteps,
      "allow-actions": allowActions,
    } = argv as unknown as {
      prompt?: string;
      json: boolean;
      "max-steps": number;
      "allow-actions": boolean;
    };

    if (!prompt) {
      console.log("Usage: eigengrid agent <prompt>");
      console.log('  eigengrid agent "list all running jobs"');
      console.log('  eigengrid agent "run doctor" --json');
      return;
    }

    const saved = loadLlmConfig();
    if (saved) configureLlm(saved);
    const runtime = await createAgentRuntime({ allowActions });

    try {
      const result = await runAgent({
        prompt,
        tools: runtime.registry,
        ctx: runtime.ctx,
        memory: runtime.memory,
        maxSteps,
        reserveFinalResponse: true,
        permissionRules: runtime.permissionRules,
        approvalAuthority: runtime.approvalAuthority,
      });

      if (json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log("\n" + result.response + "\n");
        if (result.toolCalls && result.toolCalls.length > 0) {
          console.log(`Tools called: ${result.toolCalls.map((t) => t.tool).join(", ")}`);
        }
      }
      if (!result.ok) process.exitCode = 1;
    } finally {
      await runtime.close();
    }
  },
};
