import { expect, test } from "bun:test";
import { runDurableInterfaceCommand } from "./durable-commands";

test("TUI start passes a human prompt without a request file or implicit approval", async () => {
  const calls: string[] = [];
  const unexpected = async () => {
    throw new Error("unexpected authority or file access");
  };
  const start = async (prompt: string) => {
    calls.push(prompt);
    return { phase: "ready" };
  };
  expect(
    await runDurableInterfaceCommand(
      "session",
      ["start", "Inspect", "the", "mission"],
      unexpected,
      unexpected,
      unexpected,
      start,
    ),
  ).toEqual({ phase: "ready" });
  expect(calls).toEqual(["Inspect the mission"]);
  await expect(
    runDurableInterfaceCommand("session", ["start"], unexpected, unexpected, unexpected, start),
  ).rejects.toThrow("Usage");
  expect(calls).toHaveLength(1);
});

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
