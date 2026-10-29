import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cli = resolve(import.meta.dir, "../../bin/eigengrid.ts");
const agentModule = resolve(import.meta.dir, "../../../../packages/agent/src/index.ts");
const runtimeModule = resolve(import.meta.dir, "../agent/create-agent-runtime.ts");
const actions = [
  { name: "operator-info", input: {} },
  { name: "list-protocols", input: { query: "zzqxvnevermatcheszz" } },
  { name: "list-protocols", input: { query: "optimización geometría", limit: 3 } },
  {
    name: "inspect-protocol",
    input: { id: "workflows.geometry-optimization", assetKinds: ["protocols"] },
  },
  { name: "list-protocols", input: { engine: "orca", limit: 3 } },
  { name: "list-protocols", input: { limit: 3 } },
  { name: "list-protocols", input: { query: "production", limit: 3 } },
];

for (const streamed of [false, true]) {
  test(`protocol discovery preserves observations and ends with a bounded answer (${streamed ? "streaming" : "CLI"})`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "eigengrid-protocol-answer-"));
    mkdirSync(join(directory, ".eigengrid"), { mode: 0o700 });
    let requests = 0,
      finalHadNoTools = false,
      emptyHadRecoveryHint = false,
      spanishMatched = false;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as {
          messages: { role: string; content: string }[];
          tools?: unknown[];
          stream?: boolean;
        };
        requests++;
        const previous = body.messages.filter((message) => message.role === "tool").at(-1);
        if (requests === 3) {
          const data = JSON.parse(previous!.content).result.data;
          emptyHadRecoveryHint =
            data.matched === 0 &&
            data.totalProtocolCapabilities === 15 &&
            data.availableEngines.includes("orca") &&
            typeof data.searchHint === "string";
        }
        if (requests === 4) spanishMatched = JSON.parse(previous!.content).result.data.matched > 0;
        const action = actions[requests - 1];
        if (!action) {
          finalHadNoTools =
            (body.tools?.length ?? 0) === 0 &&
            body.messages.some(
              (message) =>
                message.role === "system" && message.content.includes("Final response boundary"),
            ) &&
            body.messages.filter((message) => message.role === "tool").length === 7;
        }
        const tool = action
          ? {
              id: `protocol-call-${requests}`,
              type: "function",
              function: { name: action.name, arguments: JSON.stringify(action.input) },
            }
          : undefined;
        const text =
          "There are 15 installed protocols. Explore the catalog and choose one for your scientific objective.";
        if (!body.stream)
          return Response.json({
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: action ? null : text,
                  ...(tool ? { tool_calls: [tool] } : {}),
                },
                finish_reason: action ? "tool_calls" : "stop",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          });
        const chunk = (delta: unknown, finish: string | null) =>
          `data: ${JSON.stringify({ id: "fixture-response", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } } : {}) })}\n\n`;
        return new Response(
          chunk(
            {
              role: "assistant",
              ...(tool ? { tool_calls: [{ index: 0, ...tool }] } : { content: text }),
            },
            null,
          ) +
            chunk({}, action ? "tool_calls" : "stop") +
            "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
    try {
      writeFileSync(
        join(directory, ".eigengrid", "llm.json"),
        JSON.stringify({
          providerName: "protocol-fixture",
          model: "fixture",
          apiKey: "fixture-secret",
          baseUrl: `http://127.0.0.1:${server.port}/v1`,
          maxTokens: 512,
          costPerInputToken: 0,
          costPerOutputToken: 0,
        }),
        { mode: 0o600 },
      );
      const preload = join(directory, "offline.ts");
      writeFileSync(
        preload,
        `const upstream = fetch; globalThis.fetch = (input, init) => { const url = String(input); if (url === "https://models.dev/api.json") return Promise.resolve(Response.json({})); if (new URL(url).origin !== "http://127.0.0.1:${server.port}") throw new Error("Unexpected external request"); return upstream(input, init); };`,
      );
      const streamingEntry = join(directory, "stream.ts");
      writeFileSync(
        streamingEntry,
        `import { configureLlm, loadLlmConfig, runAgentStream, DEFAULT_OPERATOR_MAXIMUM_STEPS } from ${JSON.stringify(agentModule)};
import { createAgentRuntime } from ${JSON.stringify(runtimeModule)};
configureLlm(loadLlmConfig()!);
const runtime = await createAgentRuntime();
try {
  const events = [];
  for await (const event of runAgentStream({ prompt: "How can I browse and choose protocols?", tools: runtime.registry, ctx: runtime.ctx, memory: runtime.memory, permissionRules: runtime.permissionRules, approvalAuthority: runtime.approvalAuthority, maxSteps: DEFAULT_OPERATOR_MAXIMUM_STEPS, reserveFinalResponse: true })) events.push(event);
  const done = events.find(event => event.type === "done");
  console.log(JSON.stringify({ ok: !events.some(event => event.type === "error"), response: done?.fullText, toolCalls: done?.toolCalls }));
} finally { await runtime.close(); }`,
      );
      child = Bun.spawn(
        [
          process.execPath,
          "--preload",
          preload,
          ...(streamed
            ? [streamingEntry]
            : [cli, "agent", "How can I browse and choose protocols?", "--json"]),
        ],
        {
          cwd: directory,
          env: {
            ...process.env,
            EIGENGRID_DB_PROVIDER: "sqlite",
            EIGENGRID_DB_PATH: join(directory, "state.db"),
            EIGENGRID_PERMISSIONS_DIR: join(directory, "policy"),
          },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const timeout = setTimeout(() => child?.kill(), 10000);
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(code).toBe(0);
        expect(stderr).toBe("");
        expect(stdout).not.toContain("fixture-secret");
        const output = JSON.parse(stdout);
        expect(output.ok).toBe(true);
        expect(output.response).toContain("15 installed protocols");
        expect(output.toolCalls).toHaveLength(7);
        expect(requests).toBe(8);
        expect(finalHadNoTools).toBe(true);
        expect(emptyHadRecoveryHint).toBe(true);
        expect(spanishMatched).toBe(true);
      } finally {
        clearTimeout(timeout);
      }
    } finally {
      child?.kill();
      if (child) await child.exited;
      await server.stop(true);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 12000);
}
