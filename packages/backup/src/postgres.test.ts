import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createPostgresBackup,
  restorePostgresBackup,
  validatePostgresPitrPolicy,
  verifyPostgresBackup,
  type CommandExecutor,
} from "./postgres";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join("/tmp", "eigengrid-pg-backup-test-"));
  roots.push(value);
  return value;
}

describe("PostgreSQL backup/restore boundary", () => {
  it("writes an atomic custom-format archive and redacted manifest", async () => {
    const dir = root();
    const calls: string[][] = [];
    let childEnvironment: NodeJS.ProcessEnv | undefined;
    const executor: CommandExecutor = {
      async run(command, args, options) {
        calls.push([command, ...args]);
        childEnvironment = options?.env;
        const file = args[args.indexOf("--file") + 1];
        writeFileSync(file, "PGDUMP");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const result = await createPostgresBackup({
      databaseUrl: "postgresql://alice:secret@example.test:5432/grid",
      outputPath: join(dir, "head.dump"),
      migrationHead: 18,
      executor,
      now: () => new Date("2026-08-30T00:00:00.000Z"),
    });
    expect(existsSync(join(dir, "head.dump"))).toBe(true);
    expect(result.manifest.database).toContain("alice:***@example.test");
    expect(result.manifest.database).not.toContain("secret");
    expect(calls[0]).toContain("--no-owner");
    expect(calls[0]).toContain("--no-privileges");
    expect(calls[0]).not.toContain("secret");
    expect(childEnvironment?.PGPASSWORD).toBe("secret");
    expect(verifyPostgresBackup(join(dir, "head.dump")).archiveSha256).toBe(
      result.manifest.archiveSha256,
    );
  });

  it("strips credential query parameters from the child argv", async () => {
    const dir = root();
    let argv: readonly string[] = [];
    const executor: CommandExecutor = {
      async run(_command, args) {
        argv = args;
        writeFileSync(args[args.indexOf("--file") + 1]!, "PGDUMP");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    await createPostgresBackup({
      databaseUrl:
        "postgres://alice:secret@example.test/grid?password=query-secret&sslmode=require&passfile=/tmp/secret",
      outputPath: join(dir, "head.dump"),
      migrationHead: 1,
      executor,
    });
    const database = argv[argv.indexOf("--dbname") + 1]!;
    expect(database).toContain("sslmode=require");
    expect(database).not.toContain("query-secret");
    expect(database).not.toContain("passfile");
  });

  it("fails closed on checksum drift and never logs credentials", async () => {
    const dir = root();
    const executor: CommandExecutor = {
      async run(_command, args) {
        writeFileSync(args[args.indexOf("--file") + 1], "PGDUMP");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    await createPostgresBackup({
      databaseUrl: "postgres://u:p@localhost/db",
      outputPath: join(dir, "x.dump"),
      migrationHead: 1,
      executor,
    });
    writeFileSync(join(dir, "x.dump"), "tampered");
    expect(() => verifyPostgresBackup(join(dir, "x.dump"))).toThrow("checksum mismatch");
    const fail: CommandExecutor = {
      async run() {
        return { exitCode: 1, stdout: "", stderr: "password=p" };
      },
    };
    await expect(
      createPostgresBackup({
        databaseUrl: "postgres://u:p@localhost/db",
        outputPath: join(dir, "bad.dump"),
        migrationHead: 1,
        executor: fail,
      }),
    ).rejects.toThrow("postgres://u:***@localhost/db");
    expect(readFileSync(join(dir, "x.dump"), "utf8")).toBe("tampered");
  });

  it("redacts credentials returned in pg_dump and pg_restore stderr", async () => {
    const dir = root();
    const databaseUrl = "postgres://u:SuperSecretP%40ss%21@host/db";
    const failingExecutor: CommandExecutor = {
      async run() {
        return {
          exitCode: 1,
          stdout: "",
          stderr: `connection failed ${databaseUrl} password=SuperSecretP@ss!`,
        };
      },
    };
    await expect(
      createPostgresBackup({
        databaseUrl,
        outputPath: join(dir, "dump.dump"),
        migrationHead: 1,
        executor: failingExecutor,
      }),
    ).rejects.not.toThrow("SuperSecret");

    const archive = join(dir, "archive.dump");
    writeFileSync(archive, "PGDUMP");
    const { createHash } = await import("node:crypto");
    writeFileSync(
      `${archive}.manifest.json`,
      JSON.stringify({
        format: "eigengrid-postgresql-custom",
        formatVersion: 1,
        createdAt: "2026-08-30T00:00:00.000Z",
        database: "postgres://u:***@host/db",
        archivePath: archive,
        archiveSha256: createHash("sha256").update("PGDUMP").digest("hex"),
        archiveBytes: 6,
        migrationHead: 1,
        walPolicy: "site-configured",
      }),
    );
    await expect(
      restorePostgresBackup({
        archivePath: archive,
        databaseUrl,
        executor: failingExecutor,
      }),
    ).rejects.not.toThrow("SuperSecret");
  });

  it("uses safe restore argv and requires an explicit destructive token", async () => {
    const dir = root();
    const executor: CommandExecutor = {
      async run(_command, args) {
        const file = args[args.indexOf("--file") + 1];
        if (file) writeFileSync(file, "PGDUMP");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const backup = await createPostgresBackup({
      databaseUrl: "postgres://u:p@localhost/db",
      outputPath: join(dir, "x.dump"),
      migrationHead: 18,
      executor,
    });
    const restoreCalls: string[][] = [];
    const restoreEnvironments: Array<NodeJS.ProcessEnv | undefined> = [];
    const restoreExecutor: CommandExecutor = {
      async run(command, args, options) {
        restoreCalls.push([command, ...args]);
        restoreEnvironments.push(options?.env);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    await restorePostgresBackup({
      archivePath: backup.manifest.archivePath,
      databaseUrl: "postgres://u:p@localhost/target",
      executor: restoreExecutor,
    });
    expect(restoreCalls[0]).not.toContain("--clean");
    expect(restoreCalls[0]).not.toContain("p@localhost");
    expect(restoreEnvironments[0]?.PGPASSWORD).toBe("p");
    await restorePostgresBackup({
      archivePath: backup.manifest.archivePath,
      databaseUrl: "postgres://u:p@localhost/target",
      destructiveConfirmation: "RESTORE_EXPLICITLY_AUTHORIZED",
      executor: restoreExecutor,
    });
    expect(restoreCalls[1]).toContain("--clean");
    expect(restoreCalls[1]).toContain("--if-exists");
    expect(restoreEnvironments[1]?.PGPASSWORD).toBe("p");
  });

  it("requires explicit RPO/RTO before a policy can be production-configured", () => {
    expect(
      validatePostgresPitrPolicy({
        retentionDays: 7,
        offHostCopyRequired: true,
        owner: "site",
        status: "site-pending",
      }).status,
    ).toBe("site-pending");
    expect(() =>
      validatePostgresPitrPolicy({
        retentionDays: 7,
        offHostCopyRequired: true,
        owner: "site",
        status: "configured",
      }),
    ).toThrow("RPO/RTO");
    expect(
      validatePostgresPitrPolicy({
        retentionDays: 7,
        recoveryPointObjectiveMinutes: 15,
        recoveryTimeObjectiveMinutes: 60,
        offHostCopyRequired: true,
        owner: "site",
        status: "configured",
      }).recoveryTimeObjectiveMinutes,
    ).toBe(60);
  });
});
