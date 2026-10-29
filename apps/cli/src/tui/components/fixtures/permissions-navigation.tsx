import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { configureLlm } from "@eigengrid/agent";
import { stripVTControlCharacters } from "node:util";
import { act } from "react";
import { render } from "ink";
import { Splash } from "../Splash";
import { loadOperatorPermissions } from "../../../services/operator-permission-store";
import { getSuggestions, SlashCommands } from "../../slash-commands";

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
    const value = this.buffer;
    this.buffer = "";
    return value || null;
  }
  async press(data: string) {
    await act(async () => {
      this.buffer += data;
      this.emit("readable");
    });
    await Bun.sleep(40);
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
const stdin = new Input(),
  stdout = new Output();
const upstreamFetch = globalThis.fetch;
let provider: ReturnType<typeof Bun.serve> | undefined;
globalThis.fetch = (() => {
  throw new Error("This navigation test must remain offline");
}) as unknown as typeof fetch;
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
  assert.fail(`Missing terminal phase: ${text}\n${stdout.frame}`);
}
async function command(text: string) {
  await stdin.press(text);
  await stdin.press("\r");
}
try {
  await waitFor("Workspace snapshot");
  assert.equal(SlashCommands.has("permission"), false);
  assert.deepEqual(
    getSuggestions("/perm").map((suggestion) => suggestion.name),
    ["/permissions"],
  );
  await command("/permissions");
  await waitFor("PERMISSIONS / EXECUTION AND APPROVAL");
  await waitFor("▸ Ask for Approval · current");
  assert.ok(stdout.frame.includes("Autonomous (Sandboxed)"));
  assert.ok(stdout.frame.includes("Full Access"));
  await stdin.press("\u001b[A");
  await waitFor("▸ Read Only");
  await stdin.press("\r");
  await waitFor("Permissions: Read Only");
  assert.equal(loadOperatorPermissions().preset, "read-only");
  await command("/submit xtb missing.xyz");
  await waitFor("Operation declined or blocked");
  assert.ok(!stdout.frame.includes("APPROVAL REQUIRED"));
  await command("/permissions");
  await waitFor("▸ Read Only · current");
  await stdin.press("\u001b[B");
  await stdin.press("\r");
  await waitFor("Permissions: Ask for Approval");
  await command("/init");
  await waitFor("APPROVAL REQUIRED / /init");
  assert.ok(stdout.frame.includes("▸ Deny"));
  await stdin.press("\r");
  await waitFor("COMMAND / CONVERSATION");
  assert.equal(existsSync(".eigengrid/eigengrid.yaml"), false);
  await command("/permissions");
  await waitFor("▸ Ask for Approval · current");
  await stdin.press("\u001b[B");
  await stdin.press("\r");
  await waitFor("Permissions: Auto Review");
  assert.equal(loadOperatorPermissions().preset, "auto-review");
  await command("/permissions");
  await waitFor("▸ Auto Review · current");
  await stdin.press("\u001b[B");
  await stdin.press("\u001b[B");
  await waitFor("▸ Full Access");
  await stdin.press("\u001b");
  await waitFor("COMMAND / CONVERSATION");
  assert.equal(loadOperatorPermissions().preset, "auto-review");
  await command("/permissions");
  await waitFor("▸ Auto Review · current");
  await stdin.press("\u001b[B");
  await stdin.press("\u001b[B");
  await stdin.press("\r");
  await waitFor("Permissions: Full Access");
  assert.equal(loadOperatorPermissions().preset, "full-access");

  // Exercise the real agent/SDK/host prompt bridge with a localhost fixture.
  await command("/permissions");
  await waitFor("▸ Full Access · current");
  for (let index = 0; index < 3; index++) await stdin.press("\u001b[A");
  await stdin.press("\r");
  await waitFor("Permissions: Ask for Approval");
  let requests = 0;
  const scientificInput = "first-line\n" + "x".repeat(3000) + "\nvisible-at-the-end";
  provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { messages: { role: string }[] };
      requests++;
      const observed = body.messages.some((message) => message.role === "tool");
      const delta = observed
        ? { role: "assistant", content: "Fixture input updated." }
        : {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "fixture-write",
                type: "function",
                function: {
                  name: "write-file",
                  arguments: JSON.stringify({
                    path: "fixture.in",
                    content: scientificInput,
                  }),
                },
              },
            ],
          };
      const chunk = (choices: unknown[], usage?: unknown) =>
        `data: ${JSON.stringify({ id: "fixture-response", object: "chat.completion.chunk", created: 0, model: "fixture", choices, ...(usage ? { usage } : {}) })}\n\n`;
      return new Response(
        chunk([{ index: 0, delta, finish_reason: null }]) +
          chunk([{ index: 0, delta: {}, finish_reason: observed ? "stop" : "tool_calls" }], {
            prompt_tokens: 10,
            completion_tokens: 10,
            total_tokens: 20,
          }) +
          "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const origin = `http://127.0.0.1:${provider.port}`;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://models.dev/api.json") return Promise.resolve(Response.json({}));
    assert.equal(new URL(url).origin, origin, "Only the local provider fixture may be called");
    return upstreamFetch(input, init);
  }) as typeof fetch;
  configureLlm({
    providerName: "permission-fixture",
    model: "fixture",
    baseUrl: `${origin}/v1`,
    apiKey: "fixture-key",
    maxTokens: 256,
    costPerInputToken: 0,
    costPerOutputToken: 0,
  });
  await command("Create the fixture input.");
  await waitFor("APPROVAL REQUIRED / write-file");
  assert.equal(existsSync("fixture.in"), false);
  await waitFor("PgUp / PgDn to review all arguments");
  for (let page = 0; page < 4; page++) await stdin.press("\u001b[6~");
  await waitFor("visible-at-the-end");
  await stdin.press("\u001b[B");
  await waitFor("▸ Approve once");
  await stdin.press("\r");
  await waitFor("Fixture input updated.");
  await waitFor("COMMAND / CONVERSATION");
  assert.equal(readFileSync("fixture.in", "utf8"), scientificInput);
  assert.equal(requests, 2);
} finally {
  app.unmount();
  await provider?.stop(true);
}
