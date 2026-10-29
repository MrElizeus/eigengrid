import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  createIncidentBundle,
  readIncidentBundle,
  serializeIncidentBundle,
  verifyIncidentBundle,
  writeIncidentBundle,
} from "./incident-bundle";

describe("incident bundle", () => {
  test("redacts credentials before hashing and remains deterministic", () => {
    const input = {
      db: "postgres://scientist:super-secret@db.example/head",
      apiKey: "sk-abcdefghijklmnopqrstuvwxyz0123456789",
      nested: { privateKey: "-----BEGIN PRIVATE KEY-----secret-----END PRIVATE KEY-----" },
      status: { state: "degraded", jobs: 2 },
    };
    const first = createIncidentBundle({
      incidentId: "incident-1",
      generatedAt: "2026-08-30T12:00:00.000Z",
      sourceRevision: "candidate-sha",
      missionId: "mission-1",
      sections: input,
    });
    const second = createIncidentBundle({
      incidentId: "incident-1",
      generatedAt: "2026-08-30T12:00:00.000Z",
      sourceRevision: "candidate-sha",
      missionId: "mission-1",
      sections: input,
    });
    expect(first).toEqual(second);
    const text = serializeIncidentBundle(first);
    expect(text).not.toContain("super-secret");
    expect(text).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(text).not.toContain("BEGIN PRIVATE KEY-----secret");
    expect(verifyIncidentBundle(JSON.parse(text))).toEqual({ ok: true, bundle: first });
  });

  test("fails closed on payload or bundle tampering and writes private evidence", async () => {
    const bundle = createIncidentBundle({
      incidentId: "incident-2",
      sourceRevision: "candidate-sha",
      sections: { health: { ready: true } },
    });
    expect(verifyIncidentBundle({ ...bundle, sections: { health: { ready: false } } }).ok).toBe(
      false,
    );
    expect(verifyIncidentBundle({ ...bundle, bundleDigest: "sha256:" + "0".repeat(64) }).ok).toBe(
      false,
    );
    const directory = await mkdtemp(join(tmpdir(), "eigengrid-incident-"));
    const path = join(directory, "bundle.json");
    await writeIncidentBundle(path, bundle);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readIncidentBundle(path)).toEqual(bundle);
    expect((await readFile(path, "utf8")).endsWith("\n")).toBe(true);
  });
});
