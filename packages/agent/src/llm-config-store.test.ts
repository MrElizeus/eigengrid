import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  saveLlmConfig,
  loadLlmConfig,
  findLlmConfigPath,
  forgetStoredLlmApiKey,
} from "./llm-config-store";
import { configureLlm, getLlmConfig, resolveConfiguredModel } from "./llm-client";

describe("private operator model preferences", () => {
  let directory: string, original: string;
  beforeEach(() => {
    original = process.cwd();
    directory = mkdtempSync(join(tmpdir(), "eigengrid-model-preferences-"));
    // A project-local state directory keeps these tests independent of personal configuration.
    process.chdir(directory);
    mkdirSync(join(directory, ".eigengrid"), { mode: 0o700 });
  });
  afterEach(() => {
    process.chdir(original);
    rmSync(directory, { recursive: true, force: true });
  });
  const config = {
    baseUrl: "http://localhost:11434/v1",
    model: "local-fixture",
    providerName: "local",
    apiKey: "fixture-private-key",
    temperature: 0.3,
    maxTokens: 512,
    costPerInputToken: 0,
    costPerOutputToken: 0,
  };

  test("forgetting a key preserves provider, model and explicit free pricing", () => {
    saveLlmConfig(config);
    expect(forgetStoredLlmApiKey()).toBe(true);
    expect(loadLlmConfig()).toEqual({ ...config, apiKey: undefined });
    expect(readFileSync(findLlmConfigPath(), "utf8")).not.toContain(config.apiKey);
    expect(statSync(findLlmConfigPath()).mode & 0o777).toBe(0o600);
    expect(forgetStoredLlmApiKey()).toBe(false);
  });
  test("reasoning variants survive reload and invalid client-only efforts are rejected", () => {
    saveLlmConfig({ ...config, reasoningEffort: "high" });
    expect(loadLlmConfig()?.reasoningEffort).toBe("high");
    const path = findLlmConfigPath();
    const stored = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...stored, reasoningEffort: "ultra" }));
    expect(() => loadLlmConfig()).toThrow("invalid");
  });

  test("unsafe stored credentials fail before provider resolution instead of falling back", async () => {
    saveLlmConfig(config);
    chmodSync(findLlmConfigPath(), 0o644);
    expect(() => loadLlmConfig()).toThrow(/private|permissions/i);
    const originalConfig = getLlmConfig();
    try {
      configureLlm(config);
      await expect(resolveConfiguredModel()).rejects.toThrow(/private|permissions/i);
    } finally {
      configureLlm(originalConfig);
    }
    chmodSync(findLlmConfigPath(), 0o600);
    chmodSync(join(directory, ".eigengrid"), 0o777);
    expect(() => loadLlmConfig()).toThrow(/private|permissions/i);
  });

  test.skipIf(process.platform === "win32")(
    "rejects a named pipe without blocking model startup",
    () => {
      const pipe = join(directory, ".eigengrid", "llm.json");
      expect(spawnSync("mkfifo", ["-m", "600", pipe]).status).toBe(0);
      // Isolate the regression: a blocking open must fail this test within a bound,
      // rather than hanging the test runner before it can inspect the file type.
      const source = new URL("./llm-config-store.ts", import.meta.url).href;
      const result = spawnSync(
        process.execPath,
        [
          "-e",
          `import { loadLlmConfig } from ${JSON.stringify(source)};
         try { loadLlmConfig(); process.exitCode = 2; }
         catch { process.stdout.write("REJECTED"); }`,
        ],
        { cwd: directory, encoding: "utf8", timeout: 2000 },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("REJECTED");
    },
  );
});
