/** Canonical scientific tools for mission-scoped agent sessions. No raw shell, runner, SQL, paths
 * or Slurm payload reaches an agent. MissionApplication remains effect owner.
 */
import { MissionStartRequestSchema } from "./mission-application";
import { openMissionApplication } from "./mission-composition";
import { MissionLocalAuthority } from "./mission-local-authority";
import { applicationJson } from "./application-json";
import type { AgentToolAuthority } from "@eigengrid/agent-runtime";
import type { AgentPrincipal, AgentSessionIdentity, AgentSessionEffects } from "./agent-sessions";

const statusTool = {
  name: "mission-status",
  description: "Read the state of the current scientific mission; no effects.",
  inputSchema: {
    type: "object",
    required: ["projectId", "missionId"],
    properties: {
      projectId: { type: "string" },
      missionId: { type: "string" },
    },
    additionalProperties: false,
  },
};
const startTool = {
  name: "mission-start",
  description:
    "Request canonical mission start. Requires external human approval and preapproved scientific plan.",
  inputSchema: {
    type: "object",
    required: ["projectId", "missionId", "planId", "candidateDigest"],
    properties: {
      projectId: { type: "string" },
      missionId: { type: "string" },
      planId: { type: "string" },
      candidateDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
    },
    additionalProperties: false,
  },
};
function exactAddress(
  input: unknown,
  principal: AgentPrincipal,
): {
  projectId: string;
  missionId: string;
} {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid canonical mission address");
  const address = input as Record<string, unknown>;
  if (address.projectId !== principal.projectId || address.missionId !== principal.missionId)
    throw new Error("Cross-project mission action denied");
  return { projectId: principal.projectId, missionId: principal.missionId };
}

/** Kernel UID + protected config + canonical MissionApplication access; never
 * accept a request-supplied role, identity, policy or database connection.
 */
export function createLocalAgentIdentity(
  authority: Pick<MissionLocalAuthority, "current" | "assertCurrent"> = new MissionLocalAuthority(),
  open: typeof openMissionApplication = openMissionApplication,
): AgentSessionIdentity {
  const current: AgentSessionIdentity["current"] = async (address) => {
    const identity = await authority.current();
    await authority.assertCurrent(identity);
    const session = await open();
    try {
      await session.application.status(address);
      await authority.assertCurrent(identity);
      return {
        actorId: identity.authenticatedActor.id,
        projectId: address.projectId,
        missionId: address.missionId,
        policyDigest: identity.configDigest,
      };
    } finally {
      await session.close();
    }
  };
  return {
    current,
    async assertCurrent(expected) {
      const p = await current({ projectId: expected.projectId, missionId: expected.missionId });
      if (
        p.actorId !== expected.actorId ||
        p.projectId !== expected.projectId ||
        p.missionId !== expected.missionId ||
        p.policyDigest !== expected.policyDigest
      )
        throw new Error("Agent session identity, mission access or policy revoked");
    },
  };
}

/** Scoped port must be connected to an agent session service's authenticated principal().
 * Every live call binds to the SAME project/mission and current local operator.
 */
export function createMissionAgentEffects(
  identity: AgentSessionIdentity,
  principalFor: (sessionId: string) => Promise<AgentPrincipal>,
  open: typeof openMissionApplication = openMissionApplication,
): AgentSessionEffects {
  const tools: AgentToolAuthority = {
    describe: () => [statusTool, startTool],
    decide: async (call, sessionId) => {
      if (call.name !== statusTool.name && call.name !== startTool.name) return "deny";
      const p = await principalFor(sessionId);
      await identity.assertCurrent(p);
      try {
        const address = exactAddress(call.input, p);
        if (call.name === statusTool.name) {
          const obj = call.input as Record<string, unknown>;
          if (Object.keys(obj).sort().join(",") !== "missionId,projectId") return "deny";
          return "allow";
        }
        MissionStartRequestSchema.parse(call.input);
        if (!address.missionId) return "deny";
        return "ask";
      } catch {
        return "deny";
      }
    },
    execute: async (call, sessionId) => {
      const p = await principalFor(sessionId);
      await identity.assertCurrent(p);
      const address = exactAddress(call.input, p);
      const applicationSession = await open();
      try {
        const result =
          call.name === statusTool.name
            ? await applicationSession.application.status(address)
            : call.name === startTool.name
              ? await applicationSession.application.start(
                  MissionStartRequestSchema.parse(call.input),
                )
              : (() => {
                  throw new Error("Unknown scientific agent tool");
                })();
        await identity.assertCurrent(p);
        return { id: call.id, tool: call.name, ok: true, result: applicationJson(result) };
      } finally {
        await applicationSession.close();
      }
    },
  };
  return {
    tools,
    async observeUncertain(p, sessionId, call) {
      const current = await principalFor(sessionId);
      await identity.assertCurrent(current);
      exactAddress(call.input, current);
      const session = await open();
      try {
        if (call.name === statusTool.name) {
          const result = await session.application.status({
            projectId: p.projectId,
            missionId: p.missionId,
          });
          return {
            status: "RESOLVED",
            receiptId: `read-${sessionId}-${call.id}`,
            observation: {
              id: call.id,
              tool: call.name,
              ok: true,
              result: applicationJson(result),
            },
          };
        }
        if (call.name !== startTool.name) return { status: "BLOCKED" };
        const result = await session.application.reconcileStart(
          MissionStartRequestSchema.parse(call.input),
        );
        if (!result) return { status: "UNKNOWN" };
        return {
          status: "RESOLVED",
          receiptId: `mission-${result.id}-r${result.revision}`,
          observation: { id: call.id, tool: call.name, ok: true, result: applicationJson(result) },
        };
      } finally {
        await session.close();
      }
    },
  };
}
