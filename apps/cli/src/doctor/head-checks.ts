import { existsSync } from "fs";
import { stat } from "fs/promises";
import type { Config, EigenGridRole } from "@eigengrid/core";
import { createDatabaseFromConfig, type NodeRecord } from "@eigengrid/db";
import type { CommandExecutor } from "@eigengrid/runners";
import type { DoctorRegistry } from "./checks";

/**
 * Register checks that are relevant only for head-node deployments.
 */
export function registerHeadChecks(
  registry: DoctorRegistry,
  executor: CommandExecutor,
  config: Config,
): void {
  const HEAD: EigenGridRole = "head";

  // ── SSH client binary ────────────────────────────────────────────

  registry.register(
    "ssh-client",
    () => {
      const ssh = executor.runSync("command", ["-v", "ssh"]);
      return {
        name: "ssh-client",
        status: ssh.status === 0 ? "ok" : "error",
        detail: ssh.status === 0 ? ssh.stdout.toString().trim() : "ssh not found in PATH",
      };
    },
    HEAD,
  );

  // ── SCP client binary ────────────────────────────────────────────

  registry.register(
    "scp-client",
    () => {
      const scp = executor.runSync("command", ["-v", "scp"]);
      return {
        name: "scp-client",
        status: scp.status === 0 ? "ok" : "error",
        detail: scp.status === 0 ? scp.stdout.toString().trim() : "scp not found in PATH",
      };
    },
    HEAD,
  );

  // ── SSH key path + permissions ───────────────────────────────────

  registry.register(
    "ssh-key-exists",
    async () => {
      const keyPath = config.sshKeyPath;
      if (!keyPath) {
        return {
          name: "ssh-key-exists",
          status: "warn",
          detail: "no sshKeyPath configured",
        };
      }
      if (!existsSync(keyPath)) {
        return {
          name: "ssh-key-exists",
          status: "error",
          detail: `key not found: ${keyPath}`,
        };
      }
      try {
        const s = await stat(keyPath);
        const mode = s.mode & 0o777;
        if (mode > 0o600) {
          return {
            name: "ssh-key-exists",
            status: "warn",
            detail: `${keyPath}, mode ${mode.toString(8)} (should be ≤ 600)`,
          };
        }
        return {
          name: "ssh-key-exists",
          status: "ok",
          detail: `${keyPath}, mode ${mode.toString(8)}`,
        };
      } catch {
        return {
          name: "ssh-key-exists",
          status: "error",
          detail: `cannot stat: ${keyPath}`,
        };
      }
    },
    HEAD,
  );

  // ── Local head node registered in DB ─────────────────────────────

  registry.register(
    "head-node-registered",
    async () => {
      let db: Awaited<ReturnType<typeof createDatabaseFromConfig>> | undefined;
      try {
        db = await createDatabaseFromConfig(config);
        const nodes = await db.listNodes();
        const localNodes = nodes.filter((n: NodeRecord) => n.runner === "local");
        if (localNodes.length > 0) {
          return {
            name: "head-node-registered",
            status: "ok",
            detail: String(localNodes[0].name),
          };
        }
        return {
          name: "head-node-registered",
          status: "warn",
          detail: "no local node registered",
        };
      } catch (err) {
        return {
          name: "head-node-registered",
          status: "error",
          detail: err instanceof Error ? err.message : "DB check failed",
        };
      } finally {
        await db?.close();
      }
    },
    HEAD,
  );

  // ── Registered SSH node connectivity ─────────────────────────────

  registry.register(
    "registered-nodes",
    async () => {
      let db: Awaited<ReturnType<typeof createDatabaseFromConfig>> | undefined;
      try {
        db = await createDatabaseFromConfig(config);
        const nodes = await db.listNodes();
        const sshNodes = nodes.filter((n: NodeRecord) => n.runner === "ssh");

        if (sshNodes.length === 0) {
          return {
            name: "registered-nodes",
            status: "ok",
            detail: "no SSH nodes registered",
          };
        }

        let reachable = 0;
        for (const n of sshNodes) {
          const nodeHost = n.host;
          const nodePort = n.port ?? 22;
          const keyPath = n.privateKeyPath ?? undefined;

          const result = executor.runSync("ssh", [
            "-o",
            "ConnectTimeout=5",
            "-o",
            "StrictHostKeyChecking=yes",
            "-p",
            String(nodePort),
            ...(keyPath ? ["-i", keyPath] : []),
            `${n.user}@${nodeHost}`,
            "echo ok",
          ]);

          if (result.status === 0) reachable++;
        }

        const total = sshNodes.length;
        if (reachable === total) {
          return {
            name: "registered-nodes",
            status: "ok",
            detail: `${reachable}/${total} nodes reachable`,
          };
        }
        return {
          name: "registered-nodes",
          status: "warn",
          detail: `${reachable}/${total} nodes reachable`,
        };
      } catch (err) {
        return {
          name: "registered-nodes",
          status: "error",
          detail: err instanceof Error ? err.message : "node check failed",
        };
      } finally {
        await db?.close();
      }
    },
    HEAD,
  );
}
