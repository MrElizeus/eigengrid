import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

// Exercise the compiled program and installed data from an unrelated directory.
const distribution = resolve(process.argv[2] ?? "dist/native");
const manifest = JSON.parse(readFileSync(join(distribution, "distribution.json"), "utf8"));
const cwd = mkdtempSync(join(tmpdir(), "eg-installed-"));
const calls: Record<string, unknown>[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    calls.push((await request.json()) as Record<string, unknown>);
    const first = calls.length === 1;
    return Response.json({
      choices: [
        {
          index: 0,
          message: first
            ? {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "installed-catalog",
                    type: "function",
                    function: { name: "list-protocols", arguments: '{"engine":"orca","limit":2}' },
                  },
                ],
              }
            : { role: "assistant", content: "Observed installed scientific protocols." },
          finish_reason: first ? "tool_calls" : "stop",
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    });
  },
});
const env = {
  ...process.env,
  EIGENGRID_DB_PROVIDER: "sqlite",
  EIGENGRID_DB_PATH: join(cwd, "state.db"),
  LLM_API_KEY: "",
  OPENCODE_API_KEY: "",
  OPENAI_API_KEY: "",
  ANTHROPIC_API_KEY: "",
  EIGENGRID_SCIENTIFIC_SKILLS_ROOT: undefined,
};
async function run(binary: string, args: string[]) {
  const p = Bun.spawn([join(distribution, "bin", binary), ...args], {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => p.kill(), 20_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      p.exited,
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    assert.equal(code, 0, `${binary}: ${stderr || stdout}`);
    return stdout;
  } finally {
    clearTimeout(timer);
  }
}
try {
  for (const binary of manifest.binaries) await run(binary, ["--help"]);
  assert.equal((await run("eigengrid", ["--version"])).trim(), manifest.version);
  JSON.parse(await run("eigengrid", ["mission", "schema", "create"]));
  JSON.parse(await run("eigengrid", ["amber", "schema", "render-analysis"]));
  assert.equal(calls.length, 0, "Manual interfaces must not invoke inference");
  mkdirSync(join(cwd, ".eigengrid"), { mode: 0o700 });
  writeFileSync(
    join(cwd, ".eigengrid/llm.json"),
    JSON.stringify({
      providerName: "installation-fixture",
      model: "fixture-model",
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      apiKey: "fixture-only",
      costPerInputToken: 0,
      costPerOutputToken: 0,
    }),
    { mode: 0o600 },
  );
  const output = JSON.parse(
    await run("eigengrid", [
      "agent",
      "Inspect installed molecular optimization protocols",
      "--json",
    ]),
  );
  assert.equal(output.ok, true);
  assert.equal(calls.length, 2, "Native loop must interpret the observed tool result");
  assert.equal(output.toolCalls[0].tool, "list-protocols");
  const observation = (calls[1].messages as Array<{ role: string; content: string }>).find(
    (m) => m.role === "tool",
  );
  assert.ok(observation);
  const result = JSON.parse(observation.content);
  assert.equal(result.result.ok, true);
  assert.equal(result.result.data.totalCapabilities, 15);
  assert.equal(result.result.data.returned, 2);
  const wheels = readdirSync(join(distribution, "python")).filter((name) => name.endsWith(".whl"));
  assert.equal(wheels.length, 1, "The distribution must contain exactly one Python wheel");
  const target = join(cwd, "installed-python");
  const python = process.env.EIGENGRID_RELEASE_PYTHON ?? "python";
  async function runPython(args: string[]) {
    const child = Bun.spawn([python, ...args], {
      cwd,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), 20_000);
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      assert.equal(code, 0, stderr || stdout);
      return stdout;
    } finally {
      clearTimeout(timer);
    }
  }
  await runPython([
    "-m",
    "pip",
    "install",
    "--no-deps",
    "--no-compile",
    "--disable-pip-version-check",
    "--target",
    target,
    join(distribution, "python", wheels[0]),
  ]);
  const fixture = new URL("../../tests/fixtures/amber/md.nc", import.meta.url).pathname;
  await runPython([
    "-I",
    "-c",
    `import json, pathlib, sys
target = pathlib.Path(sys.argv[1]).resolve()
sys.path.insert(0, str(target))
import eigengrid_chem
assert pathlib.Path(eigengrid_chem.__file__).resolve().is_relative_to(target)
assert eigengrid_chem.__version__ == sys.argv[3]
from eigengrid_chem.amber.inspection import inspect_amber_artifact
observed = inspect_amber_artifact(pathlib.Path(sys.argv[2]), "trajectory")
assert observed["readStatus"] == "complete" and observed["frameCount"] == 5
print("PASS: installed wheel independently decodes the retained trajectory")`,
    target,
    fixture,
    manifest.version.replace("-rc.", "rc"),
  ]);
  console.log(
    "PASS: six binaries, no-model schemas, installed corpus, structured tool/result round trip and installed Python wheel",
  );
} finally {
  await server.stop(true);
  rmSync(cwd, { recursive: true, force: true });
}
