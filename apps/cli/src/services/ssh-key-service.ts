import { existsSync, chmodSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { execFileSync } from "child_process";

export interface SshKeyInput {
  /** Whether to generate a new key. Defaults to false. */
  generate?: boolean;
  /**
   * Path for the SSH private key.
   * Defaults to ~/.ssh/id_ed25519.
   */
  sshKeyPath?: string;
  /**
   * Node name used in the key comment (e.g. eigengrid-head@<nodeName>).
   * Defaults to "head-node".
   */
  nodeName?: string;
}

export interface SshKeyResult {
  /** Whether a new key was actually created. */
  created: boolean;
  /** Path to the private key. */
  keyPath?: string;
  /** Path to the public key. */
  pubKeyPath?: string;
  /** Non-fatal warnings (key exists, missing ssh-keygen, etc.). */
  warnings: string[];
}

export interface SshKeyDependencies {
  execFileSync?: (
    file: string,
    args: string[],
    options: { stdio: "pipe"; timeout: number },
  ) => unknown;
}

/**
 * Ensure an SSH key pair exists for the head node.
 *
 * - When `generate` is false/undefined: checks whether a key exists
 *   at the given path. Returns a hint if missing.
 * - When `generate` is true: runs `ssh-keygen -t ed25519` if the key
 *   does not already exist. Skips with a warning if it already exists.
 *
 * Never overwrites an existing key.
 * Sets correct permissions: 0600 private, 0644 public.
 */
export async function ensureHeadSshKey(
  input: SshKeyInput,
  deps: SshKeyDependencies = {},
): Promise<SshKeyResult> {
  const warnings: string[] = [];
  const keyPath = input.sshKeyPath ?? join(homedir(), ".ssh", "id_ed25519");
  const pubKeyPath = keyPath + ".pub";
  const nodeName = input.nodeName ?? "head-node";

  // ── Dry-run / check-only mode ─────────────────────────
  if (!input.generate) {
    if (existsSync(keyPath)) {
      return { created: false, keyPath, pubKeyPath, warnings: [] };
    }

    warnings.push(
      `SSH key not found at ${keyPath}. ` +
        `Run with --generate-ssh-key or \`ssh-keygen -t ed25519 -f "${keyPath}" -N ""\` to create one.`,
    );
    return { created: false, keyPath, pubKeyPath, warnings };
  }

  // ── Key already exists: warn but do not overwrite ─────
  if (existsSync(keyPath)) {
    warnings.push(
      `SSH key already exists at ${keyPath} — skipping generation. ` +
        `Remove the file first if you want to regenerate.`,
    );
    return { created: false, keyPath, pubKeyPath, warnings };
  }

  // ── Generate new key ──────────────────────────────────
  try {
    mkdirSync(dirname(keyPath), { recursive: true });

    (deps.execFileSync ?? execFileSync)(
      "ssh-keygen",
      ["-t", "ed25519", "-f", keyPath, "-N", "", "-C", `eigengrid-head@${nodeName}`],
      { stdio: "pipe", timeout: 30_000 },
    );

    chmodSync(keyPath, 0o600);
    chmodSync(pubKeyPath, 0o644);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warnings.push(
      `Failed to generate SSH key at ${keyPath}: ${message}. ` +
        `You can create one manually with: ` +
        `ssh-keygen -t ed25519 -f "${keyPath}" -N "" -C "eigengrid-head@${nodeName}"`,
    );
    return { created: false, keyPath, pubKeyPath, warnings };
  }

  return {
    created: true,
    keyPath,
    pubKeyPath,
    warnings: [],
  };
}
