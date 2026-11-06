import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLlmConfig, configureLlm } from "@eigengrid/agent";
import { ChatGptStore } from "@eigengrid/agent/chatgpt-store";
import { readWebConnection, activateWebConnection } from "./connection";

test("web reuses the CLI ChatGPT account, reloads model changes, and never exposes or copies tokens", () => {
  const dir = mkdtempSync(join(tmpdir(), "eigengrid-web-connection-"));
  const oldAuth = process.env.EIGENGRID_AUTH_DIR;
  const oldConfig = getLlmConfig();
  try {
    process.env.EIGENGRID_AUTH_DIR = join(dir, "auth");
    const auth = new ChatGptStore();
    const id = crypto.randomUUID();
    auth.save({
      id,
      clientId: "test-client",
      subject: "fixture",
      accessToken: "test-access",
      refreshToken: "test-refresh",
      scopes: ["chatgpt.tokens.use.direct"],
    });
    mkdirSync(join(dir, ".eigengrid"), { mode: 0o700 });
    const path = join(dir, ".eigengrid/llm.json");
    const config = {
      model: "first-model",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "chatgpt",
      chatGptProfileId: id,
      providerName: "openai",
    };
    writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
    const before = readFileSync(path, "utf8");
    expect(readWebConnection(dir).state).toMatchObject({
      configured: true,
      model: "first-model",
      authMode: "chatgpt",
    });
    expect(JSON.stringify(readWebConnection(dir).state)).not.toContain("test-access");
    expect(JSON.stringify(readWebConnection(dir).state)).not.toContain(id);
    activateWebConnection(dir);
    expect(getLlmConfig().authMode).toBe("chatgpt");
    expect(getLlmConfig().apiKey).toBeUndefined();
    expect(readFileSync(path, "utf8")).toBe(before);
    writeFileSync(path, JSON.stringify({ ...config, model: "second-model" }));
    activateWebConnection(dir);
    expect(getLlmConfig().model).toBe("second-model");
    auth.clearTokens(id);
    expect(readWebConnection(dir).state.configured).toBe(false);
    expect(() => activateWebConnection(dir)).toThrow("/connect");
    chmodSync(path, 0o644);
    expect(readWebConnection(dir).state.configured).toBe(false);
    expect(readWebConnection(dir).state.model).toBeNull();
  } finally {
    if (oldAuth === undefined) delete process.env.EIGENGRID_AUTH_DIR;
    else process.env.EIGENGRID_AUTH_DIR = oldAuth;
    configureLlm(oldConfig);
    rmSync(dir, { recursive: true, force: true });
  }
});
