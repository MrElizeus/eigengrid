import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync, unlinkSync, symlinkSync, chownSync } from "node:fs";
import { resolve } from "node:path";
import {
  loadLlmConfig,
  loadGlobalLlmConfig,
  forgetStoredLlmApiKey,
  saveLlmConfig,
} from "../../packages/agent/src/llm-config-store";
import { configureLlm, getLlmConfig } from "../../packages/agent/src/llm-client";

const inside = process.env.EIGENGRID_GLOBAL_MODEL_CONTAINER === "1";
if (!inside) {
  test.skipIf(
    !process.env.EIGENGRID_TEST_POSTGRES_URL && !process.env.EIGENGRID_TEST_CONTAINER_RUNTIME,
  )(
    "global model: root-owned configuration and an unprivileged client",
    async () => {
      const script = `import os,subprocess
os.mkdir('/site',0o755)
os.mkdir('/project',0o700)
os.chown('/project',1000,1000)
os.environ['EIGENGRID_GLOBAL_MODEL_CONTAINER']='1'
raise SystemExit(subprocess.call(['/bun','test','/workspace/tests/e2e/global-model.test.ts']))
`;
      const child = Bun.spawn(
        [
          process.env.EIGENGRID_TEST_CONTAINER_RUNTIME ?? "docker",
          "run",
          "--rm",
          "--network=none",
          "--security-opt=label=disable",
          "--mount",
          `type=bind,src=${resolve(import.meta.dir, "../..")},dst=/workspace,ro`,
          "--mount",
          `type=bind,src=${process.execPath},dst=/bun,ro`,
          "--workdir",
          "/workspace",
          "python:3.13-slim",
          "python",
          "-c",
          script,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (code) throw new Error(stdout + stderr);
      expect(stdout + stderr).toContain("0 fail");
    },
    60_000,
  );
} else {
  test("global defaults replace safely and never write site credentials when forgetting a private key", () => {
    const globalPath = "/site/llm.json";
    const config = {
      baseUrl: "http://site-model.invalid/v1",
      model: "site-model",
      providerName: "site",
      apiKey: "site-secret",
      costPerInputToken: 0,
      costPerOutputToken: 0,
    };
    process.env.EIGENGRID_GLOBAL_LLM_CONFIG = globalPath;
    writeFileSync(globalPath, JSON.stringify(config), { mode: 0o640 });
    chownSync(globalPath, 0, 1000);
    process.chdir("/project");
    expect(loadGlobalLlmConfig()?.model).toBe("site-model");
    chmodSync(globalPath, 0o666);
    expect(() => loadGlobalLlmConfig()).toThrow();
    chmodSync(globalPath, 0o640);
    chownSync(globalPath, 1000, 1000);
    expect(() => loadGlobalLlmConfig()).toThrow();
    chownSync(globalPath, 0, 1000);
    unlinkSync(globalPath);
    symlinkSync("/site/target.json", globalPath);
    writeFileSync("/site/target.json", JSON.stringify(config), { mode: 0o640 });
    expect(() => loadGlobalLlmConfig()).toThrow();
    unlinkSync(globalPath);
    writeFileSync(globalPath, JSON.stringify(config), { mode: 0o640 });
    chownSync(globalPath, 0, 1000);
    // Drop to a real unprivileged OS identity after root provisions the site file.
    process.setgroups!([1000]);
    process.setgid!(1000);
    process.setuid!(1000);
    expect(loadLlmConfig()?.apiKey).toBe("site-secret");
    const status = Bun.spawnSync(["/bun", "/workspace/apps/cli/bin/eigengrid.ts", "model-config"], {
      cwd: "/project",
      env: process.env,
    });
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout.toString()).source).toBe("global");
    expect(status.stdout.toString()).not.toContain("site-secret");
    expect(forgetStoredLlmApiKey()).toBe(false);
    configureLlm(loadLlmConfig()!);
    configureLlm({ baseUrl: "http://personal-model.invalid/v1" });
    expect(getLlmConfig().apiKey).toBeUndefined();
    mkdirSync(".eigengrid", { mode: 0o700 });
    saveLlmConfig({ baseUrl: "http://personal-model.invalid/v1", model: "personal" });
    expect(loadLlmConfig()?.apiKey).toBeUndefined();
    expect(loadLlmConfig()?.model).toBe("personal");
    writeFileSync(".eigengrid/llm.json", "corrupt");
    expect(() => loadLlmConfig()).toThrow();
    unlinkSync(".eigengrid/llm.json");
    expect(loadLlmConfig()?.model).toBe("site-model");
  });
}
