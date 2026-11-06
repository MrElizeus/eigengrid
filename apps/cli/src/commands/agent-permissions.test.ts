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
const waterInput =
  "%nprocshared=1\n%mem=1GB\n# B3LYP/6-31G(d) opt freq\n\nWater\n\n0 1\nO 0 0 0\nH 0 0 0.96\nH 0.93 0 -0.24\n\n";
const waterScript =
  "#!/bin/bash\n#SBATCH --partition=chem\n#SBATCH --cpus-per-task=1\n#SBATCH --mem=2G\ng16 < calculations/water/water.gjf > calculations/water/water.log\n";
async function run(
  preset: PermissionPresetId,
  { shell = false, path = "calculation.in", slurm = false, largeOutput = false } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "eigengrid-agent-permission-e2e-"));
  const policyRoot = join(directory, "policy");
  mkdirSync(policyRoot, { mode: 0o700 });
  const workspace = join(directory, "workspace");
  mkdirSync(workspace);
  mkdirSync(join(workspace, ".eigengrid"), { mode: 0o700 });
  const bin = join(directory, "bin");
  mkdirSync(bin);
  if (slurm)
    writeFileSync(
      join(bin, "sbatch"),
      `#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
assert.deepEqual(process.argv.slice(2), ["--parsable", "calculations/water/submit.sbatch"]);
assert.equal(readFileSync(process.argv[3], "utf8"), ${JSON.stringify(waterScript)});
assert.equal(readFileSync("calculations/water/water.gjf", "utf8"), ${JSON.stringify(waterInput)});
assert.equal(Bun.spawnSync(["bash", "-n", process.argv[3]]).exitCode, 0);
appendFileSync("submissions.jsonl", JSON.stringify(process.argv.slice(2)) + "\\n");
console.log("12345;fixture-cluster");
`,
      { mode: 0o700 },
    );
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
                tool_calls: slurm
                  ? [
                      {
                        id: "permissions-info",
                        type: "function",
                        function: { name: "operator-info", arguments: "{}" },
                      },
                      {
                        id: "water-input",
                        type: "function",
                        function: {
                          name: "write-file",
                          arguments: JSON.stringify({
                            path: "calculations/water/water.gjf",
                            content: waterInput,
                          }),
                        },
                      },
                      {
                        id: "water-script",
                        type: "function",
                        function: {
                          name: "write-file",
                          arguments: JSON.stringify({
                            path: "calculations/water/submit.sbatch",
                            content: waterScript,
                          }),
                        },
                      },
                      {
                        id: "water-submit",
                        type: "function",
                        function: {
                          name: "run-command",
                          arguments: JSON.stringify({
                            command: "sbatch",
                            args: ["--parsable", "calculations/water/submit.sbatch"],
                          }),
                        },
                      },
                    ]
                  : [
                      {
                        id: "permission-probe",
                        type: "function",
                        function: {
                          name: shell ? "run-command" : "write-file",
                          arguments: JSON.stringify(
                            shell
                              ? { command: "/usr/bin/id", args: ["-u"] }
                              : { path, content: "scientific-input-fixture" },
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
      const observation = body.messages.filter((message) => message.role === "tool").at(-1);
      return Response.json({
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: largeOutput
                ? "K".repeat(131072)
                : (observation?.content ?? "No observation"),
            },
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
          PATH: `${bin}:${process.env.PATH}`,
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
        written: existsSync(join(workspace, path))
          ? readFileSync(join(workspace, path), "utf8")
          : undefined,
        audited: existsSync(`${policyPath}.audit.jsonl`),
        submissions: existsSync(join(workspace, "submissions.jsonl"))
          ? readFileSync(join(workspace, "submissions.jsonl"), "utf8").trim().split("\n")
          : [],
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

test("flushes large JSON responses completely through a pipe before exiting", async () => {
  const result = await run("full-access", { largeOutput: true });
  expect(result.exit).toBe(0);
  expect(result.output.response).toBe("K".repeat(131072));
});

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
test("Full Access creates a Slurm script in a new calculation directory", async () => {
  const result = await run("full-access", { path: "calculations/water/submit.sbatch" });
  expect(result.exit).toBe(0);
  expect(result.calls).toBe(2);
  expect(result.written).toBe("scientific-input-fixture");
  expect(result.audited).toBe(true);
}, 10000);
test("Full Access prepares Gaussian water input and submits its script through an sbatch fixture", async () => {
  const result = await run("full-access", {
    slurm: true,
    path: "calculations/water/submit.sbatch",
  });
  expect(result.exit).toBe(0);
  expect(result.output.toolCalls.map((call: { tool: string }) => call.tool)).toEqual([
    "operator-info",
    "write-file",
    "write-file",
    "run-command",
  ]);
  expect(result.output.toolCalls[0].result.data.tools.approvalRequired).toEqual([]);
  expect(result.output.toolCalls[0].result.data.tools.executable).toContain("write-file");
  expect(result.output.toolCalls[0].result.data.tools.executable).toContain("run-command");
  expect(result.output.toolCalls[3].result.data).toMatchObject({
    exitCode: 0,
    stdout: "12345;fixture-cluster\n",
  });
  expect(result.written).toBe(waterScript);
  expect(result.submissions).toHaveLength(1);
  expect(result.audited).toBe(true);
}, 10000);
test("a denied write reports its tool and cause instead of a generic policy failure", async () => {
  const result = await run("full-access", { path: ".eigengrid/inputs/water.gjf" });
  expect(result.exit).toBe(1);
  expect(result.output.response).toContain("write-file:");
  expect(result.output.response).toContain("cannot modify credentials");
  expect(result.output.response).not.toContain("Tool policy denied effect");
  expect(result.written).toBeUndefined();
  expect(result.audited).toBe(false);
}, 10000);
test("Full Access program execution inherits the real OS UID", async () => {
  const result = await run("full-access", { shell: true });
  expect(result.exit).toBe(0);
  expect(result.output.toolCalls[0].result.data.stdout.trim()).toBe(String(process.getuid!()));
  expect(result.audited).toBe(true);
}, 10000);
test("Auto Review never approves arbitrary program execution without a human", async () => {
  const result = await run("auto-review", { shell: true });
  expect(result.exit).toBe(1);
  expect(result.calls).toBe(1);
  expect(result.audited).toBe(false);
}, 10000);
