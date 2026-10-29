import { z } from "zod";
import {
  AnySubmitterCapabilitySchema,
  SUBMITTER_MAX_BODY_BYTES,
  SUBMITTER_MAX_WIRE_BYTES,
  type AnySubmitterCapability,
} from "@eigengrid/slurm";
import type { AmberSlurmSubmitterBackend } from "./amber-slurm-backend";

const prepareSchema = z
  .object({
    capability: AnySubmitterCapabilitySchema,
    body: z
      .string()
      .min(4)
      .max(Math.ceil(SUBMITTER_MAX_BODY_BYTES / 3) * 4),
  })
  .strict();
const actionSchema = z.object({ action: z.enum(["submit", "observe", "accounting"]) }).strict();
const acknowledgementSchema = z.union([
  z
    .object({
      status: z.literal("acknowledged"),
      jobId: z.string().regex(/^[1-9][0-9]{0,9}$/u),
      cluster: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u),
      resubmitAllowed: z.literal(false),
    })
    .strict(),
  z.object({ status: z.literal("indeterminate"), resubmitAllowed: z.literal(false) }).strict(),
]);
export interface SubmitterBackendChannel {
  readFrame(maxBytes: number, timeoutMs: number): Promise<Uint8Array>;
  requireEnd(timeoutMs: number): Promise<void>;
  writeFrame(value: unknown): Promise<void>;
}

function exactJson<T>(schema: z.ZodType<T>, bytes: Uint8Array): T {
  const text = Buffer.from(bytes).toString("utf8");
  const value = schema.parse(JSON.parse(text));
  if (!Buffer.from(text).equals(Buffer.from(bytes)) || JSON.stringify(value) !== text)
    throw new Error("Backend frame is not exact ordered JSON");
  return value;
}

/** One child, one exact preparation, one effect at most. Parent must be the
 * protected Python boundary; the installed entrypoint proves launch authority
 * before calling this function. EOF before the second frame means NO effect.
 */
export async function serveSubmitterBackendSession(
  channel: SubmitterBackendChannel,
  backend: Pick<AmberSlurmSubmitterBackend, "prepare" | "submit" | "observe"> &
    Partial<Pick<AmberSlurmSubmitterBackend, "accounting">>,
  authorize: (capability: AnySubmitterCapability) => Promise<void>,
): Promise<void> {
  const request = exactJson(prepareSchema, await channel.readFrame(SUBMITTER_MAX_WIRE_BYTES, 5000));
  const body = Buffer.from(request.body, "base64");
  if (
    !body.length ||
    body.length > SUBMITTER_MAX_BODY_BYTES ||
    body.toString("base64") !== request.body
  )
    throw new Error("Invalid backend body encoding");
  await authorize(request.capability);
  const prepared = await backend.prepare(request.capability, body);
  await channel.writeFrame({ status: "prepared", operationId: prepared.operationId });
  const command = exactJson(actionSchema, await channel.readFrame(128, 60_000));
  if (command.action !== request.capability.action)
    throw new Error("Backend action differs from exact prepared authority");
  // Parent closes stdin after its commit frame. Extra frames/bytes are not a
  // second command, and a parent that never finishes cannot prolong authority.
  await channel.requireEnd(5000);
  await authorize(request.capability);
  if (command.action === "submit") {
    const result = await backend.submit(prepared);
    const receipt = acknowledgementSchema.parse(
      result.status === "indeterminate"
        ? { status: "indeterminate", resubmitAllowed: false }
        : result,
    );
    await channel.writeFrame({ status: "result", result: receipt });
  } else if (command.action === "observe") {
    await channel.writeFrame({ status: "result", result: await backend.observe(prepared) });
  } else {
    if (!backend.accounting) throw new Error("Accounting is unavailable in this backend");
    const result = await backend.accounting(prepared);
    await authorize(request.capability);
    await channel.writeFrame({ status: "result", result });
  }
}

/** Binary length framing over a pipe, bounded including a prematurely buffered
 * second frame. No shell, newline protocol, unbounded stdout or retry loop.
 */
export class PipeBackendChannel implements SubmitterBackendChannel {
  private buffer = Buffer.alloc(0);
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  constructor(
    input: ReadableStream<Uint8Array>,
    private readonly output: (bytes: Uint8Array) => Promise<void>,
  ) {
    this.reader = input.getReader();
  }
  private async more(deadline: number): Promise<boolean> {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error("Backend pipe deadline exceeded");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Backend pipe deadline exceeded")), remaining);
        }),
      ]);
      if (result.done) return false;
      if (this.buffer.length + result.value.byteLength > SUBMITTER_MAX_WIRE_BYTES + 256)
        throw new Error("Backend pipe exceeded its bound");
      this.buffer = Buffer.concat([this.buffer, Buffer.from(result.value)]);
      return true;
    } finally {
      clearTimeout(timer);
    }
  }
  async readFrame(maxBytes: number, timeoutMs: number): Promise<Uint8Array> {
    const deadline = performance.now() + timeoutMs;
    while (this.buffer.length < 4)
      if (!(await this.more(deadline))) throw new Error("Incomplete backend frame");
    const length = this.buffer.readUInt32BE(0);
    if (!length || length > maxBytes) throw new Error("Backend frame exceeded its bound");
    while (this.buffer.length < 4 + length)
      if (!(await this.more(deadline))) throw new Error("Incomplete backend frame");
    const value = Buffer.from(this.buffer.subarray(4, 4 + length));
    this.buffer = this.buffer.subarray(4 + length);
    return value;
  }
  async requireEnd(timeoutMs: number): Promise<void> {
    if (this.buffer.length || (await this.more(performance.now() + timeoutMs)))
      throw new Error("Unexpected bytes after backend action");
  }
  async writeFrame(value: unknown): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(value));
    if (!bytes.length || bytes.length > 64 * 1024)
      throw new Error("Backend response exceeded its bound");
    const header = Buffer.alloc(4);
    header.writeUInt32BE(bytes.length);
    await this.output(Buffer.concat([header, bytes]));
  }
  async close(): Promise<void> {
    await this.reader.cancel().catch(() => {});
    this.reader.releaseLock();
  }
}
