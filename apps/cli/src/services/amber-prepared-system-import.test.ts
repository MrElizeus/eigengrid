import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { importAmberPreparedSystem } from "./amber-prepared-system-import";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function deniedDependencies() {
  let authorityReads = 0;
  let casWrites = 0;
  return {
    actor: { id: "owner", kind: "human" as const, role: "scientist" },
    store: {
      async getMissionProjectAssociation() {
        authorityReads++;
        throw new Error("unexpected mission lookup");
      },
      async assertProductionMissionPlanningAccess() {
        authorityReads++;
        throw new Error("unexpected access check");
      },
      async getMissionProvenance() {
        authorityReads++;
        throw new Error("unexpected provenance read");
      },
      async createEvidence() {
        throw new Error("unexpected evidence write");
      },
    },
    mdStore: {
      async getForceFieldStack() {
        throw new Error("unexpected material lookup");
      },
      async putSystemManifest() {
        throw new Error("unexpected manifest write");
      },
      async putAtomMap() {
        throw new Error("unexpected AtomMap write");
      },
    },
    artifacts: {
      async putStream() {
        casWrites++;
        throw new Error("unexpected CAS write");
      },
    },
    counts: () => ({ authorityReads, casWrites }),
  };
}

async function tempDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "eigengrid-prepared-system-"));
  directories.push(directory);
  return directory;
}

describe("prepared Amber system import boundary", () => {
  test("rejects package-manifest symlinks before mission authority or CAS access", async () => {
    const directory = await tempDirectory();
    await writeFile(join(directory, "real.json"), "{}", { mode: 0o600 });
    await symlink("real.json", join(directory, "package.json"));
    const dependencies = deniedDependencies();

    await expect(
      importAmberPreparedSystem({
        directory,
        ...dependencies,
      }),
    ).rejects.toThrow(/manifest/u);
    expect(dependencies.counts()).toEqual({ authorityReads: 0, casWrites: 0 });
  });

  test("rejects an incomplete package before opening database or CAS writers", async () => {
    const directory = await tempDirectory();
    await writeFile(join(directory, "package.json"), JSON.stringify({ schemaVersion: "wrong" }), {
      mode: 0o600,
    });
    const dependencies = deniedDependencies();

    await expect(
      importAmberPreparedSystem({
        directory,
        ...dependencies,
      }),
    ).rejects.toThrow();
    expect(dependencies.counts()).toEqual({ authorityReads: 0, casWrites: 0 });
  });
});
