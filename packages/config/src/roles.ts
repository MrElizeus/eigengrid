import type { Config } from "@eigengrid/core";
import type { EigenGridRole } from "@eigengrid/core";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { getConfigPath } from "./paths";

// Re-export so @eigengrid/config consumers can import the type directly.
export type { EigenGridRole } from "@eigengrid/core";

const VALID_ROLES = new Set<EigenGridRole>(["standalone", "head", "worker"]);

const ROLE_LABELS: Record<EigenGridRole, string> = {
  standalone: "standalone node (local execution only)",
  head: "head node (orchestration + SSH dispatch)",
  worker: "worker node (receives remote jobs via SSH)",
};

/**
 * Normalize an unknown value into a valid EigenGridRole.
 * Throws a descriptive error if the value is invalid.
 */
export function normalizeRole(value: unknown): EigenGridRole {
  if (typeof value !== "string") {
    throw new TypeError(
      `Invalid role: expected a string, got ${typeof value === "undefined" ? "undefined" : typeof value}. ` +
        `Valid roles: ${[...VALID_ROLES].map((r) => `"${r}"`).join(", ")}.`,
    );
  }

  const normalized = value.toLowerCase().trim() as string;

  if (!VALID_ROLES.has(normalized as EigenGridRole)) {
    throw new TypeError(
      `Invalid role "${value}". Valid roles:\n` +
        [...VALID_ROLES].map((r) => `  - ${r}: ${ROLE_LABELS[r]}`).join("\n"),
    );
  }

  return normalized as EigenGridRole;
}

/**
 * Return sensible default config overrides for a given role.
 *
 * - standalone: local execution, no remote config needed
 * - head: may need an SSH key path to connect to workers
 * - worker: needs a remote scratch directory and head host/user
 */
export function roleDefaults(role: EigenGridRole, cwd?: string): Partial<Config> {
  switch (role) {
    case "standalone":
      return {};
    case "head":
      return {
        sshKeyPath: resolve(cwd ?? process.cwd(), ".ssh", "id_ed25519"),
      };
    case "worker":
      return {
        remoteScratchDir: "/tmp/eigengrid",
      };
  }
}

/**
 * Type guard — asserts that a string value is a valid EigenGridRole.
 * Throws if it isn't.
 */
export function assertRole(value: string): asserts value is EigenGridRole {
  if (!VALID_ROLES.has(value as EigenGridRole)) {
    throw new TypeError(
      `Expected role to be one of ${[...VALID_ROLES].map((r) => `"${r}"`).join(", ")}, got "${value}".`,
    );
  }
}

/**
 * Read the role field directly from the YAML config file.
 * Returns null if the file doesn't exist or has no role field.
 */
export function readRoleFromConfig(cwd?: string): EigenGridRole | null {
  const configPath = getConfigPath(cwd);
  if (!existsSync(configPath)) return null;

  const source = readFileSync(configPath, "utf8");
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("role:")) {
      const value = line.slice(5).trim();
      const unwrapped =
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
          ? value.slice(1, -1)
          : value;
      if (VALID_ROLES.has(unwrapped as EigenGridRole)) {
        return unwrapped as EigenGridRole;
      }
    }
  }
  return null;
}
