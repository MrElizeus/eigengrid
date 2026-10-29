import { afterEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { stripVTControlCharacters } from "node:util";
import { render } from "ink";
import type { ReactNode } from "react";
import { MessageList } from "./MessageList";
import { PromptInput } from "./PromptInput";
import { StatusBar } from "./StatusBar";
import { OperatorWelcome } from "./OperatorWelcome";
import type { TuiMessage } from "../state/tui-types";
import { tuiReducer, initialTuiState } from "../state/tui-reducer";
import { redactCommand } from "../secret-input";
import { terminalText } from "../terminal";

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
  frames: string[] = [];
  write(chunk: string) {
    this.frames.push(stripVTControlCharacters(chunk));
    return true;
  }
}
const sessions: ReturnType<typeof render>[] = [];
function mount(node: ReactNode) {
  const stdout = new Output();
  const session = render(node, {
    stdin: new Input() as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    debug: true,
    patchConsole: false,
  });
  sessions.push(session);
  return { session, stdout };
}
async function frame(stdout: Output) {
  await Bun.sleep(30);
  return stdout.frames.at(-1) ?? "";
}
afterEach(() => {
  for (const session of sessions.splice(0)) {
    session.unmount();
    session.cleanup();
  }
});

describe("operator terminal experience", () => {
  it("keeps a running tool live and commits the final result exactly once", async () => {
    const tool: TuiMessage = {
      id: "tool",
      kind: "tool-call",
      toolCallId: "t",
      toolName: "inspect_job",
      status: "running",
      createdAt: 1,
    };
    const { session, stdout } = mount(<MessageList messages={[tool]} />);
    expect(await frame(stdout)).toContain("running");
    session.rerender(
      <MessageList messages={[{ ...tool, status: "ok", summary: "Evidence collected" }]} />,
    );
    const done = await frame(stdout);
    expect(done).toContain("Evidence collected");
    expect(done).not.toContain("running");
    session.rerender(
      <MessageList
        messages={[
          { ...tool, status: "ok", summary: "Evidence collected" },
          { id: "answer", kind: "assistant", text: "Calculation inspected.", createdAt: 2 },
        ]}
      />,
    );
    const finished = await frame(stdout);
    expect(finished.match(/Evidence collected/g)).toHaveLength(1);
    expect(finished).toContain("Calculation inspected.");
  });

  it("renders tool work as a compact trace and animates its active step", async () => {
    const messages: TuiMessage[] = [
      {
        id: "doctor",
        kind: "tool-call",
        toolCallId: "doctor-call",
        toolName: "doctor",
        status: "ok",
        summary: "4 checks · all ok",
        createdAt: 1,
      },
      {
        id: "nodes",
        kind: "tool-call",
        toolCallId: "nodes-call",
        toolName: "list-nodes",
        status: "ok",
        summary: "0 nodes",
        createdAt: 2,
      },
      {
        id: "inspect",
        kind: "tool-call",
        toolCallId: "inspect-call",
        toolName: "inspect-node",
        status: "running",
        createdAt: 3,
      },
    ];
    const { stdout } = mount(<MessageList messages={messages} />);
    const first = await frame(stdout);
    const lines = first.split("\n");
    const doctorLine = lines.findIndex((line) => line.includes("doctor"));
    const nodesLine = lines.findIndex((line) => line.includes("list-nodes"));
    const inspectLine = lines.findIndex((line) => line.includes("inspect-node"));

    expect(nodesLine).toBe(doctorLine + 1);
    expect(inspectLine).toBe(nodesLine + 1);
    expect(lines[doctorLine]).toContain("├─");
    expect(lines[inspectLine]).toContain("╰─");
    expect(first).toContain("running");

    await Bun.sleep(170);
    const animated = stdout.frames.at(-1) ?? "";
    expect(animated).not.toBe(first);
    expect(animated).toContain("inspect-node");
  });

  it("preserves a multiline warning's severity and removes terminal controls", async () => {
    const { stdout } = mount(
      <MessageList
        messages={[
          {
            id: "warning",
            kind: "system",
            level: "warn",
            text: "Connection lost\nPress r to retry\u001b[2J",
            createdAt: 1,
          },
        ]}
      />,
    );
    const text = await frame(stdout);
    expect(text).toContain("! ATTENTION");
    expect(text).toContain("Connection lost");
    expect(text).toContain("Press r to retry");
    expect(text).not.toContain("\u001b[2J");
  });

  it("masks API keys both in private entry and inline commands", async () => {
    const secret = "sentinel-private-api-key";
    const { session, stdout } = mount(
      <PromptInput value={secret} onChange={() => {}} onSubmit={() => {}} secret />,
    );
    expect(await frame(stdout)).not.toContain(secret);
    expect(await frame(stdout)).toContain("PRIVATE INPUT");
    session.rerender(
      <PromptInput value={`/key ${secret}`} onChange={() => {}} onSubmit={() => {}} />,
    );
    expect(await frame(stdout)).not.toContain(secret);
    expect(redactCommand(`/key ${secret}`)).toBe("/key [hidden]");
    expect(redactCommand(`/models set apiKey ${secret}`)).toBe("/models set apiKey [hidden]");
    expect(redactCommand("/key --forget")).toBe("/key --forget");
    expect(redactCommand("/status")).toBe("/status");
  });

  it("bounds the live draft and retains its latest text", async () => {
    const { stdout } = mount(
      <StatusBar
        processing
        spinnerFrame={0}
        assistantDraft={Array.from({ length: 200 }, (_, i) => `progress ${i}`).join("\n")}
      />,
    );
    const text = await frame(stdout);
    expect(text).toContain("progress 199");
    expect(text).not.toContain("progress 0");
    expect(text).toContain("full response");
    expect(text.split("\n").length).toBeLessThan(24);
  });

  it("does not leave tools spinning when their stream terminates", () => {
    const started = tuiReducer(initialTuiState, {
      type: "TOOL_CALL_START",
      toolCallId: "t",
      toolName: "inspect_job",
    });
    for (const action of [
      { type: "STREAM_FINISH" } as const,
      { type: "STREAM_ERROR", error: "disconnected" } as const,
    ]) {
      const result = tuiReducer(started, action);
      expect(result.messages[0]).toMatchObject({
        kind: "tool-call",
        status: "error",
        summary: "Result not received. Verify the job state before retrying.",
      });
    }
  });

  it("fits the welcome screen at 80 columns", async () => {
    const { stdout } = mount(<OperatorWelcome />);
    const text = await frame(stdout);
    expect(text).toContain("EIGENGRID");
    expect(text).toContain("eigengrid dashboard");
    expect(text.split("\n").length).toBeLessThan(20);
    expect(
      Math.max(...text.split("\n").map((line) => Array.from(line).length)),
    ).toBeLessThanOrEqual(80);
  });

  it("sanitizes external names and preserves intentional multiline logs", () => {
    expect(terminalText("\u001b[31mfailed\u001b[0m\nspoof")).toBe("failed spoof");
    expect(terminalText("one\nsecond\r\x07", true)).toBe("one\nsecond");
    expect(terminalText("\u001b]0;fake title\u0007name")).toBe("name");
  });
});
