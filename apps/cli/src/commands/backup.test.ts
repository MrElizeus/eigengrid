import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { BackupManifest } from "@eigengrid/backup";
import type { ApplicationContext } from "../composition";
import {
  backupCreateCommand,
  runBackupCreate,
  scientificCasInspectionLines,
  scientificCasRestoreLine,
  type BackupCreateDependencies,
} from "./backup";

const databasePath = "/tmp/eigengrid-command-backup/source.sqlite";

function context(provider: "sqlite" | "postgres" = "sqlite"): ApplicationContext {
  return {
    db: { _provider: provider },
    config: { databasePath },
  } as unknown as ApplicationContext;
}

function runInContext(
  ctx: ApplicationContext,
): NonNullable<BackupCreateDependencies["runInContext"]> {
  return async (action) => action(ctx);
}

function store(sequence: string[], initError?: Error, closeError?: Error) {
  return {
    async init() {
      sequence.push("cas:init");
      if (initError) throw initError;
    },
    async close() {
      sequence.push("cas:close");
      if (closeError) throw closeError;
    },
    async getStream() {
      throw new Error("The fake archive writer must not read CAS bytes");
    },
  };
}

function counts(
  scientific?: Partial<
    Pick<BackupManifest["counts"], "scientificCasReferences" | "scientificCasObjects">
  >,
): BackupManifest["counts"] {
  return {
    jobs: 0,
    attempts: 0,
    artifacts: 0,
    results: 0,
    events: 0,
    nodes: 0,
    permissions: 0,
    logs: 0,
    proposals: 0,
    users: 0,
    projects: 0,
    memberships: 0,
    quotas: 0,
    usageRecords: 0,
    ...scientific,
  };
}

function manifest(scientificCasObjects?: number): BackupManifest {
  return {
    format: "eigengrid-backup",
    formatVersion: 1,
    createdAt: "2026-08-23T00:00:00.000Z",
    version: "test",
    hashAlgorithm: "sha256",
    includeArtifacts: false,
    counts: counts(
      scientificCasObjects === undefined
        ? undefined
        : { scientificCasReferences: scientificCasObjects, scientificCasObjects },
    ),
  };
}

describe("backup create scientific CAS lifecycle", () => {
  test("registers the stable create subcommand and forwards an initialized absolute CAS root", async () => {
    expect(backupCreateCommand.command).toBe("create");
    const configured = new Map<string, Record<string, unknown>>();
    const fakeArgv = {
      option(name: string, definition: Record<string, unknown>) {
        configured.set(name, definition);
        return fakeArgv;
      },
    };
    expect(typeof backupCreateCommand.builder).toBe("function");
    (backupCreateCommand.builder as (argv: typeof fakeArgv) => unknown)(fakeArgv);
    expect(configured.get("scientific-cas-root")?.type).toBe("string");
    expect(configured.get("scientific-cas-root")?.describe).toContain("cas:// evidence");
    const sequence: string[] = [];
    const fakeStore = store(sequence);
    const roots: string[] = [];

    await runBackupCreate(
      {
        output: "backup.tar.gz",
        includeArtifacts: true,
        scientificCasRoot: "relative-scientific-cas",
      },
      {
        runInContext: runInContext(context()),
        createScientificCasStore: (root) => {
          roots.push(root);
          sequence.push("cas:create");
          return fakeStore;
        },
        createArchive: async (_database, options) => {
          sequence.push("archive:create");
          expect(options.dbPath).toBe(databasePath);
          expect(options.outputPath).toBe("backup.tar.gz");
          expect(options.includeArtifacts).toBe(true);
          expect(options.contentAddressedStore).toBe(fakeStore);
          return { backupPath: "/tmp/backup.tar.gz", fileCount: 3, totalSizeBytes: 100 };
        },
        write: () => {},
      },
    );

    expect(roots).toEqual([resolve("relative-scientific-cas")]);
    expect(sequence).toEqual(["cas:create", "cas:init", "archive:create", "cas:close"]);
  });

  test("keeps a legacy no-CAS backup working without constructing a default store", async () => {
    let factoryCalled = false;
    await runBackupCreate(
      { output: "legacy.tar.gz" },
      {
        runInContext: runInContext(context()),
        createScientificCasStore: () => {
          factoryCalled = true;
          return store([]);
        },
        createArchive: async (_database, options) => {
          expect(options.contentAddressedStore).toBeUndefined();
          return { backupPath: "/tmp/legacy.tar.gz", fileCount: 1, totalSizeBytes: 1 };
        },
        write: () => {},
      },
    );
    expect(factoryCalled).toBe(false);
  });

  test("closes the CAS store when archive creation fails", async () => {
    const sequence: string[] = [];
    await expect(
      runBackupCreate(
        { scientificCasRoot: "/tmp/scientific-cas" },
        {
          runInContext: runInContext(context()),
          createScientificCasStore: () => store(sequence),
          createArchive: async () => {
            sequence.push("archive:failure");
            throw new Error("archive failed");
          },
          write: () => {},
        },
      ),
    ).rejects.toThrow("archive failed");
    expect(sequence).toEqual(["cas:init", "archive:failure", "cas:close"]);
  });

  test("closes a constructed CAS store even when initialization fails", async () => {
    const sequence: string[] = [];
    await expect(
      runBackupCreate(
        { scientificCasRoot: "/tmp/scientific-cas" },
        {
          runInContext: runInContext(context()),
          createScientificCasStore: () => store(sequence, new Error("init failed")),
          createArchive: async () => {
            throw new Error("archive must not run");
          },
          write: () => {},
        },
      ),
    ).rejects.toThrow("init failed");
    expect(sequence).toEqual(["cas:init", "cas:close"]);
  });

  test("does not announce success when closing the CAS store fails", async () => {
    const sequence: string[] = [];
    const output: string[] = [];
    await expect(
      runBackupCreate(
        { scientificCasRoot: "/tmp/scientific-cas" },
        {
          runInContext: runInContext(context()),
          createScientificCasStore: () => store(sequence, undefined, new Error("close failed")),
          createArchive: async () => ({
            backupPath: "/tmp/backup.tar.gz",
            fileCount: 1,
            totalSizeBytes: 1,
          }),
          write: (message) => output.push(message),
        },
      ),
    ).rejects.toThrow("close failed");
    expect(sequence).toEqual(["cas:init", "cas:close"]);
    expect(output).toEqual(["  Creating backup...\n"]);
  });

  test("turns an omitted required CAS root into actionable fail-closed guidance", async () => {
    await expect(
      runBackupCreate(
        {},
        {
          runInContext: runInContext(context()),
          createArchive: async () => {
            throw new Error(
              "Backup snapshot references 3 scientific CAS object(s), but no verified content-addressed store was provided.",
            );
          },
          write: () => {},
        },
      ),
    ).rejects.toThrow("--scientific-cas-root <path>");
  });

  test("rejects PostgreSQL before constructing or initializing a CAS store", async () => {
    let factoryCalled = false;
    await expect(
      runBackupCreate(
        { scientificCasRoot: "/tmp/must-not-open" },
        {
          runInContext: runInContext(context("postgres")),
          createScientificCasStore: () => {
            factoryCalled = true;
            return store([]);
          },
          write: () => {},
        },
      ),
    ).rejects.toThrow("PostgreSQL export is not implemented");
    expect(factoryCalled).toBe(false);
  });
});

describe("backup scientific CAS operator messages", () => {
  test("shows new counts only when the manifest defines them", () => {
    expect(scientificCasInspectionLines(counts())).toEqual([]);
    expect(
      scientificCasInspectionLines(counts({ scientificCasReferences: 7, scientificCasObjects: 5 })),
    ).toEqual(["    Scientific CAS references: 7", "    Scientific CAS objects:    5"]);
  });

  test("reports the materialized destination without moving CAS outside the target", () => {
    expect(scientificCasRestoreLine(manifest(), "/srv/restore", false)).toBeUndefined();
    expect(scientificCasRestoreLine(manifest(0), "/srv/restore", false)).toBe(
      "  Scientific CAS objects: 0",
    );
    expect(scientificCasRestoreLine(manifest(2), "/srv/restore", false)).toBe(
      "  Scientific CAS: /srv/restore/cas (2 objects)",
    );
    expect(scientificCasRestoreLine(manifest(1), "/srv/restore", true)).toBe(
      "  Scientific CAS: /srv/restore/cas (1 object; dry-run only)",
    );
  });
});
