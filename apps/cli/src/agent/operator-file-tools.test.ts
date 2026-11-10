import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { canonicalAgentJson } from "@eigengrid/agent-runtime";
import { runAgent, type AgentInput } from "@eigengrid/agent";
import { ToolRegistry, type ToolContext } from "@eigengrid/tool-registry";
import { runCommandTool } from "./operator-file-tools";

const ctx = {} as ToolContext;
const missingExecutable = `eigengrid-missing-renderer-${randomUUID()}`;

function registry() {
  const tools = new ToolRegistry([{ action: "*", resource: "*", effect: "allow" }]);
  tools.register(runCommandTool);
  return tools;
}

describe("operator command observations", () => {
  test("missing executable is a serializable failure with its diagnostic", async () => {
    const result = await registry().settleAuthorized(
      { id: "missing", name: "run-command", input: { command: missingExecutable } },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("COMMAND_UNAVAILABLE");
    expect(result.error?.message).toContain(missingExecutable);
    expect(JSON.parse(result.error!.hint!)).toMatchObject({ exitCode: null, timedOut: false });
    expect(() => canonicalAgentJson(result)).not.toThrow();
  });

  test("nonzero exit preserves stdout and stderr for the next model step", async () => {
    const result = await runCommandTool.execute(ctx, {
      command: process.execPath,
      args: [
        "-e",
        'console.log("partial output"); console.error("missing plotting library"); process.exit(7)',
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("COMMAND_FAILED");
    expect(JSON.parse(result.error!.hint!)).toMatchObject({
      exitCode: 7,
      stdout: "partial output\n",
      stderr: "missing plotting library\n",
    });
    expect(() => canonicalAgentJson(result)).not.toThrow();
  });

  test("timeouts and signals remain known failures without inventing an exit code", async () => {
    for (const timedOut of [true, false]) {
      const result = await runCommandTool.execute(ctx, {
        command: process.execPath,
        args: [
          "-e",
          timedOut ? "setInterval(() => {}, 1000)" : 'process.kill(process.pid, "SIGTERM")',
        ],
        timeoutMs: timedOut ? 100 : 5000,
      });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe(timedOut ? "COMMAND_TIMEOUT" : "COMMAND_SIGNALLED");
      expect(result.error?.message).toContain("partial effects");
      expect(JSON.parse(result.error!.hint!).exitCode).toBeNull();
      expect(() => canonicalAgentJson(result)).not.toThrow();
    }
  });

  test("agent receives a missing renderer diagnostic and completes using an available executable", async () => {
    const requests: unknown[] = [];
    const events: unknown[] = [];
    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    };
    const model = {
      specificationVersion: "v3",
      provider: "test",
      modelId: "command-recovery",
      supportedUrls: {},
      async doGenerate(request: unknown) {
        requests.push(request);
        const round = requests.length;
        const content =
          round < 3
            ? [
                {
                  type: "tool-call",
                  toolCallId: `render-${round}`,
                  toolName: "run-command",
                  input: JSON.stringify(
                    round === 1
                      ? { command: missingExecutable }
                      : {
                          command: process.execPath,
                          args: ["-e", 'console.log("renderer available")'],
                        },
                  ),
                },
              ]
            : [{ type: "text", text: "An available renderer was verified." }];
        return {
          content,
          finishReason: { unified: round < 3 ? "tool-calls" : "stop", raw: "stop" },
          usage,
          warnings: [],
        };
      },
    } as unknown as NonNullable<AgentInput["model"]>;
    const result = await runAgent({
      prompt: "Check available renderers",
      ctx,
      tools: registry(),
      model,
      maxSteps: 3,
      onToolEvent: (event) => {
        events.push(event);
      },
    });
    expect(result.ok).toBe(true);
    expect(result.response).toBe("An available renderer was verified.");
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests[1])).toContain("COMMAND_UNAVAILABLE");
    expect(JSON.stringify(requests[2])).toContain("renderer available");
    expect(result.toolCalls).toHaveLength(2);
    expect(events).toContainEqual(expect.objectContaining({ type: "tool-result", ok: false }));
    expect(events).toContainEqual(expect.objectContaining({ type: "tool-result", ok: true }));
  });
});
