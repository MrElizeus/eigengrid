import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { stripVTControlCharacters } from "node:util";
import { render } from "ink";
import type { ReactNode } from "react";
import { MessageList } from "../MessageList";
import { PromptInput } from "../PromptInput";
import type { TuiMessage } from "../../state/tui-types";

class Input extends EventEmitter {
  isTTY = true;
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
    return null;
  }
}
class Output extends EventEmitter {
  columns = 80;
  rows = 24;
  isTTY = true;
  frames: string[] = [];
  write(chunk: string) {
    this.frames.push(stripVTControlCharacters(chunk));
    return true;
  }
}
const sessions: ReturnType<typeof render>[] = [];
function mount(node: ReactNode, columns = 80) {
  const stdout = new Output();
  stdout.columns = columns;
  const session = render(node, {
    stdin: new Input() as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    debug: false,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  sessions.push(session);
  return { session, stdout };
}
async function frame(stdout: Output) {
  await Bun.sleep(40);
  return stdout.frames.at(-1) ?? "";
}
async function waitForFrame(stdout: Output, match: (frame: string) => boolean) {
  const start = stdout.frames.length;
  for (let i = 0; i < 100; i++) {
    const value = stdout.frames.slice(start).find(match);
    if (value !== undefined) return value;
    await Bun.sleep(20);
  }
  assert.fail("No interactive repaint received");
}

async function checkIncrementalTranscript() {
  const { stdout, session } = mount(
    <MessageList
      messages={[]}
      assistantDraft={"committed-prefix\npartial"}
      assistantDraftId="real"
    />,
    80,
  );
  await frame(stdout);
  session.rerender(
    <MessageList
      messages={[]}
      assistantDraft={"committed-prefix\npartial answer\nlast"}
      assistantDraftId="real"
    />,
  );
  await frame(stdout);
  stdout.columns = 50;
  stdout.emit("resize");
  await frame(stdout);
  session.rerender(
    <MessageList
      messages={[
        {
          id: "real",
          kind: "assistant",
          text: "committed-prefix\npartial answer\nlast",
          createdAt: 1,
        },
      ]}
    />,
  );
  await frame(stdout);
  assert.equal(stdout.frames.join("").match(/committed-prefix/g)?.length, 1);
}

async function checkToolTail() {
  const messages: TuiMessage[] = Array.from({ length: 32 }, (_, i) => ({
    id: `tool-${i}`,
    kind: "tool-call",
    toolCallId: `c-${i}`,
    toolName: `inspect-${i}`,
    status: i === 31 ? "running" : "ok",
    summary: i === 31 ? undefined : "collected",
    createdAt: i,
  }));
  const { stdout } = mount(
    <>
      <MessageList messages={messages} />
      <PromptInput value="steer now" onChange={() => {}} onSubmit={() => {}} processing />
    </>,
    80,
  );
  await frame(stdout);
  // Wait for a real spinner repaint, not a fixed delay or a cursor-only write.
  const latest = await waitForFrame(
    stdout,
    (value) => value.includes("inspect-31") && !value.includes("inspect-0"),
  );
  assert.ok(latest.includes("steer now"));
  assert.ok(latest.split("\n").length < 24, "Live output must leave room for the composer");
}
try {
  await checkIncrementalTranscript();
  await checkToolTail();
} finally {
  for (const session of sessions) {
    session.unmount();
    session.cleanup();
  }
}
