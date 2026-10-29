import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { Tool } from "@eigengrid/tool-registry";
import { runCommand } from "@eigengrid/runners";
import { resolveOperatorFile } from "../services/operator-permissions";

const readInput = z.object({ path: z.string().min(1).max(4096) });
const readOutput = z.object({ path: z.string(), content: z.string() });
export const readFileTool: Tool<z.infer<typeof readInput>, z.infer<typeof readOutput>> = {
  name: "read-file",
  description: "Read a regular text file, subject to the current execution scope (maximum 64 KiB).",
  inputSchema: readInput,
  outputSchema: readOutput,
  async execute(_ctx, input) {
    const path = resolveOperatorFile(input.path, process.cwd());
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (fstatSync(fd).size > 64 * 1024)
        throw new Error("Read a smaller file or use the job log tools (64 KiB maximum)");
      return { ok: true, data: { path, content: readFileSync(fd, "utf8") } };
    } finally {
      closeSync(fd);
    }
  },
};
const writeInput = z.object({
  path: z.string().min(1).max(4096),
  content: z.string().max(1024 * 1024),
});
const writeOutput = z.object({ path: z.string(), bytes: z.number() });
export const writeFileTool: Tool<z.infer<typeof writeInput>, z.infer<typeof writeOutput>> = {
  name: "write-file",
  description:
    "Create or replace a text input file after host authorization. Cannot modify credentials, permission settings or repository metadata. Parent directory must exist.",
  inputSchema: writeInput,
  outputSchema: writeOutput,
  async execute(_ctx, input) {
    const path = resolveOperatorFile(input.path, process.cwd());
    const temporary = `${dirname(path)}/.eigengrid-edit-${randomUUID()}`;
    const fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, input.content);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(temporary, path);
    } finally {
      try {
        unlinkSync(temporary);
      } catch {
        /* atomic rename consumed it */
      }
    }
    return { ok: true, data: { path, bytes: Buffer.byteLength(input.content) } };
  },
};
const commandInput = z.object({
  command: z.string().min(1).max(4096),
  args: z.array(z.string().max(16384)).max(128).optional(),
  timeoutMs: z.number().int().min(1).max(600000).optional(),
});
const commandOutput = z.object({
  exitCode: z.number().optional(),
  stdout: z.string(),
  stderr: z.string(),
  timedOut: z.boolean(),
});
export const runCommandTool: Tool<z.infer<typeof commandInput>, z.infer<typeof commandOutput>> = {
  name: "run-command",
  description:
    "Run an arbitrary program with argument boundaries under the current OS user. Ask and Auto Review require human approval. Unavailable in Read Only and Autonomous (Sandboxed).",
  inputSchema: commandInput,
  outputSchema: commandOutput,
  async execute(_ctx, input) {
    const result = await runCommand(input.command, input.args ?? [], {
      cwd: process.cwd(),
      timeout: input.timeoutMs ?? 120000,
      maxOutputBytes: 64 * 1024,
      maxErrorBytes: 16 * 1024,
    });
    return {
      ok: true,
      data: {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
      },
    };
  },
};
