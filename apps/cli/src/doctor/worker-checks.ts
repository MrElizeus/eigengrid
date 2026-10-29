import { existsSync, readFileSync, accessSync, constants } from "fs";
import { join } from "path";
import type { Config, EigenGridRole } from "@eigengrid/core";
import type { CommandExecutor } from "@eigengrid/runners";
import { checkWorkerLayout, getDaemonDir } from "@eigengrid/worker";
import type { DoctorRegistry } from "./checks";

/**
 * Register checks that are relevant only for worker-node deployments.
 */
export function registerWorkerChecks(
  registry: DoctorRegistry,
  executor: CommandExecutor,
  config: Config,
): void {
  const WORKER: EigenGridRole = "worker";

  // ── Remote scratch directory ─────────────────────────────────────

  registry.register(
    "remote-scratch-dir",
    () => {
      const dir = config.remoteScratchDir;
      if (!dir) {
        return {
          name: "remote-scratch-dir",
          status: "warn",
          detail: "no remoteScratchDir configured",
        };
      }
      if (!existsSync(dir)) {
        return {
          name: "remote-scratch-dir",
          status: "error",
          detail: `${dir} does not exist`,
        };
      }
      try {
        accessSync(dir, constants.W_OK);
        return { name: "remote-scratch-dir", status: "ok", detail: dir };
      } catch {
        return {
          name: "remote-scratch-dir",
          status: "error",
          detail: `${dir} is not writable`,
        };
      }
    },
    WORKER,
  );

  // ── Shell availability ───────────────────────────────────────────

  registry.register(
    "bash-exists",
    () => {
      const result = executor.runSync("command", ["-v", "bash"]);
      return {
        name: "bash-exists",
        status: result.status === 0 ? "ok" : "error",
        detail: result.status === 0 ? result.stdout.toString().trim() : "bash not found",
      };
    },
    WORKER,
  );

  registry.register(
    "sh-exists",
    () => {
      const result = executor.runSync("command", ["-v", "sh"]);
      return {
        name: "sh-exists",
        status: result.status === 0 ? "ok" : "error",
        detail: result.status === 0 ? result.stdout.toString().trim() : "sh not found",
      };
    },
    WORKER,
  );

  // ── sshd (optional) ──────────────────────────────────────────────

  registry.register(
    "sshd-available",
    () => {
      const result = executor.runSync("command", ["-v", "sshd"]);
      return {
        name: "sshd-available",
        status: result.status === 0 ? "ok" : "optional",
        detail: result.status === 0 ? result.stdout.toString().trim() : "sshd not found (optional)",
      };
    },
    WORKER,
  );

  // ── Worker layout check ────────────────────────────────────────────
  // Verifies that the remoteScratchDir has all required subdirectories
  // for the worker daemon to operate.

  registry.register(
    "worker-layout",
    () => {
      const scratchDir = config.remoteScratchDir;
      if (!scratchDir) {
        return {
          name: "worker-layout",
          status: "error",
          detail: "no remoteScratchDir configured — cannot check layout",
        };
      }

      if (!existsSync(scratchDir)) {
        return {
          name: "worker-layout",
          status: "error",
          detail: `${scratchDir} does not exist — run 'eigengrid worker daemon --init'`,
        };
      }

      const layout = checkWorkerLayout(scratchDir);
      if (layout.ok) {
        return {
          name: "worker-layout",
          status: "ok",
          detail: "all required subdirectories exist",
        };
      }

      if (layout.missing.length === 7) {
        return {
          name: "worker-layout",
          status: "error",
          detail: `worker layout not initialized at ${scratchDir} — run 'eigengrid worker daemon --init'`,
        };
      }

      return {
        name: "worker-layout",
        status: "warn",
        detail: `missing subdirectories: ${layout.missing.join(", ")}`,
      };
    },
    WORKER,
  );

  // ── Daemon not running check ───────────────────────────────────────
  // Checks if a daemon PID file exists and whether the process is alive.
  // A running daemon during doctor could indicate a conflict.

  registry.register(
    "daemon-not-running",
    () => {
      const scratchDir = config.remoteScratchDir;
      if (!scratchDir) {
        return {
          name: "daemon-not-running",
          status: "ok",
          detail: "no remoteScratchDir configured",
        };
      }

      const daemonDir = getDaemonDir(scratchDir);
      const pidFilePath = join(daemonDir, "daemon.pid");

      if (!existsSync(pidFilePath)) {
        return {
          name: "daemon-not-running",
          status: "ok",
          detail: "no daemon PID file found",
        };
      }

      // Read PID file
      let pid: number;
      try {
        const pidContent = readFileSync(pidFilePath, "utf-8").trim();
        pid = parseInt(pidContent, 10);
        if (isNaN(pid) || pid <= 0) {
          return {
            name: "daemon-not-running",
            status: "ok",
            detail: `invalid PID in ${pidFilePath}`,
          };
        }
      } catch {
        return {
          name: "daemon-not-running",
          status: "ok",
          detail: `cannot read PID file: ${pidFilePath}`,
        };
      }

      // Check if the process is alive
      try {
        // Sending signal 0 tests if the process exists without actually sending a signal
        process.kill(pid, 0);
        return {
          name: "daemon-not-running",
          status: "warn",
          detail: `daemon is running with PID ${pid} — may conflict with doctor operations`,
        };
      } catch {
        return {
          name: "daemon-not-running",
          status: "ok",
          detail: `stale PID file (process ${pid} not running)`,
        };
      }
    },
    WORKER,
  );
}
