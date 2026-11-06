import type { Job, JobAttempt } from "@eigengrid/core";
import { generateId } from "@eigengrid/core";
import type { EigenGridEventBase } from "@eigengrid/events";
import { basename, isAbsolute, join, resolve, sep } from "path";
import { type CommandExecutor, DefaultCommandExecutor } from "../executor";
import type { ProcessStartTokenReader } from "../local-identity";
import { LinuxProcTokenReader } from "../local-identity";
import {
  type LocalRunnerDatabase,
  type LocalRunnerEngine,
  type LocalRunnerOptions,
  type ProcessSupervisor,
  type TrackedProcess,
} from "./contracts";
import { assertSafeJobId } from "./paths";
import { DefaultProcessSupervisor } from "./supervisor";

export class LocalRunnerContext {
  processes = new Map<string, TrackedProcess>();

  constructor(readonly options: LocalRunnerOptions = {}) {}

  get db(): LocalRunnerDatabase {
    if (!this.options.database) {
      throw new Error("LocalRunner requires a database instance");
    }
    return this.options.database;
  }

  get executor(): CommandExecutor {
    return this.options.executor ?? new DefaultCommandExecutor();
  }

  get supervisor(): ProcessSupervisor {
    return this.options.supervisor ?? new DefaultProcessSupervisor();
  }

  get tokenReader(): ProcessStartTokenReader {
    return this.options.tokenReader ?? new LinuxProcTokenReader();
  }

  getEngine(job: Job): LocalRunnerEngine {
    const engine = this.options.engines?.[job.software];
    if (!engine) {
      throw new Error(`No local engine configured for ${job.software}`);
    }
    return engine;
  }

  async emitRunnerEvent(event: Omit<EigenGridEventBase, "id" | "at" | "source">): Promise<void> {
    if (!this.db.appendEvent) return;
    const fullEvent: EigenGridEventBase = {
      id: generateId("evt"),
      at: Date.now(),
      source: "runner",
      ...event,
    };
    await this.db.appendEvent(fullEvent);
  }

  jobDir(job: Job): string {
    assertSafeJobId(job.id);
    return join(job.workdir, job.id);
  }

  stagedInputPath(job: Job): string {
    return join(this.jobDir(job), basename(job.inputPath));
  }

  resolvePath(jobDir: string, pathValue: string): string {
    const resolvedPath = resolve(isAbsolute(pathValue) ? pathValue : join(jobDir, pathValue));
    const resolvedJobDir = resolve(jobDir);
    if (resolvedPath !== resolvedJobDir && !resolvedPath.startsWith(`${resolvedJobDir}${sep}`)) {
      throw new Error(`Output path escapes the job directory: ${pathValue}`);
    }
    return resolvedPath;
  }

  // ── Required Restricted-User Execution ──────────────────

  async shouldUseRestrictedUser(): Promise<boolean> {
    const user = this.options.sandboxUser;
    if (user === undefined) return false;
    if (typeof user !== "string" || user.length === 0 || user !== user.trim())
      throw new Error(
        "Required restricted-user execution has an invalid Linux account; refusing current-user fallback",
      );
    const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
    if (!isRoot)
      throw new Error(
        "Required restricted-user execution cannot be established without root; refusing current-user fallback",
      );
    try {
      const result = await this.executor.run("/usr/bin/id", ["-u", "--", user], { timeout: 5_000 });
      if (result.exitCode !== 0 || !/^[1-9][0-9]*$/.test(result.stdout.trim()))
        throw new Error("Restricted account is unavailable or has root privileges");
      return true;
    } catch {
      throw new Error(
        "Required restricted-user execution could not verify a non-root account; refusing current-user fallback",
      );
    }
  }

  // ── Coordinator-Driven Explicit-Attempt Methods ─────────

  async readAttempt(jobDir: string, attemptId: string): Promise<JobAttempt | null> {
    const allAttempts = await this.db.listJobAttempts();
    return allAttempts.find((a) => a.id === attemptId) ?? null;
  }
}
