import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import { act } from "react";
import { render } from "ink";
import { configureLlm } from "@eigengrid/agent";
import { Splash } from "../Splash";
import { questions } from "../../../agent/fixtures/planning";

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
  columns = 90;
  rows = 36;
  frame = "";
  write(data: string) {
    this.frame = stripVTControlCharacters(data);
    return true;
  }
}
const stdin = new Input(),
  stdout = new Output();
const upstreamFetch = globalThis.fetch;
let requests = 0;
const provider = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as {
      messages: unknown[];
      tools: { function: { name: string } }[];
    };
    requests++;
    const names = body.tools.map((t) => t.function.name);
    if (requests !== 5) {
      assert.ok(names.includes("ask-planning-questions"));
      assert.ok(!names.includes("run-command"));
      assert.ok(!names.includes("submit-job"));
    } else assert.ok(names.includes("run-command"));
    if (requests === 2 || requests === 3)
      assert.ok(JSON.stringify(body.messages).includes("300 K"));
    if (requests === 4) assert.ok(JSON.stringify(body.messages).includes("1CRN"));
    const ask = [1, 3, 6].includes(requests);
    const delta = ask
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `question-${requests}`,
              type: "function",
              function: { name: "ask-planning-questions", arguments: JSON.stringify(questions) },
            },
          ],
        }
      : {
          role: "assistant",
          content:
            requests === 2
              ? "Recorded the temperature."
              : requests === 4
                ? "Recorded the free answer."
                : "Ordinary operator mode.",
        };
    const chunk = (choices: unknown[], usage?: unknown) =>
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture", choices, ...(usage ? { usage } : {}) })}\n\n`;
    return new Response(
      chunk([{ index: 0, delta, finish_reason: null }]) +
        chunk([{ index: 0, delta: {}, finish_reason: ask ? "tool_calls" : "stop" }], {
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
  assert.equal(new URL(url).origin, origin);
  return upstreamFetch(input, init);
}) as typeof fetch;
configureLlm({
  providerName: "planning-fixture",
  model: "fixture",
  baseUrl: `${origin}/v1`,
  apiKey: "fixture-key",
  maxTokens: 4096,
  costPerInputToken: 0,
  costPerOutputToken: 0,
});
const app = render(<Splash />, {
  stdin: stdin as unknown as NodeJS.ReadStream,
  stdout: stdout as unknown as NodeJS.WriteStream,
  stderr: stdout as unknown as NodeJS.WriteStream,
  debug: true,
  patchConsole: false,
  exitOnCtrlC: false,
});
async function waitFor(text: string) {
  for (let i = 0; i < 150; i++) {
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
  await command("/plan Build a pilot from the supplied target");
  await waitFor("CAMPAIGN QUESTION 1/1");
  await waitFor("Recommended");
  assert.ok(stdout.frame.includes("reference experiment"));
  await Bun.sleep(100);
  assert.equal(requests, 1);
  await stdin.press("\r");
  await waitFor("Recorded the temperature.");
  await waitFor("/plan off");
  await command("/submit xtb missing.xyz");
  await waitFor("This command is unavailable during planning");
  assert.equal(requests, 2);
  await command("Review another decision");
  await waitFor("CAMPAIGN QUESTION 1/1");
  // Resize while the question is open; descriptions remain scrollable.
  stdout.columns = 60;
  stdout.rows = 24;
  await act(async () => {
    stdout.emit("resize");
  });
  await stdin.press("\u001b[B");
  await stdin.press("\u001b[B");
  await waitFor("Selected: Other");
  await stdin.press("\r");
  await waitFor("Answer:");
  await stdin.press("1CRN");
  await stdin.press("\r");
  await waitFor("Recorded the free answer.");
  await command("/plan off");
  await waitFor("Planning mode ended");
  await command("Hello again");
  await waitFor("Ordinary operator mode.");
  await command("/plan Another campaign");
  await waitFor("CAMPAIGN QUESTION 1/1");
  await stdin.press("\u001b");
  await waitFor("COMMAND / CONVERSATION");
  await Bun.sleep(100);
  assert.equal(requests, 6);
  assert.equal(existsSync(".eigengrid/plans.jsonl"), false);
} finally {
  app.unmount();
  app.cleanup();
  provider.stop(true);
  globalThis.fetch = upstreamFetch;
}
