import { existsSync, accessSync, constants } from "fs";
import { getEigenGridDir, getConfigPath } from "@eigengrid/config";
import type { Config } from "@eigengrid/core";
import { createDatabaseFromConfig } from "@eigengrid/db";
import type { CommandExecutor } from "@eigengrid/runners";
import type { DoctorRegistry } from "./checks";

/**
 * Register all common checks that apply to every deployment role.
 *
 * Each check obtains the executor and config it needs via closure at registration
 * time — no singleton state is shared between checks.
 */
export function registerCommonChecks(
  registry: DoctorRegistry,
  executor: CommandExecutor,
  config: Config,
): void {
  // ── Runtime ──────────────────────────────────────────────────────

  registry.register("bun-runtime", () => ({
    name: "bun-runtime",
    status: "ok",
    detail: process.version,
  }));

  // ── Python ───────────────────────────────────────────────────────

  registry.register("python-command", () => {
    const py = executor.runSync(config.pythonCommand, ["--version"]);
    if (py.status === 0) {
      return {
        name: "python-command",
        status: "ok",
        detail: py.stdout.toString().trim(),
      };
    }
    return {
      name: "python-command",
      status: "error",
      detail: `${config.pythonCommand} not found in PATH`,
    };
  });

  // ── eigengrid_chem ───────────────────────────────────────────────

  registry.register("eigengrid-chem", () => {
    const chem = executor.runSync(config.pythonCommand, ["-m", "eigengrid_chem", "--version"]);
    if (chem.status === 0) {
      return {
        name: "eigengrid-chem",
        status: "ok",
        detail: chem.stdout.toString().trim(),
      };
    }
    return {
      name: "eigengrid-chem",
      status: "error",
      detail: "Python chemistry package not installed",
    };
  });

  // ── .eigengrid directory ─────────────────────────────────────────

  registry.register("eigengrid-dir", () => {
    const egDir = getEigenGridDir();
    return {
      name: "eigengrid-dir",
      status: existsSync(egDir) ? "ok" : "missing",
      detail: egDir,
    };
  });

  // ── eigengrid.yaml ───────────────────────────────────────────────

  registry.register("eigengrid-config", () => {
    const cfgPath = getConfigPath();
    if (!existsSync(cfgPath)) {
      return {
        name: "eigengrid-config",
        status: "missing",
        detail: `${cfgPath} not found`,
      };
    }
    return {
      name: "eigengrid-config",
      status: "ok",
      detail: "parsed successfully",
    };
  });

  // ── SQLite database ──────────────────────────────────────────────

  registry.register("sqlite-init", async () => {
    let db: Awaited<ReturnType<typeof createDatabaseFromConfig>> | undefined;
    try {
      db = await createDatabaseFromConfig(config);
      return { name: "sqlite-init", status: "ok" };
    } catch (err) {
      return {
        name: "sqlite-init",
        status: "error",
        detail: err instanceof Error ? err.message : "database init failed",
      };
    } finally {
      await db?.close();
    }
  });

  // ── Working directories (exist + writable) ───────────────────────

  registerDirCheck(registry, "jobs-dir", config.jobsDir);
  registerDirCheck(registry, "logs-dir", config.logsDir);
  registerDirCheck(registry, "outputs-dir", config.outputsDir);
  registerDirCheck(registry, "sessions-dir", config.sessionsDir);

  // ── Optional software ────────────────────────────────────────────

  registry.register("orca-optional", () => {
    const orca = executor.runSync("which", ["orca"]);
    if (orca.status === 0) {
      const ver = executor.runSync("orca", ["--version"]);
      const version =
        ver.status === 0 ? ver.stdout.toString().trim() : orca.stdout.toString().trim();
      return { name: "orca-optional", status: "ok", detail: version };
    }
    return {
      name: "orca-optional",
      status: "optional",
      detail: "not found (optional)",
    };
  });

  registry.register("gaussian-optional", () => {
    const g16 = executor.runSync("which", ["g16"]);
    return {
      name: "gaussian-optional",
      status: g16.status === 0 ? "ok" : "optional",
      detail: g16.status === 0 ? g16.stdout.toString().trim() : "not found (optional)",
    };
  });
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Register a single directory-exists-and-writable check.
 */
function registerDirCheck(registry: DoctorRegistry, name: string, dir: string): void {
  registry.register(name, () => {
    if (!existsSync(dir)) {
      return { name, status: "error", detail: `${dir} does not exist` };
    }
    try {
      accessSync(dir, constants.W_OK);
      return { name, status: "ok", detail: dir };
    } catch {
      return { name, status: "error", detail: `${dir} is not writable` };
    }
  });
}
