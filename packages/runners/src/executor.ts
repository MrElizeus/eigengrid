import { spawnSync } from "node:child_process";
import {
  runCommand,
  spawnCommand,
  type SpawnHandle,
  type RunOptions,
  type RunResult,
} from "./process-utils";

/**
 * Abstraction for executing system commands, enabling clean mocking
 * and dependency injection without polluting native node modules.
 */
export interface CommandExecutor {
  run(command: string, args?: string[], options?: RunOptions): Promise<RunResult>;
  spawn(command: string, args?: string[], options?: RunOptions): SpawnHandle;
  runSync(
    command: string,
    args?: string[],
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      timeout?: number;
    },
  ): {
    status: number | null;
    stdout: Buffer;
    stderr: Buffer;
    error?: Error;
  };
}

/**
 * Default production implementation wrapping native child_process execution.
 */
export class DefaultCommandExecutor implements CommandExecutor {
  async run(command: string, args: string[] = [], options?: RunOptions): Promise<RunResult> {
    return runCommand(command, args, options);
  }

  spawn(command: string, args: string[] = [], options?: RunOptions): SpawnHandle {
    return spawnCommand(command, args, options);
  }

  runSync(
    command: string,
    args: string[] = [],
    options?: { cwd?: string; env?: Record<string, string>; timeout?: number },
  ) {
    const res = spawnSync(command, args, {
      cwd: options?.cwd,
      env: options?.env ? { ...process.env, ...options.env } : process.env,
      stdio: "pipe",
      timeout: options?.timeout,
    });
    return {
      status: res.status,
      stdout: res.stdout as Buffer,
      stderr: res.stderr as Buffer,
      error: res.error,
    };
  }
}
