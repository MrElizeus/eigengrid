import { configuredMissionHttpClient } from "../services/mission-http-client";
import type { CommandModule } from "yargs";
import { z } from "zod";
import { AgentSessionService } from "../services/agent-sessions";
import { createLocalAgentIdentity, createMissionAgentEffects } from "../services/mission-agent";
import { createMissionBoundInference } from "../services/mission-inference";
import { readMissionRequestFile } from "../services/mission-request-file";

/** Fixed Head-owned path, NOT configurable from CLI args, prompts or HTTP. */
export const AgentSessionRoot = "/var/lib/eigengrid/agent-sessions";

export function openLocalAgentSession(): AgentSessionService {
  const identity = createLocalAgentIdentity();
  let service!: AgentSessionService;
  const effects = createMissionAgentEffects(identity, (id) => service.principal(id));
  service = new AgentSessionService(
    AgentSessionRoot,
    identity,
    createMissionBoundInference((id) => service.principal(id)),
    effects,
  );
  return service;
}

export { sessionIdSchema, openSchema, approvalSchema } from "../services/agent-session-requests";
import { sessionIdSchema, openSchema, approvalSchema } from "../services/agent-session-requests";

type SessionFactory = () => AgentSessionService;
export const agentSessionActions = [
  "open",
  "observe",
  "events",
  "approve",
  "resume",
  "cancel",
  "reconcile",
] as const;
export type AgentSessionAction = (typeof agentSessionActions)[number];
/** Shared transport entrypoint. All validation precedes protected service construction. */
export async function runAgentSessionAction(
  action: AgentSessionAction,
  value: unknown,
  provide: SessionFactory = openLocalAgentSession,
): Promise<unknown> {
  const dispatch = async (input: unknown, local: () => Promise<unknown>) => {
    if (provide === openLocalAgentSession) {
      const remote = await configuredMissionHttpClient();
      if (remote) return remote.run(action, input);
    }
    return local();
  };
  if (action === "open") {
    const input = openSchema.parse(value);
    return dispatch(input, () => provide().open(input));
  }
  const base = z.object({ sessionId: sessionIdSchema });
  if (action === "approve") {
    const input = base.extend({ approval: approvalSchema }).strict().parse(value);
    return dispatch(input, () => provide().approve(input.sessionId, input.approval));
  }
  if (action === "events") {
    const input = base
      .extend({
        after: z.number().int().nonnegative().default(0),
        maximum: z.number().int().min(1).max(256).default(64),
      })
      .strict()
      .parse(value);
    return dispatch(input, () => provide().events(input.sessionId, input.after, input.maximum));
  }
  const input = base.strict().parse(value);
  if (!["observe", "resume", "cancel", "reconcile"].includes(action))
    throw new Error("Invalid session action");
  return dispatch(input, () =>
    provide()[action as "observe" | "resume" | "cancel" | "reconcile"](input.sessionId),
  );
}
export function createAgentSessionCommand(
  provide: SessionFactory = openLocalAgentSession,
  output: (value: unknown) => void = (value) => console.log(JSON.stringify(value, null, 2)),
): CommandModule {
  return {
    command: "agent-session",
    describe: "Host-owned durable scientific agent session with canonical mission authority",
    builder(y) {
      return y
        .command(
          "remote-status",
          "Inspect private HTTPS client scope and unresolved mutation metadata",
          (child) => child.strict(),
          async () => output(await inspectRemoteAgentClient()),
        )
        .command(
          "recover-remote",
          "Explicitly recover the original remote HTTP mutation without retrying its effect",
          (child) => child.strict(),
          async () => output(await recoverRemoteAgentClient()),
        )
        .command(
          "open <request>",
          "Create an authorized project/mission agent session from a JSON request",
          (child) => child.positional("request", { type: "string", demandOption: true }).strict(),
          async (args) => {
            const input = openSchema.parse(await readMissionRequestFile(args.request as string));
            output(await runAgentSessionAction("open", input, provide));
          },
        )
        .command(
          "observe <sessionId>",
          "Read the validated replay state",
          (child) => child.positional("sessionId", { type: "string", demandOption: true }).strict(),
          async (args) => {
            const id = sessionIdSchema.parse(args.sessionId);
            output(await runAgentSessionAction("observe", { sessionId: id }, provide));
          },
        )
        .command(
          "events <sessionId>",
          "Read cursor-based bounded journal events (not a new effect)",
          (child) =>
            child
              .positional("sessionId", { type: "string", demandOption: true })
              .option("after", { type: "number", default: 0 })
              .option("max", { type: "number", default: 64 })
              .strict(),
          async (args) => {
            const id = sessionIdSchema.parse(args.sessionId);
            const after = z.number().int().nonnegative().parse(args.after);
            const max = z.number().int().min(1).max(256).parse(args.max);
            output(
              await runAgentSessionAction(
                "events",
                { sessionId: id, after, maximum: max },
                provide,
              ),
            );
          },
        )
        .command(
          "approve <sessionId> <request>",
          "Grant a bounded, exact-call host approval from JSON (never a model flag)",
          (child) =>
            child
              .positional("sessionId", { type: "string", demandOption: true })
              .positional("request", { type: "string", demandOption: true })
              .strict(),
          async (args) => {
            const id = sessionIdSchema.parse(args.sessionId);
            const input = approvalSchema.parse(
              await readMissionRequestFile(args.request as string),
            );
            output(
              await runAgentSessionAction("approve", { sessionId: id, approval: input }, provide),
            );
          },
        )
        .command(
          "resume <sessionId>",
          "Resume after current-authority checks; no retry of uncertain effects",
          (child) => child.positional("sessionId", { type: "string", demandOption: true }).strict(),
          async (args) => {
            const id = sessionIdSchema.parse(args.sessionId);
            output(await runAgentSessionAction("resume", { sessionId: id }, provide));
          },
        )
        .command(
          "cancel <sessionId>",
          "Install a durable stop barrier; does not forge a Slurm receipt",
          (child) => child.positional("sessionId", { type: "string", demandOption: true }).strict(),
          async (args) => {
            const id = sessionIdSchema.parse(args.sessionId);
            output(await runAgentSessionAction("cancel", { sessionId: id }, provide));
          },
        )
        .command(
          "reconcile <sessionId>",
          "Observe uncertain mission runtime effects without blind retry",
          (child) => child.positional("sessionId", { type: "string", demandOption: true }).strict(),
          async (args) => {
            const id = sessionIdSchema.parse(args.sessionId);
            output(await runAgentSessionAction("reconcile", { sessionId: id }, provide));
          },
        )
        .demandCommand(1)
        .strict();
    },
    handler() {},
  };
}
export const agentSessionCommand = createAgentSessionCommand();

export async function inspectRemoteAgentClient() {
  const remote = await configuredMissionHttpClient();
  return remote ? remote.status() : { configured: false };
}
export async function recoverRemoteAgentClient() {
  const remote = await configuredMissionHttpClient();
  if (!remote) throw new Error("Private mission HTTPS client is not configured");
  return remote.recoverPending();
}
