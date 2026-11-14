import { z } from "zod";
import { openSchema, sessionIdSchema } from "./agent-session-requests";
import { configuredMissionHttpClient, type MissionHttpClient } from "./mission-http-client";

type RemoteClient = Pick<MissionHttpClient, "config" | "run">;

/** One configured scope and one attempt per operation; remote uncertainty fences still apply. */
export async function startConfiguredAgentSession(
  value: unknown,
  provide: () => Promise<RemoteClient | null | undefined> = configuredMissionHttpClient,
): Promise<unknown> {
  const prompt = openSchema.shape.prompt.parse(value);
  const remote = await provide();
  if (!remote) throw new Error("Private mission HTTPS client is not configured");
  const { projectId, missionId } = remote.config;
  const opened = await remote.run("open", { projectId, missionId, prompt });
  const { sessionId } = z.object({ sessionId: sessionIdSchema }).parse(opened);
  return remote.run("resume", { sessionId });
}
