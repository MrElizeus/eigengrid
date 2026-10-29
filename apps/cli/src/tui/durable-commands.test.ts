import { expect, test } from "bun:test";
import { runDurableInterfaceCommand } from "./durable-commands";

test("human TUI commands use the same mission/session application calls without inference", async () => {
  const calls: unknown[] = [];
  const mission = async (action: unknown, value: unknown) => {
    calls.push({ surface: "mission", action, value });
    return { state: "ready" };
  };
  const session = async (action: unknown, value: unknown) => {
    calls.push({ surface: "session", action, value });
    return { phase: "ready" };
  };
  const read = async (file: string) => ({ file });
  await runDurableInterfaceCommand("mission", ["status", "request.json"], mission, session, read);
  await runDurableInterfaceCommand(
    "session",
    ["approve", "session-id", "approval.json"],
    mission,
    session,
    read,
  );
  expect(calls).toEqual([
    { surface: "mission", action: "status", value: { file: "request.json" } },
    {
      surface: "session",
      action: "approve",
      value: { sessionId: "session-id", approval: { file: "approval.json" } },
    },
  ]);
  await expect(
    runDurableInterfaceCommand("session", ["open"], mission, session, read),
  ).rejects.toThrow("Usage");
});
