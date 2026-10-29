import { z } from "zod";
import type { Tool } from "../types";
import { closeSync, constants, fstatSync, openSync, readSync } from "fs";
import { join } from "path";

const MAX_LOG_BYTES = 64 * 1024;
const MAX_LOG_LINES = 2000;
const DEFAULT_LOG_LINES = 200;
const READ_CHUNK_BYTES = 16 * 1024;

const readLogInput = z.object({
  jobId: z.string().min(1).max(160).describe("Job ID to read logs for"),
  stream: z
    .enum(["stdout", "stderr"])
    .optional()
    .describe("Which stream to read (default: stdout)"),
  lines: z
    .number()
    .int()
    .min(1)
    .max(MAX_LOG_LINES)
    .optional()
    .describe("Maximum lines from the end (default: 200; at most 64 KiB of log content)"),
});

const readLogOutput = z.object({
  ok: z.boolean(),
  content: z.string().optional(),
  path: z.string().optional(),
  truncated: z.boolean().optional(),
  error: z.string().optional(),
});

/** Read a bounded snapshot through the validated descriptor, including for growing logs. */
function readLogTail(path: string, maximumLines: number): { content: string; truncated: boolean } {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile()) throw new Error("Log must be a regular file");
    if (!Number.isSafeInteger(info.size) || info.size < 0) throw new Error("Invalid log size");
    const start = Math.max(0, info.size - MAX_LOG_BYTES);
    const bytes = Buffer.alloc(Math.min(info.size, MAX_LOG_BYTES));
    let read = 0;
    while (read < bytes.length) {
      const count = readSync(
        descriptor,
        bytes,
        read,
        Math.min(READ_CHUNK_BYTES, bytes.length - read),
        start + read,
      );
      if (count === 0) break;
      read += count;
    }
    let offset = 0;
    // A byte boundary may fall inside a UTF-8 code point. Do not return half of it.
    if (start > 0) while (offset < read && (bytes[offset] & 0xc0) === 0x80) offset++;
    const decoded = bytes.subarray(offset, read).toString("utf8");
    const trailingNewline = decoded.endsWith("\n");
    const lines = decoded.split("\n");
    if (trailingNewline) lines.pop();
    let content = lines.slice(-maximumLines).join("\n") + (trailingNewline ? "\n" : "");
    let truncated = start > 0 || lines.length > maximumLines;
    // Invalid UTF-8 may expand to replacement characters; bound the encoded result too.
    const encoded = Buffer.from(content, "utf8");
    if (encoded.length > MAX_LOG_BYTES) {
      let outputStart = encoded.length - MAX_LOG_BYTES;
      while ((encoded[outputStart] & 0xc0) === 0x80) outputStart++;
      content = encoded.subarray(outputStart).toString("utf8");
      truncated = true;
    }
    return { content, truncated };
  } finally {
    closeSync(descriptor);
  }
}

export const readLogTool: Tool<z.infer<typeof readLogInput>, z.infer<typeof readLogOutput>> = {
  name: "read-log",
  description:
    "Read a bounded tail of a job stdout/stderr log (200 lines by default, at most 64 KiB). Truncation is reported explicitly.",
  inputSchema: readLogInput,
  outputSchema: readLogOutput,
  async execute(ctx, input) {
    const stream = input.stream ?? "stdout";
    const label = stream === "stdout" ? "stdout" : "stderr";

    try {
      const artifacts = await ctx.db.listArtifacts(input.jobId);
      const logArtifact = artifacts.find((a) => a.kind === "log" && a.label === label);

      const candidates: string[] = [];
      if (logArtifact) candidates.push(logArtifact.path);
      const job = await ctx.db.getJob(input.jobId);
      if (job) {
        candidates.push(join(String(job.workdir), input.jobId, `${stream}.log`));
      }
      for (const filePath of candidates) {
        try {
          const tail = readLogTail(filePath, input.lines ?? DEFAULT_LOG_LINES);
          return { ok: true, data: { ok: true, ...tail, path: filePath } };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      return {
        ok: true,
        data: { ok: false, error: `No ${stream} log found for job ${input.jobId}` },
      };
    } catch (err) {
      return { ok: false, error: { code: "READ_ERROR", message: String(err) } };
    }
  },
};
