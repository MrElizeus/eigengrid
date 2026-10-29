import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContentAddressedArtifactStore } from "@eigengrid/mission-runtime";
import { readMissionRequestFile, importMissionArtifact } from "./mission-request-file";
import { assertMissionDatabaseEnvironment } from "./mission-composition";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mission-input-"));
  roots.push(root);
  const path = join(root, "input.json");
  await writeFile(path, '{"projectId":"project-1","missionId":"mission-1"}');
  return { root, path };
}

describe("mission input boundary", () => {
  test("reads bounded UTF-8 JSON and rejects malformed, invalid UTF-8, links and oversized requests", async () => {
    const { root, path } = await fixture();
    expect(await readMissionRequestFile(path)).toEqual({
      projectId: "project-1",
      missionId: "mission-1",
    });
    const alias = join(root, "alias");
    await symlink(path, alias);
    await expect(readMissionRequestFile(alias)).rejects.toThrow("regular file");
    await expect(readMissionRequestFile(root)).rejects.toThrow("regular file");
    await writeFile(path, Buffer.from([0xff, 0xfe]));
    await expect(readMissionRequestFile(path)).rejects.toThrow();
    await writeFile(path, "{");
    await expect(readMissionRequestFile(path)).rejects.toThrow();
    await truncate(path, 4 * 1024 * 1024 + 1);
    await expect(readMissionRequestFile(path)).rejects.toThrow("at most");
  });

  test("publishes only the expected digest; mismatch does not create a CAS object", async () => {
    const { root, path } = await fixture();
    const bytes = Buffer.from("approved molecular coordinates\n");
    await writeFile(path, bytes);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const store = new ContentAddressedArtifactStore(join(root, "cas"));
    await store.init();
    try {
      await expect(importMissionArtifact(store, path, "0".repeat(64))).rejects.toThrow();
      await expect(store.verify(digest)).rejects.toThrow();
      await expect(
        importMissionArtifact(store, path, digest, async () => {
          throw new Error("revoked");
        }),
      ).rejects.toThrow();
      await expect(store.verify(digest)).rejects.toThrow();
      const stored = await importMissionArtifact(store, path, digest);
      expect(stored.digest).toBe(digest);
      expect(stored.sizeBytes).toBe(bytes.length);
      expect(Buffer.from((await store.get(digest)).bytes)).toEqual(bytes);
      expect((await importMissionArtifact(store, path, digest)).existed).toBe(true);
    } finally {
      await store.close();
    }
  });

  test("rejects ambient libpq authority without printing its value", () => {
    expect(() => assertMissionDatabaseEnvironment({ DATABASE_URL: "ignored" })).not.toThrow();
    for (const name of [
      "PGHOST",
      "PGPASSWORD",
      "PGOPTIONS",
      "PGSSLMODE",
      "PGSERVICEFILE",
      "PGSSLNEGOTIATION",
    ])
      expect(() => assertMissionDatabaseEnvironment({ [name]: "secret" })).toThrow("PG*");
    expect(() => assertMissionDatabaseEnvironment({ NODE_TLS_REJECT_UNAUTHORIZED: "0" })).toThrow(
      "TLS",
    );
  });
});
