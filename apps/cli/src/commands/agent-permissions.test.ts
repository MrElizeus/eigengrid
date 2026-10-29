import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionPresetId } from "@eigengrid/agent/execution-permissions";

const cli = join(import.meta.dir, "../../bin/eigengrid.ts");
async function run(preset: PermissionPresetId, shell = false) {
  const directory = mkdtempSync(join(tmpdir(), "eigengrid-agent-permission-e2e-"));
  const policyRoot = join(directory, "policy");
  mkdirSync(policyRoot, { mode: 0o700 });
  const workspace = join(directory, "workspace");
  mkdirSync(workspace);
  mkdirSync(join(workspace, ".eigengrid"), { mode: 0o700 });
  const policyPath = join(
    policyRoot,
    `${createHash("sha256").update(realpathSync(workspace)).digest("hex")}.json`,
  );
  writeFileSync(
    policyPath,
    JSON.stringify({
      schema: "eigengrid.operator-permissions/v1",
      workspace: realpathSync(workspace),
      preset,
      revision: crypto.randomUUID(),
    }),
    { mode: 0o600 },
  );
  let calls = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { messages: { role: string; content: string }[] };
      calls++;
      if (calls === 1)
        return Response.json({
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "permission-probe",
                    type: "function",
                    function: {
                      name: shell ? "run-command" : "write-file",
                      arguments: JSON.stringify(
                        shell
                          ? { command: "/usr/bin/id", args: ["-u"] }
                          : { path: "calculation.in", content: "scientific-input-fixture" },
                      ),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        });
      const observation = body.messages.find((message) => message.role === "tool");
      return Response.json({
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: observation?.content ?? "No observation" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      });
    },
  });
  try {
    writeFileSync(
      join(workspace, ".eigengrid", "llm.json"),
      JSON.stringify({
        providerName: "local-fixture",
        model: "local-fixture",
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        apiKey: "fixture-private-key",
        maxTokens: 256,
        costPerInputToken: 0,
        costPerOutputToken: 0,
      }),
      { mode: 0o600 },
    );
    const preload = join(directory, "offline.ts");
    writeFileSync(
      preload,
      `const upstream = fetch; globalThis.fetch = (input, init) => { const url = String(input); if (url === "https://models.dev/api.json") return Promise.resolve(Response.json({})); if (new URL(url).origin !== "http://127.0.0.1:${server.port}") throw new Error("Unexpected outbound request"); return upstream(input, init); };`,
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        preload,
        cli,
        "agent",
        "Exercise the local permission fixture",
        "--json",
      ],
      {
        cwd: workspace,
        env: {
          ...process.env,
          EIGENGRID_DB_PROVIDER: "sqlite",
          EIGENGRID_DB_PATH: join(directory, "db.sqlite"),
          EIGENGRID_PERMISSIONS_DIR: policyRoot,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const timeout = setTimeout(() => child.kill(), 8000);
    try {
      const [exit, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(err).toBe("");
      expect(out).not.toContain("fixture-private-key");
      return {
        exit,
        output: JSON.parse(out),
        calls,
        written: existsSync(join(workspace, "calculation.in"))
          ? readFileSync(join(workspace, "calculation.in"), "utf8")
          : undefined,
        audited: existsSync(`${policyPath}.audit.jsonl`),
      };
    } finally {
      clearTimeout(timeout);
      child.kill();
      await child.exited;
    }
  } finally {
    await server.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const preset of ["read-only", "ask", "auto-review", "full-access"] as const) {
  test(`native agent tool dispatch enforces ${preset} with a local fixture provider`, async () => {
    const result = await run(preset);
    const allowed = preset === "auto-review" || preset === "full-access";
    expect(result.exit).toBe(allowed ? 0 : 1);
    expect(result.calls).toBe(allowed ? 2 : 1);
    expect(result.written).toBe(allowed ? "scientific-input-fixture" : undefined);
    expect(result.audited).toBe(allowed);
  }, 10000);
}
test("Full Access program execution inherits the real OS UID", async () => {
  const result = await run("full-access", true);
  expect(result.exit).toBe(0);
  expect(result.output.toolCalls[0].result.data.stdout.trim()).toBe(String(process.getuid!()));
  expect(result.audited).toBe(true);
}, 10000);
test("Auto Review never approves arbitrary program execution without a human", async () => {
  const result = await run("auto-review", true);
  expect(result.exit).toBe(1);
  expect(result.calls).toBe(1);
  expect(result.audited).toBe(false);
}, 10000);
