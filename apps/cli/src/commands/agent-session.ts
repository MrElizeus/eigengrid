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

export const sessionIdSchema = z.string().uuid();
export const openSchema = z
  .object({
    projectId: z.string().min(1).max(160),
    missionId: z.string().min(1).max(160),
    prompt: z.string().trim().min(1).max(100_000),
    requestId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,159}$/u)
      .optional(),
  })
  .strict();
export const approvalSchema = z
  .object({
    callId: z.string().min(1).max(128),
    inputDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    cursor: z
      .object({
        sequence: z.number().int().positive(),
        digest: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict(),
    ttlSeconds: z.number().int().min(1).max(900),
  })
  .strict();

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
  if (action === "open") {
    const input = openSchema.parse(value);
    return provide().open(input);
  }
  const base = z.object({ sessionId: sessionIdSchema });
  if (action === "approve") {
    const input = base.extend({ approval: approvalSchema }).strict().parse(value);
    return provide().approve(input.sessionId, input.approval);
  }
  if (action === "events") {
    const input = base
      .extend({
        after: z.number().int().nonnegative().default(0),
        maximum: z.number().int().min(1).max(256).default(64),
      })
      .strict()
      .parse(value);
    return provide().events(input.sessionId, input.after, input.maximum);
  }
  const input = base.strict().parse(value);
  if (!["observe", "resume", "cancel", "reconcile"].includes(action))
    throw new Error("Invalid session action");
  return provide()[action as "observe" | "resume" | "cancel" | "reconcile"](input.sessionId);
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
          "open <request>",
          "Create an authorized project/mission agent session from a JSON request",
          (child) => child.positional("request", { type: "string", demandOption: true }).strict(),
          async (args) => {
            const input = openSchema.parse(await readMissionRequestFile(args.request as string));
            output(await provide().open(input));
          },
        )
        .command(
          "observe <sessionId>",
          "Read the validated replay state",
          (child) => child.positional("sessionId", { type: "string", demandOption: true }).strict(),
          async (args) => {
            const id = sessionIdSchema.parse(args.sessionId);
            output(await provide().observe(id));
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
            output(await provide().events(id, after, max));
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
            output(await provide().approve(id, input));
          },
        )
        .command(
          "resume <sessionId>",
          "Resume after current-authority checks; no retry of uncertain effects",
          (child) => child.positional("sessionId", { type: "string", demandOption: true }).strict(),
          async (args) => {
            const id = sessionIdSchema.parse(args.sessionId);
            output(await provide().resume(id));
          },
        )
        .command(
          "cancel <sessionId>",
          "Install a durable stop barrier; does not forge a Slurm receipt",
          (child) => child.positional("sessionId", { type: "string", demandOption: true }).strict(),
          async (args) => {
            const id = sessionIdSchema.parse(args.sessionId);
            output(await provide().cancel(id));
          },
        )
        .command(
          "reconcile <sessionId>",
          "Observe uncertain mission runtime effects without blind retry",
          (child) => child.positional("sessionId", { type: "string", demandOption: true }).strict(),
          async (args) => {
            const id = sessionIdSchema.parse(args.sessionId);
            output(await provide().reconcile(id));
          },
        )
        .demandCommand(1)
        .strict();
    },
    handler() {},
  };
}
export const agentSessionCommand = createAgentSessionCommand();
