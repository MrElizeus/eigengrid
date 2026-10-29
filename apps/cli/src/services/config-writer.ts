import { existsSync, readFileSync, writeFileSync } from "fs";
import type { EigenGridRole } from "@eigengrid/config";

export interface WriteConfigOptions {
  path: string;
  role: EigenGridRole;
  config: Record<string, unknown>;
  update?: boolean;
}

/**
 * Known config keys with a preferred display order.
 * Keys not in this list are appended at the end.
 */
const ORDERED_KEYS: string[] = [
  "role",
  "nodeName",
  "database",
  "python",
  "generateSshKey",
  "jobsDir",
  "logsDir",
  "outputsDir",
  "sessionsDir",
  "sshKeyPath",
  "remoteDir",
  "remoteScratchDir",
  "headHost",
  "headUser",
];

/** Ordered map that preserves insertion order for existing keys. */
type OrderedEntries = Array<{ key: string; value: string }>;

/**
 * Parse a flat YAML file into ordered entries, extracting the role value.
 */
function parseFlatConfig(source: string): {
  entries: OrderedEntries;
  existingRole: string | null;
} {
  const entries: OrderedEntries = [];
  let existingRole: string | null = null;

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const sep = line.indexOf(":");
    if (sep === -1) continue;

    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    if (!key || !value) continue;

    if (key === "role") {
      existingRole = value;
    }
    entries.push({ key, value });
  }

  return { entries, existingRole };
}

/**
 * Write a flat YAML config file scoped to a specific role.
 *
 * - If the file does not exist: creates it with the given role and config.
 * - If the file exists and the role matches: preserves existing values
 *   and adds any missing keys from `config`.
 * - If the file exists and the role differs: throws an error unless
 *   `update` is true.
 *
 * The output uses `key: value` syntax compatible with
 * `@eigengrid/config`'s flat YAML parser (`parseFlatYaml`).
 */
export async function writeRoleConfig(options: WriteConfigOptions): Promise<void> {
  const { path, role, config, update } = options;

  // ── Parse existing file ──────────────────────────────
  let existingEntries: OrderedEntries = [];
  let existingRole: string | null = null;

  if (existsSync(path)) {
    const parsed = parseFlatConfig(readFileSync(path, "utf8"));
    existingEntries = parsed.entries;
    existingRole = parsed.existingRole;
  }

  // ── Role conflict check ──────────────────────────────
  if (existingRole !== null && existingRole !== role && !update) {
    throw new Error(
      `Role "${role}" differs from existing "${existingRole}". Use --update to change.`,
    );
  }

  // ── Build ordered merged entries ─────────────────────
  const mergedKeys = new Set<string>();
  const merged: OrderedEntries = [];

  if (existingRole === role) {
    // Same role: preserve existing values in their original order
    for (const entry of existingEntries) {
      if (entry.key === "role") continue; // will be re-added with new role value
      merged.push(entry);
      mergedKeys.add(entry.key);
    }
  }

  // ── Append missing keys from config in ORDERED_KEYS order ──
  const configKeys = Object.keys(config);

  // Sort config keys: ORDERED_KEYS first, then alphabetically
  const sortedConfigKeys = [...configKeys].sort((a, b) => {
    const ia = ORDERED_KEYS.indexOf(a);
    const ib = ORDERED_KEYS.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  });

  for (const key of sortedConfigKeys) {
    if (key === "role") continue;
    if (mergedKeys.has(key)) continue; // already preserved from existing

    const value = config[key];
    if (value !== undefined && value !== null) {
      merged.push({ key, value: String(value) });
      mergedKeys.add(key);
    }
  }

  // ── Prepend role at the top ──────────────────────────
  const outputLines = [`role: ${role}`];
  for (const entry of merged) {
    outputLines.push(`${entry.key}: ${entry.value}`);
  }

  // ── Write file ───────────────────────────────────────
  writeFileSync(path, outputLines.join("\n") + "\n", "utf8");
}
