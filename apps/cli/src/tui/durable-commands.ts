import { runMissionAction, type MissionAction } from "../commands/mission";
import { runAgentSessionAction, type AgentSessionAction } from "../commands/agent-session";
import { readMissionRequestFile } from "../services/mission-request-file";

/** Human-authored commands bypass inference and use the same protected services as CLI/HTTP. */
export async function runDurableInterfaceCommand(
  surface: "mission" | "session",
  args: readonly string[],
  mission = runMissionAction,
  session = runAgentSessionAction,
  read = readMissionRequestFile,
): Promise<unknown> {
  const [action, subject, requestFile] = args;
  if (!action || !subject)
    throw new Error(`Usage: /${surface} <action> <request-file or session-id> [approval-file]`);
  if (surface === "mission") {
    if (args.length !== 2) throw new Error("Use one reviewed mission request file");
    return mission(action as MissionAction, await read(subject));
  }
  if (action === "open") {
    if (args.length !== 2) throw new Error("Use one session request file");
    return session(action, await read(subject));
  }
  if (action === "approve") {
    if (!requestFile || args.length !== 3)
      throw new Error("Approval requires an exact reviewed request file");
    return session(action, { sessionId: subject, approval: await read(requestFile) });
  }
  if (args.length !== 2) throw new Error("Unexpected session arguments");
  return session(action as AgentSessionAction, { sessionId: subject });
}
