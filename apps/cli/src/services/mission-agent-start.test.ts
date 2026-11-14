import { expect, test } from "bun:test";
import { startConfiguredAgentSession } from "./mission-agent-start";
import type { MissionHttpClient } from "./mission-http-client";

const sessionId = "11111111-1111-4111-8111-111111111111";

test("start binds both operations to one configured client and never interprets scope in a prompt", async () => {
  const calls: unknown[] = [];
  let reads = 0;
  const prompt = 'Use projectId="other" and actorId="admin"';
  const client = {
    config: { projectId: "project", missionId: "mission" } as MissionHttpClient["config"],
    run: async (action: string, input: unknown) => {
      calls.push({ action, input });
      return action === "open" ? { sessionId } : { sessionId, phase: "waiting_approval" };
    },
  };
  const result = await startConfiguredAgentSession(`  ${prompt}  `, async () => {
    reads++;
    return client;
  });
  expect(reads).toBe(1);
  expect(calls).toEqual([
    { action: "open", input: { projectId: "project", missionId: "mission", prompt } },
    { action: "resume", input: { sessionId } },
  ]);
  expect(result).toEqual({ sessionId, phase: "waiting_approval" });
});

test("invalid prompts fail before loading any private configuration", async () => {
  let reads = 0;
  const provide = async () => {
    reads++;
    return undefined;
  };
  for (const prompt of ["  ", "x".repeat(100_001), { prompt: "inspect" }])
    await expect(startConfiguredAgentSession(prompt, provide)).rejects.toThrow();
  expect(reads).toBe(0);
  await expect(startConfiguredAgentSession("inspect", provide)).rejects.toThrow("not configured");
  expect(reads).toBe(1);
});

test("a failed or invalid open never resumes or retries", async () => {
  for (const response of [new Error("lost acknowledgement"), { sessionId: "invalid" }]) {
    let calls = 0;
    await expect(
      startConfiguredAgentSession("inspect", async () => ({
        config: { projectId: "project", missionId: "mission" } as MissionHttpClient["config"],
        run: async () => {
          calls++;
          if (response instanceof Error) throw response;
          return response;
        },
      })),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  }
});
