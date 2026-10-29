// Runs in an isolated process with a temporary workspace and an offline catalog.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { stripVTControlCharacters } from "node:util";
import { act } from "react";
import { render } from "ink";
import { loadLlmConfig, configureLlm } from "@eigengrid/agent";
import { ChatGptStore } from "@eigengrid/agent/chatgpt-store";
import { Splash } from "../Splash";

class Input extends EventEmitter {
  isTTY = true;
  buffer = "";
  setRawMode() {
    return this;
  }
  setEncoding() {
    return this;
  }
  ref() {
    return this;
  }
  unref() {
    return this;
  }
  read() {
    const data = this.buffer;
    this.buffer = "";
    return data || null;
  }
  async press(data: string) {
    await act(async () => {
      this.buffer += data;
      this.emit("readable");
    });
    await Bun.sleep(30);
  }
}

class Output extends EventEmitter {
  columns = 120;
  rows = 40;
  frame = "";
  write(data: string) {
    this.frame = stripVTControlCharacters(data);
    return true;
  }
}

let failAccountModels = false;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  if (String(input).startsWith("https://beta.example/v1/models"))
    return Response.json({
      data: [
        {
          id: "beta-supported",
          display_name: "Beta Supported",
          supported_reasoning_levels: ["low", "high"],
        },
        { id: "beta-retired", shutdown_date: "2000-01-01" },
        { id: "gpt-image-2" },
      ],
    });
  if (String(input).endsWith("/models") && failAccountModels)
    return Response.json({ error: "temporarily_unavailable" }, { status: 503 });
  if (String(input).endsWith("/models"))
    return Response.json({
      metadata: "x".repeat(600 * 1024),
      models: [
        {
          slug: "account-only-model",
          display_name: "My Account Model",
          visibility: "list",
          supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "ultra" }],
        },
        {
          slug: "account-second",
          display_name: "Second Account Model",
          visibility: "list",
          supported_reasoning_levels: [{ effort: "medium" }],
        },
      ],
    });
  return Response.json({
    alpha: { name: "Alpha Lab", api: "https://alpha.example/v1", models: { first: {} } },
    beta: { name: "Beta Cloud", api: "https://beta.example/v1", models: { second: {} } },
    openai: {
      name: "OpenAI",
      npm: "@ai-sdk/openai",
      models: {
        "gpt-realtime": {},
        "text-embedding-3-large": { family: "text-embedding" },
        chat: {},
      },
    },
    anthropic: { name: "Anthropic", npm: "@ai-sdk/anthropic", models: { chat: {} } },
    unsupported: {
      name: "Unsupported",
      api: "https://example.com",
      npm: "@ai-sdk/google",
      models: { unsupported: {} },
    },
  });
}) as unknown as typeof fetch;

const stdin = new Input();
const stdout = new Output();
const app = render(<Splash />, {
  stdin: stdin as unknown as NodeJS.ReadStream,
  stdout: stdout as unknown as NodeJS.WriteStream,
  stderr: stdout as unknown as NodeJS.WriteStream,
  debug: true,
  patchConsole: false,
  exitOnCtrlC: false,
});

async function waitFor(text: string) {
  for (let i = 0; i < 100; i++) {
    if (stdout.frame.includes(text)) return;
    await Bun.sleep(20);
  }
  assert.fail(`Expected ${text} in frame:\n${stdout.frame}`);
}

try {
  await waitFor("Workspace snapshot");
  const command = process.argv[2];
  await stdin.press(command);
  if (command === "/") {
    // Select the provider command from the full command menu using the keyboard.
    const { getSuggestions } = await import("../../slash-commands");
    const index = getSuggestions("/").findIndex((item) => item.name === "/connect");
    assert.ok(index >= 0);
    for (let i = 0; i < index; i++) await stdin.press("\u001b[B");
  }
  await stdin.press("\r");
  await waitFor("▸ OpenAI");
  assert.ok(stdout.frame.includes("CONNECT / SELECT PROVIDER"));
  assert.ok(stdout.frame.includes("Source: models.dev"));
  assert.ok(stdout.frame.includes("Access not tested"));
  assert.ok(stdout.frame.includes("1 providers omitted"));
  assert.ok(!stdout.frame.includes("<unsupported>"));
  assert.ok(!stdout.frame.includes("Popular Providers:"));
  await stdin.press("\u001b[B");
  await waitFor("▸ Anthropic");
  await stdin.press("\u001b[A");
  await waitFor("▸ OpenAI");
  await stdin.press("beta");
  await waitFor("▸ Beta Cloud");
  assert.ok(!stdout.frame.includes("Alpha Lab"));
  await stdin.press("\u001b");
  await waitFor("COMMAND / CONVERSATION");
  assert.equal(loadLlmConfig(), null);
  // Escape returns to a usable prompt; selecting then persists the highlighted provider.
  configureLlm({ providerName: "alpha", apiKey: "fixture-alpha-only" });
  await stdin.press("/connect");
  await stdin.press("\r");
  await waitFor("▸ OpenAI");
  await stdin.press("\r");
  await waitFor("AUTHENTICATION");
  assert.ok(stdout.frame.includes("Continue with ChatGPT"));
  assert.ok(stdout.frame.includes("Use API key"));
  await stdin.press("\r");
  await waitFor("Add a ChatGPT account");
  await stdin.press("\u001b");
  await waitFor("AUTHENTICATION");
  await stdin.press("\u001b");
  await waitFor("▸ OpenAI");
  await stdin.press("\r");
  await waitFor("AUTHENTICATION");
  await stdin.press("\u001b[B");
  await stdin.press("\r");
  await waitFor("PRIVATE INPUT");
  await stdin.press("\u001b");
  await waitFor("COMMAND / CONVERSATION");
  assert.equal(loadLlmConfig()?.providerName, "openai");
  assert.equal(loadLlmConfig()?.model, "chat");
  assert.equal(loadLlmConfig()?.baseUrl, "https://api.openai.com/v1");
  assert.equal(loadLlmConfig()?.apiKey, undefined);
  const store = new ChatGptStore();
  store.save({
    id: "profile-ui",
    clientId: "oaiapp_fixture",
    subject: "fixture-user",
    email: "account@example.test",
    accessToken: "fixture-ui-access",
    refreshToken: "fixture-ui-refresh",
    expiresAt: Date.now() + 3600_000,
    scopes: ["chatgpt.tokens.use.direct"],
  });
  await stdin.press("/connect openai");
  await stdin.press("\r");
  await waitFor("AUTHENTICATION");
  await stdin.press("\r");
  await waitFor("account@example.test");
  failAccountModels = true;
  await stdin.press("\r");
  await waitFor("HTTP 503");
  assert.equal(loadLlmConfig()?.authMode, "chatgpt");
  assert.equal(loadLlmConfig()?.chatGptProfileId, "profile-ui");
  failAccountModels = false;
  await stdin.press("\r");
  await waitFor("My Account Model");
  await stdin.press("\r");
  await waitFor("VARIANTS / My Account Model");
  await waitFor("Provider default");
  assert.ok(!stdout.frame.includes("ultra"));
  await stdin.press("\u001b[B");
  await stdin.press("\u001b[B");
  await stdin.press("\r");
  await waitFor("COMMAND / CONVERSATION");
  assert.equal(loadLlmConfig()?.authMode, "chatgpt");
  assert.equal(loadLlmConfig()?.chatGptProfileId, "profile-ui");
  assert.equal(loadLlmConfig()?.model, "account-only-model");
  assert.equal(loadLlmConfig()?.reasoningEffort, "high");
  assert.equal(loadLlmConfig()?.apiKey, undefined);
  assert.ok(!stdout.frame.includes("fixture-ui-access"));
  await stdin.press("/variants");
  await stdin.press("\r");
  await waitFor("VARIANTS / My Account Model");
  await waitFor("high · current");
  await stdin.press("\u001b[A");
  await stdin.press("\r");
  await waitFor("COMMAND / CONVERSATION");
  assert.equal(loadLlmConfig()?.reasoningEffort, "low");
  assert.equal(loadLlmConfig()?.model, "account-only-model");
  await stdin.press("/variants default");
  await stdin.press("\r");
  await waitFor("COMMAND / CONVERSATION");
  assert.equal(loadLlmConfig()?.reasoningEffort, undefined);
  await stdin.press("/variants low");
  await stdin.press("\r");
  await waitFor("COMMAND / CONVERSATION");
  assert.equal(loadLlmConfig()?.reasoningEffort, "low");
  await stdin.press("/models");
  await stdin.press("\r");
  await waitFor("MODELS / OpenAI / CHATGPT ACCOUNT");
  await waitFor("Second Account Model");
  assert.ok(!stdout.frame.includes("<chat>"));
  await stdin.press("\u001b[B");
  await stdin.press("\r");
  await waitFor("VARIANTS / Second Account Model");
  await waitFor("Provider default");
  await waitFor("medium");
  assert.ok(
    !stdout.frame.split("\n").some((line) => /^[│ ▸]*high(?: · current)?[│ ]*$/.test(line)),
  );
  await stdin.press("\u001b");
  await waitFor("MODELS / OpenAI / CHATGPT ACCOUNT");
  assert.equal(loadLlmConfig()?.model, "account-only-model");
  assert.equal(loadLlmConfig()?.reasoningEffort, "low");
  await stdin.press("\r");
  await waitFor("VARIANTS / Second Account Model");
  await waitFor("Provider default");
  await stdin.press("\u001b[B");
  await stdin.press("\r");
  await waitFor("COMMAND / CONVERSATION");
  assert.equal(loadLlmConfig()?.model, "account-second");
  assert.equal(loadLlmConfig()?.reasoningEffort, "medium");
  assert.equal(loadLlmConfig()?.authMode, "chatgpt");
  await stdin.press("/connect");
  await stdin.press("\r");
  await waitFor("▸ OpenAI");
  await stdin.press("beta");
  await stdin.press("\r");
  await waitFor("AUTHENTICATION");
  await stdin.press("\r");
  await waitFor("PRIVATE INPUT");
  await stdin.press("\u001b");
  await waitFor("COMMAND / CONVERSATION");
  assert.equal(loadLlmConfig()?.providerName, "beta");
  assert.equal(loadLlmConfig()?.model, "second");
  assert.equal(loadLlmConfig()?.reasoningEffort, undefined);
  assert.equal(loadLlmConfig()?.apiKey, undefined);
  await stdin.press("/models");
  await stdin.press("\r");
  await waitFor("Current access: API key");
  await stdin.press("\u001b");
  await waitFor("COMMAND / CONVERSATION");
  await stdin.press("/key");
  await stdin.press("\r");
  await waitFor("PRIVATE INPUT");
  await stdin.press("fixture-beta-key");
  assert.ok(!stdout.frame.includes("fixture-beta-key"));
  await stdin.press("\r");
  await waitFor("COMMAND / CONVERSATION");
  await stdin.press("/models");
  await stdin.press("\r");
  await waitFor("MODELS / Beta Cloud / API KEY");
  await waitFor("Beta Supported");
  assert.ok(!stdout.frame.includes("beta-retired"));
  assert.ok(!stdout.frame.includes("gpt-image-2"));
  assert.ok(!stdout.frame.includes("account-only-model"));
  await stdin.press("\r");
  await waitFor("VARIANTS / Beta Supported");
  await waitFor("Provider default");
  await stdin.press("\u001b[B");
  await stdin.press("\r");
  await waitFor("COMMAND / CONVERSATION");
  assert.equal(loadLlmConfig()?.model, "beta-supported");
  assert.equal(loadLlmConfig()?.reasoningEffort, "low");
  assert.equal(loadLlmConfig()?.authMode, "api-key");
} finally {
  app.unmount();
  app.cleanup();
}
