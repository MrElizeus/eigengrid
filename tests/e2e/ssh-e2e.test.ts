import { describe, expect, test } from "bun:test";
import { existsSync } from "fs";

/**
 * SSH E2E test — gated by EIGENGRID_ENABLE_SSH_E2E=1.
 *
 * Tests: submit an ORCA job via SSH to localhost.
 * Requires SSH server running locally with key-based auth.
 */
const SSH_E2E = process.env.EIGENGRID_ENABLE_SSH_E2E === "1";

describe.skipIf(!SSH_E2E)("SSH E2E", () => {
  test("SSH connectivity to localhost works", async () => {
    const { execSync } = await import("child_process");
    const result = execSync(
      "ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new localhost echo ok",
      {
        encoding: "utf-8",
        timeout: 10_000,
      },
    );
    expect(result.trim()).toBe("ok");
  });

  test("can submit an ORCA job via SSH", async () => {
    // Create a temporary workspace
    const { mkdtempSync, writeFileSync } = await import("fs");
    const { join } = await import("path");
    const { tmpdir } = await import("os");
    const workspace = mkdtempSync(join(tmpdir(), "eigengrid-ssh-e2e-"));

    try {
      // Create a minimal ORCA input file
      const inputPath = join(workspace, "water.inp");
      writeFileSync(
        inputPath,
        `! HF STO-3G Opt\n\n* xyz 0 1\nO 0 0 0\nH 0 0 0.957\nH 0 0.957 0\n*\n`,
      );

      // Verify bun can resolve the eigengrid CLI
      const { execSync } = await import("child_process");

      // Check that the CLI binary exists
      const binPath = join(process.cwd(), "apps", "cli", "bin", "eigengrid.ts");
      expect(existsSync(binPath)).toBe(true);

      // Run submit with SSH to localhost
      // For E2E we run the full CLI via bun
      const result = execSync(
        `bun run ${binPath} submit orca ${inputPath} --runner ssh --ssh-host localhost --ssh-user ${process.env.USER ?? "root"} --ssh-remote-dir ${workspace}/remote`,
        {
          encoding: "utf-8",
          timeout: 30_000,
          env: { ...process.env, EIGENGRID_DIR: workspace },
        },
      );

      expect(result).toContain("Created job");
      expect(result).toContain("ssh");

      // List status
      const statusResult = execSync(`bun run ${binPath} status`, {
        encoding: "utf-8",
        timeout: 10_000,
        env: { ...process.env, EIGENGRID_DIR: workspace },
      });
      expect(statusResult).toContain("Job Status");
    } finally {
      const { rmSync } = await import("fs");
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 60_000);
});
