import type { CommandModule } from "yargs";
import { existsSync } from "fs";
import { hostname } from "os";
import { getEigenGridDir, loadConfig, readRoleFromConfig } from "@eigengrid/config";
import { createDatabaseFromConfig } from "@eigengrid/db";
import type { DatabaseLike } from "@eigengrid/db";
import { DefaultCommandExecutor, type CommandExecutor } from "@eigengrid/runners";
import type { EigenGridRole } from "@eigengrid/core";
import { createDoctorRegistry } from "../doctor/checks";
import { registerCommonChecks } from "../doctor/common-checks";
import { registerHeadChecks } from "../doctor/head-checks";
import { registerWorkerChecks } from "../doctor/worker-checks";

type DoctorArgs = {
  role?: string;
  json?: boolean;
};

type DoctorDependencies = {
  executor?: CommandExecutor;
  readRoleFromConfig?: typeof readRoleFromConfig;
  loadConfig?: typeof loadConfig;
  /** Test seam for the legacy SQLite-only compatibility path. */
  createDatabase?: (path: string) => DatabaseLike;
  getEigenGridDir?: typeof getEigenGridDir;
};

export const doctorCommand: CommandModule = {
  command: "doctor",
  describe: "Run environment diagnostics",
  builder: (y) =>
    y
      .option("role", {
        type: "string",
        choices: ["standalone", "head", "worker"] as const,
        describe: "Deployment role to diagnose for",
      })
      .option("json", {
        type: "boolean",
        describe: "Output results as JSON",
      }),
  async handler(argv) {
    await runDoctor(argv as unknown as DoctorArgs);
  },
};

export async function runDoctor(args: DoctorArgs, deps: DoctorDependencies = {}): Promise<void> {
  const executor = deps.executor ?? new DefaultCommandExecutor();
  const configRole = (deps.readRoleFromConfig ?? readRoleFromConfig)();

  // If neither --role nor the config file has an explicit role field,
  // fall back to legacy behaviour (check everything, no role filtering).
  if (!args.role && !configRole) {
    await legacyDoctor(executor, deps);
    return;
  }

  // Role-aware modular doctor.
  const config = await (deps.loadConfig ?? loadConfig)();
  const effectiveRole: EigenGridRole = args.role ? (args.role as EigenGridRole) : configRole!;
  await modularDoctor(executor, config, effectiveRole, args.json ?? false);
}

// ────────────────────────────────────────────────────────────────────────
// Legacy doctor — keeps the original behaviour when no --role is specified
// ────────────────────────────────────────────────────────────────────────

async function legacyDoctor(executor: CommandExecutor, deps: DoctorDependencies): Promise<void> {
  const config = await (deps.loadConfig ?? loadConfig)();
  const checks: { name: string; status: string; detail?: string }[] = [];

  // Bun
  checks.push({ name: "Bun runtime", status: "ok", detail: process.version });

  // Python
  const py = executor.runSync(config.pythonCommand, ["--version"]);
  if (py.status === 0) {
    checks.push({ name: "Python", status: "ok", detail: py.stdout.toString().trim() });
  } else {
    checks.push({
      name: "Python",
      status: "missing",
      detail: `${config.pythonCommand} not found in PATH`,
    });
  }

  // eigengrid_chem
  const chem = executor.runSync(config.pythonCommand, ["-m", "eigengrid_chem", "--version"]);
  if (chem.status === 0) {
    checks.push({ name: "eigengrid_chem", status: "ok", detail: chem.stdout.toString().trim() });
  } else {
    checks.push({
      name: "eigengrid_chem",
      status: "missing",
      detail: "Python chemistry package not installed",
    });
  }

  // .eigengrid dir
  const egDir = (deps.getEigenGridDir ?? getEigenGridDir)();
  checks.push({
    name: "EigenGrid directory",
    status: existsSync(egDir) ? "ok" : "missing",
    detail: egDir,
  });

  // Gaussian
  const g16 = executor.runSync("which", ["g16"]);
  checks.push({
    name: "Gaussian (g16)",
    status: g16.status === 0 ? "ok" : "optional",
    detail: g16.status === 0 ? g16.stdout.toString().trim() : "not found (optional)",
  });

  // ORCA
  const orca = executor.runSync("which", ["orca"]);
  if (orca.status === 0) {
    const orcaVer = executor.runSync("orca", ["--version"]);
    const version =
      orcaVer.status === 0 ? orcaVer.stdout.toString().trim() : orca.stdout.toString().trim();
    checks.push({ name: "ORCA", status: "ok", detail: version });
  } else {
    checks.push({ name: "ORCA", status: "optional", detail: "not found (optional)" });
  }

  // SSH connectivity check for registered nodes
  let db: DatabaseLike | undefined;
  try {
    if (deps.createDatabase) {
      db = deps.createDatabase(config.databasePath);
      await db.init();
    } else {
      db = await createDatabaseFromConfig(config);
    }
  } catch {
    // DB not initialized, skip SSH checks
  }

  if (db) {
    try {
      const nodes = await db.listNodes();
      const sshNodes = nodes.filter((n) => n.runner === "ssh");

      if (sshNodes.length > 0) {
        checks.push({ name: "", status: "ok", detail: "" });
      }

      for (const n of sshNodes) {
        const nodeName = n.name;
        const nodeHost = n.host;
        const nodePort = n.port ?? 22;
        const keyPath = n.privateKeyPath ?? undefined;

        // Check SSH key
        if (keyPath) {
          if (existsSync(keyPath)) {
            checks.push({ name: `  Node "${nodeName}" SSH key`, status: "ok", detail: keyPath });

            // Check key permissions
            const stat = existsSync(keyPath)
              ? await import("fs").then((fs) => fs.promises.stat(keyPath))
              : null;
            if (stat) {
              const mode = stat.mode & 0o777;
              if (mode > 0o600) {
                checks.push({
                  name: `  Node "${nodeName}" SSH key perms`,
                  status: "warn",
                  detail: `permissions ${mode.toString(8)} (should be 600)`,
                });
              }
            }
          } else {
            checks.push({
              name: `  Node "${nodeName}" SSH key`,
              status: "missing",
              detail: `key not found: ${keyPath}`,
            });
          }
        }

        // Check SSH connectivity
        const sshCheck = executor.runSync(
          "ssh",
          [
            "-o",
            "ConnectTimeout=5",
            "-o",
            "StrictHostKeyChecking=yes",
            "-p",
            String(nodePort),
            ...(keyPath ? ["-i", keyPath] : []),
            `${n.user}@${nodeHost}`,
            "echo ok",
          ],
          { timeout: 10_000 },
        );

        if (sshCheck.status === 0) {
          checks.push({
            name: `  Node "${nodeName}" reachable`,
            status: "ok",
            detail: `${n.user}@${nodeHost}:${nodePort}`,
          });
        } else {
          const detail = sshCheck.stderr?.toString().trim().slice(0, 80) ?? "connection failed";
          checks.push({ name: `  Node "${nodeName}" reachable`, status: "error", detail });
        }
      }
    } catch {
      // Non-critical
    } finally {
      await db.close();
    }
  }

  // Legacy print
  console.log("\n  EigenGrid Doctor\n");
  for (const c of checks) {
    let icon: string;
    switch (c.status) {
      case "ok":
        icon = "\u2713";
        break;
      case "optional":
        icon = "~";
        break;
      case "warn":
        icon = "!";
        break;
      default:
        icon = "\u2717";
        break;
    }
    if (c.name) {
      console.log(`  ${icon} ${c.name}: ${c.detail ?? c.status}`);
    } else {
      console.log("");
    }
  }
  console.log("");
}

// ────────────────────────────────────────────────────────────────────────
// Modular role-aware doctor
// ────────────────────────────────────────────────────────────────────────

async function modularDoctor(
  executor: CommandExecutor,
  config: import("@eigengrid/core").Config,
  role: EigenGridRole,
  jsonOutput: boolean,
): Promise<void> {
  const registry = createDoctorRegistry();

  // Register common checks (apply to ALL roles)
  registerCommonChecks(registry, executor, config);

  // Register role-specific checks
  if (role === "head") {
    registerHeadChecks(registry, executor, config);
  } else if (role === "worker") {
    registerWorkerChecks(registry, executor, config);
  }

  // Run checks filtered by role
  const results = await registry.runForRole(role);

  const nodeName = config.nodeName ?? hostname();
  const passed = results.filter((c) => c.status === "ok" || c.status === "optional").length;
  const total = results.length;

  if (jsonOutput) {
    console.log(
      JSON.stringify(
        { role, node: nodeName, checks: results, summary: { passed, total } },
        null,
        2,
      ),
    );
    return;
  }

  // ── Text output ──────────────────────────────────────────────────
  console.log(`\n  EigenGrid Doctor`);
  console.log(`  Role: ${role}`);
  console.log(`  Node: ${nodeName}`);
  console.log("");

  // Compute label width for alignment (cap at 24)
  const labelWidth = Math.min(results.reduce((w, c) => Math.max(w, c.name.length), 0) + 2, 24);

  for (const c of results) {
    const icon = statusIcon(c.status);
    const label = c.name.padEnd(labelWidth);
    const detail = c.detail ? ` (${c.detail})` : "";
    console.log(`  ${icon} ${label}${c.status}${detail}`);
  }

  console.log(`\n  Summary: ${passed}/${total} checks passed\n`);
}

function statusIcon(status: string): string {
  switch (status) {
    case "ok":
      return "\u2713"; // ✓
    case "optional":
      return "~";
    case "warn":
      return "!";
    default:
      return "\u2717"; // ✗
  }
}
