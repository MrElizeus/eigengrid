import { appendFileSync } from "node:fs";
import { AgentSessionService } from "../../apps/cli/src/services/agent-sessions";

// Subprocess-only synthetic authority; this file is never imported by application composition.
const [root, sessionId, mode, marker] = process.argv.slice(2);
if (!root || !sessionId || !marker) throw new Error("Missing fixture arguments");
const principal = {
  actorId: "scientist-a",
  projectId: "project-a",
  missionId: "mission-one",
  policyDigest: "1".repeat(64),
};
const service = new AgentSessionService(
  root,
  {
    current: async () => principal,
    assertCurrent: async () => {},
  },
  {
    infer: async () => ({
      text: "complete",
      calls: [],
      provider: "process-fixture",
      usage: { inputTokens: 1, outputTokens: 1, cost: 0.001 },
    }),
  },
  {
    tools: {
      describe: () => [
        {
          name: "mission-start",
          description: "Synthetic process fixture",
          inputSchema: { type: "object" },
        },
      ],
      decide: async () => "ask",
      execute: async (call) => {
        appendFileSync(marker, call.id + "\n", { mode: 0o600 });
        if (mode === "kill") process.kill(process.pid, "SIGKILL");
        return {
          id: call.id,
          tool: call.name,
          ok: true,
          result: { receipt: "process-fixture-only" },
        };
      },
    },
    observeUncertain: async () => ({ status: "UNKNOWN" }),
  },
  () => 10_000,
);
await service.resume(sessionId);
