import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { stripVTControlCharacters } from "node:util";
import { act } from "react";
import { render } from "ink";
import { configureLlm } from "@eigengrid/agent";
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
  columns = 80;
  rows = 24;
  frame = "";
  write(data: string) {
    this.frame = stripVTControlCharacters(data);
    return true;
  }
}
const stdin = new Input(),
  stdout = new Output();
const upstream = globalThis.fetch;
let releaseFirst!: () => void;
const firstGate = new Promise<void>((resolve) => {
  releaseFirst = resolve;
});
let releaseSecond!: () => void;
const secondGate = new Promise<void>((resolve) => {
  releaseSecond = resolve;
});
let firstFinished = false;
const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
const chunk = (delta: unknown, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: "stream-fixture", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } } : {}) })}\n\n`;
const provider = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    requests.push((await request.json()) as (typeof requests)[number]);
    const n = requests.length;
    return new Response(
      new ReadableStream({
        async start(controller) {
          const send = (text: string) => controller.enqueue(new TextEncoder().encode(text));
          if (n === 1) {
            send(chunk({ role: "assistant", content: "First streamed line\nPartial answer" }));
            await firstGate;
            send(chunk({ content: " before steering" }));
            firstFinished = true;
          } else if (n === 2) {
            send(chunk({ role: "assistant", content: "Following the new instruction" }));
            await secondGate;
            send(chunk({ content: "." }));
          } else {
            send(chunk({ role: "assistant", content: "Interrupted partial" }));
            await new Promise<void>((resolve) =>
              request.signal.addEventListener("abort", () => resolve(), { once: true }),
            );
          }
          try {
            send(chunk({}, "stop") + "data: [DONE]\n\n");
            controller.close();
          } catch {
            /* client cancellation */
          }
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  },
});
const origin = `http://127.0.0.1:${provider.port}`;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url === "https://models.dev/api.json") return Promise.resolve(Response.json({}));
  assert.equal(new URL(url).origin, origin, "No external provider requests in this fixture");
  return upstream(input, init);
}) as typeof fetch;
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
  assert.fail(`Missing ${text}\n${stdout.frame}`);
}
async function command(text: string) {
  await stdin.press(text);
  await stdin.press("\r");
}
try {
  await waitFor("Workspace snapshot");
  configureLlm({
    providerName: "stream-fixture",
    model: "fixture",
    baseUrl: `${origin}/v1`,
    apiKey: "fixture",
    maxTokens: 256,
    timeoutMilliseconds: 5000,
    costPerInputToken: 0,
    costPerOutputToken: 0,
  });
  await command("Inspect the environment");
  await waitFor("Partial answer");
  assert.equal(firstFinished, false);
  assert.ok(stdout.frame.indexOf("Partial answer") < stdout.frame.indexOf("CONVERSATION · STEER"));
  await command("Only summarize existing evidence");
  await waitFor("1 queued");
  assert.equal(requests.length, 1);
  await stdin.press("my unsent draft");
  releaseFirst();
  await waitFor("Following the new instruction");
  assert.equal(requests.length, 2);
  assert.ok(JSON.stringify(requests[1].messages).includes("Only summarize existing evidence"));
  assert.ok(stdout.frame.includes("my unsent draft"));
  releaseSecond();
  await waitFor("COMMAND / CONVERSATION");
  assert.ok(stdout.frame.includes("my unsent draft"));
  assert.equal(stdout.frame.match(/First streamed line/g)?.length, 1);
  assert.equal(stdout.frame.match(/Following the new instruction\./g)?.length, 1);
  for (let i = 0; i < "my unsent draft".length; i++) await stdin.press("\u007f");
  await command("Another inspection");
  await waitFor("Interrupted partial");
  await stdin.press("\u001b");
  await waitFor("Model response interrupted");
  await waitFor("COMMAND / CONVERSATION");
  assert.ok(stdout.frame.includes("Interrupted partial"));
  assert.equal(requests.length, 3);
} finally {
  releaseFirst();
  releaseSecond();
  app.unmount();
  await provider.stop(true);
}
