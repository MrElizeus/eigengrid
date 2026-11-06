import { accessSync, chmodSync, constants, lstatSync, mkdirSync, statSync } from "fs";
import { delimiter, resolve } from "path";

export function assertSafeJobId(jobId: string): void {
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(jobId)) {
    throw new Error(`Unsafe job identifier for local execution: ${jobId}`);
  }
}

export function ensurePrivateJobDirectory(path: string): void {
  mkdirSync(path, { recursive: true });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Local job directory is not a real directory: ${path}`);
  }
  chmodSync(path, 0o700);
}

export function assertSafeFileTarget(path: string, label: string): void {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`Local ${label} is not a regular file: ${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
}

export function resolveExecutablePath(
  command: string,
  cwd: string,
  env: Record<string, string> | undefined,
): string | null {
  const candidates = command.includes("/")
    ? [resolve(cwd, command)]
    : (env?.PATH ?? process.env.PATH ?? "")
        .split(delimiter)
        .map((directory) => resolve(cwd, directory || ".", command));

  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Continue searching PATH. The eventual failure is materialized below.
    }
  }
  return null;
}
