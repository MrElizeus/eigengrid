/**
 * tui-stream-state.test.ts
 *
 * Ticket 13, coverage items 4, 5:
 *   4. stream lifecycle commits one assistant final message
 *   5. tool-call result updates existing tool card
 */
import { describe, it, expect } from "bun:test";
import {
  tuiReducer,
  initialTuiState,
  type TuiAction,
} from "../../apps/cli/src/tui/state/tui-reducer";

function applyActions(actions: TuiAction[]) {
  return actions.reduce(tuiReducer, initialTuiState);
}

describe("tuiReducer stream lifecycle", () => {
  it("USER_SUBMIT adds user message and sets processing=true", () => {
    const state = tuiReducer(initialTuiState, { type: "USER_SUBMIT", text: "hello" });
    expect(state.processing).toBe(true);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].kind).toBe("user");
    expect(state.assistantDraft).toBe("");
  });

  it("TEXT_DELTA accumulates into draft without committing", () => {
    const state = applyActions([
      { type: "USER_SUBMIT", text: "hello" },
      { type: "TEXT_DELTA", text: "Hay " },
      { type: "TEXT_DELTA", text: "1 job." },
    ]);
    // Draft accumulated
    expect(state.assistantDraft).toBe("Hay 1 job.");
    // No assistant message committed yet
    const assistantMsgs = state.messages.filter((m) => m.kind === "assistant");
    expect(assistantMsgs).toHaveLength(0);
  });

  it("STREAM_FINISH commits exactly one assistant message", () => {
    const state = applyActions([
      { type: "USER_SUBMIT", text: "hello" },
      { type: "TEXT_DELTA", text: "There is 1 job pending." },
      { type: "STREAM_FINISH" },
    ]);
    const assistantMsgs = state.messages.filter((m) => m.kind === "assistant");
    expect(assistantMsgs).toHaveLength(1);
    expect((assistantMsgs[0] as { text: string }).text).toContain("1 job pending");
    expect(state.assistantDraft).toBe("");
    expect(state.processing).toBe(false);
  });

  it("STREAM_FINISH with empty draft commits zero assistant messages", () => {
    const state = applyActions([{ type: "USER_SUBMIT", text: "hello" }, { type: "STREAM_FINISH" }]);
    const assistantMsgs = state.messages.filter((m) => m.kind === "assistant");
    expect(assistantMsgs).toHaveLength(0);
    expect(state.processing).toBe(false);
  });

  it("TOOL_CALL_START adds tool-call message with status=running", () => {
    const state = applyActions([
      { type: "USER_SUBMIT", text: "list jobs" },
      { type: "TOOL_CALL_START", toolCallId: "tc-1", toolName: "list-jobs" },
    ]);
    const toolMsgs = state.messages.filter((m) => m.kind === "tool-call");
    expect(toolMsgs).toHaveLength(1);
    const tc = toolMsgs[0] as { status: string };
    expect(tc.status).toBe("running");
  });

  it("TOOL_CALL_UPDATE changes tool-call status to ok and sets result", () => {
    const state = applyActions([
      { type: "USER_SUBMIT", text: "list jobs" },
      { type: "TOOL_CALL_START", toolCallId: "tc-1", toolName: "list-jobs" },
      { type: "TOOL_CALL_UPDATE", toolCallId: "tc-1", status: "ok", result: { data: [] } },
    ]);
    const tc = state.messages.find((m) => m.kind === "tool-call") as {
      status: string;
      result: unknown;
    };
    expect(tc?.status).toBe("ok");
    expect(tc?.result).toEqual({ data: [] });
  });

  it("TOOL_CALL_UPDATE does not affect other messages", () => {
    const state = applyActions([
      { type: "USER_SUBMIT", text: "check" },
      { type: "TOOL_CALL_START", toolCallId: "tc-1", toolName: "doctor" },
      { type: "TOOL_CALL_START", toolCallId: "tc-2", toolName: "list-jobs" },
      { type: "TOOL_CALL_UPDATE", toolCallId: "tc-1", status: "ok", result: "dr" },
    ]);
    const tools = state.messages.filter((m) => m.kind === "tool-call") as Array<{
      toolCallId: string;
      status: string;
    }>;
    const tc1 = tools.find((t) => t.toolCallId === "tc-1");
    const tc2 = tools.find((t) => t.toolCallId === "tc-2");
    expect(tc1?.status).toBe("ok");
    expect(tc2?.status).toBe("running");
  });

  it("full round trip produces exactly 1 user + N tool-call + 1 assistant", () => {
    const state = applyActions([
      { type: "USER_SUBMIT", text: "which jobs are pending?" },
      { type: "TOOL_CALL_START", toolCallId: "tc-1", toolName: "list-jobs" },
      {
        type: "TOOL_CALL_UPDATE",
        toolCallId: "tc-1",
        status: "ok",
        result: { data: [{ id: "job-1", status: "queued" }] },
      },
      { type: "TEXT_DELTA", text: "Hay 1 job pendiente." },
      { type: "STREAM_FINISH" },
    ]);
    const users = state.messages.filter((m) => m.kind === "user");
    const tools = state.messages.filter((m) => m.kind === "tool-call");
    const assistants = state.messages.filter((m) => m.kind === "assistant");

    expect(users).toHaveLength(1);
    expect(tools).toHaveLength(1);
    expect(assistants).toHaveLength(1);
    expect(state.processing).toBe(false);
    expect(state.assistantDraft).toBe("");
  });

  it("CLEAR resets everything", () => {
    const state = applyActions([
      { type: "USER_SUBMIT", text: "hello" },
      { type: "TEXT_DELTA", text: "hi" },
      { type: "CLEAR" },
    ]);
    expect(state.messages).toHaveLength(0);
    expect(state.assistantDraft).toBe("");
    expect(state.processing).toBe(false);
  });

  it("STREAM_ERROR commits draft and adds system error message", () => {
    const state = applyActions([
      { type: "USER_SUBMIT", text: "hello" },
      { type: "TEXT_DELTA", text: "partial" },
      { type: "STREAM_ERROR", error: "Connection failed" },
    ]);
    const assistants = state.messages.filter((m) => m.kind === "assistant");
    const errors = state.messages.filter((m) => m.kind === "system") as Array<{
      level: string;
      text: string;
    }>;
    expect(assistants).toHaveLength(1); // partial draft was committed
    expect(errors).toHaveLength(1);
    expect(errors[0].level).toBe("error");
    expect(errors[0].text).toContain("Connection failed");
    expect(state.processing).toBe(false);
  });
});
