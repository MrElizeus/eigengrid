import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Exercise the actual command/runtime with an isolated project and a local provider;
// no external inference, user credentials, or scientific effects are involved.
test("web command completes a real native tool round trip and restores a conversation after restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eigengrid-web-command-"));
  let providerCalls = 0;
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.json();
      expect(body.model).toBe("web-fixture");
      providerCalls++;
      const delta =
        providerCalls === 1
          ? {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "web-operator-call",
                  type: "function",
                  function: { name: "operator-info", arguments: "{}" },
                },
              ],
            }
          : { role: "assistant", content: "El agente nativo está conectado." };
      const chunks = [
        { choices: [{ index: 0, delta, finish_reason: null }] },
        {
          choices: [
            { index: 0, delta: {}, finish_reason: providerCalls === 1 ? "tool_calls" : "stop" },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        },
      ];
      return new Response(
        chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  const deadline = setTimeout(() => child?.kill(), 12000);
  try {
    mkdirSync(join(dir, ".eigengrid"), { mode: 0o700 });
    writeFileSync(
      join(dir, ".eigengrid/llm.json"),
      JSON.stringify({
        model: "web-fixture",
        baseUrl: `${provider.url.origin}/v1`,
        apiKey: "web-test-private-key",
        providerName: "fixture",
        costPerInputToken: 0,
        costPerOutputToken: 0,
      }),
      { mode: 0o600 },
    );
    const preload = join(dir, "offline.ts");
    writeFileSync(
      preload,
      `const upstream = globalThis.fetch; globalThis.fetch = (input, init) => { const url = String(input); if (url === "https://models.dev/api.json") return Promise.resolve(Response.json({})); if (new URL(url).origin !== ${JSON.stringify(provider.url.origin)}) throw new Error("Unexpected outbound request"); return upstream(input, init); };`,
    );
    async function start() {
      child = Bun.spawn(
        [
          process.execPath,
          "--preload",
          preload,
          new URL("../../bin/eigengrid.ts", import.meta.url).pathname,
          "web",
          "--no-open",
          "--port",
          "0",
        ],
        {
          cwd: dir,
          env: {
            ...process.env,
            EIGENGRID_DB_PROVIDER: "sqlite",
            EIGENGRID_DB_PATH: join(dir, "project.db"),
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
      const reader = child.stdout.getReader();
      let output = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) throw new Error("Web command exited before startup");
        output += new TextDecoder().decode(value);
        const match = output.match(/(http:\/\/127\.0\.0\.1:\d+)\/(?:#setup=(\S+))?/);
        if (match) {
          reader.releaseLock();
          const [, origin, code] = match;
          const html = await (await fetch(origin!)).text();
          const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map(
            (item) => item[1]!,
          );
          expect(assets.length).toBeGreaterThanOrEqual(2);
          for (const path of assets) {
            const asset = await fetch(new URL(path, origin));
            expect(asset.status).toBe(200);
            expect(asset.headers.get("content-type")).toContain(
              path.endsWith(".css") ? "text/css" : "javascript",
            );
          }
          const auth = await fetch(`${origin}/api/auth/${code ? "setup" : "login"}`, {
            method: "POST",
            headers: { Origin: origin!, "Content-Type": "application/json" },
            body: JSON.stringify({ code, username: "operator", password: "web-test-password" }),
          });
          expect(auth.status).toBe(200);
          const cookie = auth.headers.get("set-cookie")!.split(";")[0]!;
          return (path: string, method = "GET", data?: unknown) =>
            fetch(`${origin}/api${path}`, {
              method,
              headers: {
                Cookie: cookie,
                Origin: origin!,
                "Content-Type": "application/json",
              },
              ...(method !== "GET" && data !== undefined ? { body: JSON.stringify(data) } : {}),
            });
        }
      }
    }
    let request = await start();
    const chat = await (await request("/chats", "POST", {})).json();
    const result = await (
      await request(`/chats/${chat.id}/messages`, "POST", { prompt: "Inspect operator identity" })
    ).text();
    expect(result).not.toContain("web-test-private-key");
    const events = result
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      events.some(
        (event) => event.type === "tool-result" && event.name === "operator-info" && event.ok,
      ),
    ).toBe(true);
    expect(events.at(-1).chat.messages.at(-1).content).toBe("El agente nativo está conectado.");
    expect(providerCalls).toBe(2);
    child!.kill("SIGTERM");
    await child!.exited;
    request = await start();
    const restored = await (await request(`/chats/${chat.id}`)).json();
    expect(restored.messages).toHaveLength(2);
    expect(restored.messages[1].content).toBe("El agente nativo está conectado.");
  } finally {
    clearTimeout(deadline);
    child?.kill();
    if (child) await child.exited;
    await provider.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);
