import {
  createNodeHeartbeat,
  DurableNodeHeartbeatJournal,
  type NodeHeartbeat,
} from "@eigengrid/protocol";
import { z } from "zod";

export const WorkerLivenessSchema = z
  .object({
    nodeId: z.string().min(1),
    lastSeenAt: z.string().datetime({ offset: true }).nullable(),
    now: z.string().datetime({ offset: true }),
    staleAfterMilliseconds: z.number().int().positive(),
    unreachableAfterMilliseconds: z.number().int().positive(),
    announcedStatus: z.enum([
      "healthy",
      "stale",
      "unreachable",
      "draining",
      "incompatible",
      "degraded",
    ]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.unreachableAfterMilliseconds <= value.staleAfterMilliseconds) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["unreachableAfterMilliseconds"],
        message: "unreachable threshold must be greater than stale threshold",
      });
    }
  });
export type WorkerLiveness = z.infer<typeof WorkerLivenessSchema>;

export function classifyWorkerLiveness(input: WorkerLiveness): NodeHeartbeat["status"] {
  const value = WorkerLivenessSchema.parse(input);
  if (
    value.announcedStatus === "draining" ||
    value.announcedStatus === "incompatible" ||
    value.announcedStatus === "degraded"
  ) {
    return value.announcedStatus;
  }
  if (value.lastSeenAt === null) return "unreachable";
  const age = Date.parse(value.now) - Date.parse(value.lastSeenAt);
  if (!Number.isFinite(age) || age < 0) return "degraded";
  if (age >= value.unreachableAfterMilliseconds) return "unreachable";
  if (age >= value.staleAfterMilliseconds) return "stale";
  return "healthy";
}

export interface WorkerHeartbeatReporterOptions {
  nodeId: string;
  instanceId: string;
  fence: string;
  capabilityDigest: `sha256:${string}`;
  intervalMilliseconds: number;
  expiresAfterMilliseconds: number;
  now?: () => Date;
  sink: (heartbeat: NodeHeartbeat) => Promise<void> | void;
  journal?: DurableNodeHeartbeatJournal;
}

/**
 * Deterministic worker liveness reporter.  It emits only the signed/digested
 * protocol envelope; transport and Head authority remain outside the worker.
 */
export class WorkerHeartbeatReporter {
  readonly #options: WorkerHeartbeatReporterOptions;
  #sequence = 0;
  #timer: ReturnType<typeof setInterval> | undefined;
  #stopped = true;
  #last: NodeHeartbeat | undefined;

  constructor(options: WorkerHeartbeatReporterOptions) {
    if (!Number.isInteger(options.intervalMilliseconds) || options.intervalMilliseconds <= 0) {
      throw new Error("heartbeat interval must be a positive integer");
    }
    if (
      !Number.isInteger(options.expiresAfterMilliseconds) ||
      options.expiresAfterMilliseconds <= 0
    ) {
      throw new Error("heartbeat expiry must be a positive integer");
    }
    this.#options = options;
  }

  get sequence(): number {
    return this.#sequence;
  }

  get last(): NodeHeartbeat | undefined {
    return this.#last;
  }

  async emit(status: NodeHeartbeat["status"] = "healthy"): Promise<NodeHeartbeat> {
    const now = this.#options.now?.() ?? new Date();
    const sentAt = now.toISOString();
    const expiresAt = new Date(
      now.getTime() + this.#options.expiresAfterMilliseconds,
    ).toISOString();
    const heartbeat = createNodeHeartbeat({
      nodeId: this.#options.nodeId,
      instanceId: this.#options.instanceId,
      fence: this.#options.fence,
      sequence: this.#sequence,
      status,
      capabilityDigest: this.#options.capabilityDigest,
      sentAt,
      expiresAt,
    });
    // Persist before transport so a successful external observation can never
    // be acknowledged without a local durable record.
    if (this.#options.journal) await this.#options.journal.append(heartbeat);
    await this.#options.sink(heartbeat);
    this.#last = heartbeat;
    this.#sequence += 1;
    return heartbeat;
  }

  async start(): Promise<NodeHeartbeat> {
    if (!this.#stopped) throw new Error("worker heartbeat reporter is already running");
    this.#stopped = false;
    const first = await this.emit("healthy");
    this.#timer = setInterval(() => {
      void this.emit("healthy").catch(() => undefined);
    }, this.#options.intervalMilliseconds);
    return first;
  }

  async stop(): Promise<NodeHeartbeat | undefined> {
    if (this.#stopped) return this.#last;
    this.#stopped = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    return this.emit("draining");
  }
}
