import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../../bin/eigengrid.ts", import.meta.url));

async function runConfiguredCommand(failProvider: boolean) {
  const directory = mkdtempSync(join(tmpdir(), "eigengrid-agent-command-"));
  const observed: { body: Record<string, unknown>; authorization: string | null }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>;
      observed.push({ body, authorization: request.headers.get("authorization") });
      if (failProvider)
        return Response.json(
          { error: { message: "Fixture provider denied access" } },
          { status: 401 },
        );
      const message =
        observed.length === 1
          ? {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "configured-operator-call",
                  type: "function",
                  function: { name: "operator-info", arguments: "{}" },
                },
              ],
            }
          : { role: "assistant", content: "Configured provider and observed tool result." };
      return Response.json({
        choices: [
          { index: 0, message, finish_reason: observed.length === 1 ? "tool_calls" : "stop" },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      });
    },
  });
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  try {
    mkdirSync(join(directory, ".eigengrid"), { mode: 0o700 });
    writeFileSync(
      join(directory, ".eigengrid", "llm.json"),
      JSON.stringify({
        providerName: "configured-fixture",
        model: "fixture-operator",
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        apiKey: "fixture-private-key",
        maxTokens: 256,
        costPerInputToken: 0,
        costPerOutputToken: 0,
      }),
      { mode: 0o600 },
    );
    const preload = join(directory, "offline-catalog.ts");
    writeFileSync(
      preload,
      `const upstream = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = String(input);
  if (url === "https://models.dev/api.json") return Promise.resolve(Response.json({}));
  if (new URL(url).origin !== "http://127.0.0.1:${server.port}") throw new Error("Unexpected outbound request");
  return upstream(input, init);
};`,
    );
    child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        preload,
        cli,
        "agent",
        "Inspect configured operator identity",
        "--json",
      ],
      {
        cwd: directory,
        env: {
          ...process.env,
          EIGENGRID_DB_PROVIDER: "sqlite",
          EIGENGRID_DB_PATH: join(directory, "state.db"),
          LLM_API_KEY: "",
          OPENCODE_API_KEY: "",
          OPENAI_API_KEY: "",
          ANTHROPIC_API_KEY: "",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const deadline = setTimeout(() => child?.kill(), 8_000);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(stderr).toBe("");
      expect(stdout).not.toContain("fixture-private-key");
      return { output: JSON.parse(stdout), exitCode, observed };
    } finally {
      clearTimeout(deadline);
    }
  } finally {
    child?.kill();
    if (child) await child.exited;
    await server.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("configured agent CLI", () => {
  test("loads the private project provider and interprets a real tool observation", async () => {
    const { output, exitCode, observed } = await runConfiguredCommand(false);
    expect(exitCode).toBe(0);
    expect(output.ok).toBe(true);
    expect(observed).toHaveLength(2);
    expect(observed[0]!.authorization).toBe("Bearer fixture-private-key");
    expect(observed[0]!.body.model).toBe("fixture-operator");
    expect(output.toolCalls[0].tool).toBe("operator-info");
    const tools = observed[1]!.body.messages as { role: string; content: string }[];
    const observation = JSON.parse(tools.find((message) => message.role === "tool")!.content);
    expect(observation.result.data.provider.id).toBe("configured-fixture");
    expect(observation.result.data.provider.model).toBe("fixture-operator");
  }, 10_000);

  test("reports a provider rejection as a failed command without leaking the key", async () => {
    const { output, exitCode, observed } = await runConfiguredCommand(true);
    expect(exitCode).toBe(1);
    expect(output.ok).toBe(false);
    expect(output.toolCalls).toBeUndefined();
    expect(observed).toHaveLength(1);
  }, 10_000);
});
