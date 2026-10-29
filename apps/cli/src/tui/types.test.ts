import { describe, it, expect } from "bun:test";
import {
  isUserMessage,
  isAssistantMessage,
  isToolCallMessage,
  isSystemMessage,
  nextMessageId,
  type TuiMessage,
  type ToolCallViewModel,
  type StreamingState,
} from "./types";

describe("TuiMessage type guards", () => {
  describe("isUserMessage", () => {
    it("returns true for a user message", () => {
      const msg: TuiMessage = { id: "1", kind: "user", text: "hello" };
      expect(isUserMessage(msg)).toBe(true);
    });

    it("returns false for non-user messages", () => {
      const banner: TuiMessage = { id: "1", kind: "banner", lines: ["logo"] };
      const assistant: TuiMessage = { id: "2", kind: "assistant", text: "hi" };
      const toolCall: TuiMessage = {
        id: "3",
        kind: "tool-call",
        tool: "doctor",
        args: {},
        status: "running",
      };
      const system: TuiMessage = { id: "4", kind: "system", level: "info", text: "ready" };
      expect(isUserMessage(banner)).toBe(false);
      expect(isUserMessage(assistant)).toBe(false);
      expect(isUserMessage(toolCall)).toBe(false);
      expect(isUserMessage(system)).toBe(false);
    });
  });

  describe("isAssistantMessage", () => {
    it("returns true for an assistant message", () => {
      const msg: TuiMessage = { id: "1", kind: "assistant", text: "response" };
      expect(isAssistantMessage(msg)).toBe(true);
    });

    it("returns false for non-assistant messages", () => {
      const user: TuiMessage = { id: "1", kind: "user", text: "q" };
      expect(isAssistantMessage(user)).toBe(false);
    });
  });

  describe("isToolCallMessage", () => {
    it("returns true for a tool-call message", () => {
      const msg: TuiMessage = {
        id: "1",
        kind: "tool-call",
        tool: "doctor",
        args: {},
        status: "running",
      };
      expect(isToolCallMessage(msg)).toBe(true);
    });

    it("returns false for non-tool-call messages", () => {
      const msg: TuiMessage = { id: "1", kind: "assistant", text: "no" };
      expect(isToolCallMessage(msg)).toBe(false);
    });
  });

  describe("isSystemMessage", () => {
    it("returns true for a system message", () => {
      const msg: TuiMessage = { id: "1", kind: "system", level: "warn", text: "low disk" };
      expect(isSystemMessage(msg)).toBe(true);
    });

    it("returns false for non-system messages", () => {
      const msg: TuiMessage = { id: "1", kind: "user", text: "q" };
      expect(isSystemMessage(msg)).toBe(false);
    });
  });
});

describe("nextMessageId", () => {
  it("returns a string starting with the given prefix", () => {
    const id = nextMessageId("msg");
    expect(typeof id).toBe("string");
    expect(id.startsWith("msg-")).toBe(true);
  });

  it("produces incrementing sequence numbers for the same prefix", () => {
    const a = nextMessageId("x");
    const b = nextMessageId("x");
    expect(a).not.toBe(b);
    // Both start with "x-" and contain a timestamp
    const partsA = a.split("-");
    const partsB = b.split("-");
    expect(partsA[0]).toBe("x");
    expect(partsB[0]).toBe("x");
    // Sequence part should increment
    expect(Number(partsA[2])).toBeGreaterThanOrEqual(0);
    expect(Number(partsB[2])).toBe(Number(partsA[2]) + 1);
  });

  it("handles different prefixes independently", () => {
    const a = nextMessageId("a");
    const b = nextMessageId("b");
    expect(a.startsWith("a-")).toBe(true);
    expect(b.startsWith("b-")).toBe(true);
  });
});

describe("StreamingState structure", () => {
  it("can be created with default empty state", () => {
    const state: StreamingState = {
      messages: [],
      draftAssistant: "",
      activeToolCalls: [],
      isProcessing: false,
    };
    expect(state.messages).toHaveLength(0);
    expect(state.draftAssistant).toBe("");
    expect(state.activeToolCalls).toHaveLength(0);
    expect(state.isProcessing).toBe(false);
  });

  it("can hold typed messages and tool call view models", () => {
    const toolCall: ToolCallViewModel = {
      id: "tc-1",
      tool: "doctor",
      args: {},
      status: "running",
      startTime: Date.now(),
    };
    const msg: TuiMessage = { id: "m1", kind: "user", text: "run doctor" };
    const state: StreamingState = {
      messages: [msg],
      draftAssistant: "",
      activeToolCalls: [toolCall],
      isProcessing: true,
    };
    expect(state.messages).toHaveLength(1);
    expect(state.activeToolCalls).toHaveLength(1);
    expect(state.activeToolCalls[0].tool).toBe("doctor");
    expect(state.isProcessing).toBe(true);
  });
});

describe("ToolCallViewModel", () => {
  it("tracks status transitions for tool call lifecycle", () => {
    const tc: ToolCallViewModel = {
      id: "tc-1",
      tool: "submit-job",
      args: { software: "orca", inputPath: "/tmp/test.inp" },
      status: "running",
      startTime: 1000,
    };
    expect(tc.status).toBe("running");

    tc.status = "ok";
    tc.result = { jobId: "job-123" };
    expect(tc.status).toBe("ok");
    expect(tc.result).toEqual({ jobId: "job-123" });

    tc.status = "error";
    tc.result = { message: "failed" };
    expect(tc.status).toBe("error");
  });
});
