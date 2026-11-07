import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExperienceMemory,
  memoryDigest,
  canonical,
  redactMemory,
  type LessonInput,
  type MemoryScope,
} from "./index";

const boundary = { projectId: "project-a", ownerId: "alice" };
const model = { id: "model-a", kind: "model", role: "author" } as const;
const service = { id: "capture", kind: "service", role: "observer" } as const;
const human = { id: "alice", kind: "human", role: "operational_reviewer" } as const;
const confidence = {
  level: "medium",
  basis: "Checked original observations and counterexamples",
} as const;
let root: string, path: string, now: number, memory: ExperienceMemory;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "eigengrid-experience-"));
  path = join(root, "memory.sqlite");
  now = Date.parse("2026-11-06T00:00:00Z");
  memory = new ExperienceMemory(path, boundary, () => now);
});
afterEach(() => {
  memory.close();
  rmSync(root, { recursive: true, force: true });
});

function candidate(
  id = "lesson-a",
  scope: MemoryScope = { kind: "project" },
  changes: Partial<LessonInput> = {},
) {
  const evidence = memory.observe({
    id: "evidence:" + id,
    scope,
    origin: {
      kind: "tool_observation",
      reference: "inspect-node",
      sourceDigest: memoryDigest({ output: "AMBER absent from PATH" }),
    },
    observation: " AMBER absent from PATH; this does not establish absence from the installation. ",
    outcome: "tool_succeeded",
    observedAt: new Date(now).toISOString(),
  });
  return memory.propose(
    {
      id,
      scope,
      domain: "operational",
      title: " Inspect AMBER modules ",
      claim: "Inspect modules and identity when AMBER is absent from PATH.",
      rationale: "PATH alone cannot establish installation availability.",
      conditions: [{ key: "cluster", value: "fixture-a" }],
      evidence: [{ id: evidence.id, digest: evidence.digest }],
      outcome: "completed",
      confidence: { level: "unknown", basis: "Unreviewed hypothesis" },
      validFrom: new Date(now).toISOString(),
      expiresAt: new Date(now + 86400000).toISOString(),
      ...changes,
    },
    model,
  );
}
function reviewed(id = "lesson-a") {
  const initial = candidate(id);
  const verified = memory.verify(id, initial.current.digest, service);
  return memory.review(id, verified.current.digest, human, " Checked module evidence ", confidence);
}
const context = { facts: { cluster: "fixture-a" } };

describe("governed experiential memory", () => {
  test("finds persisted accented lessons with either spelling without rewriting their history", () => {
    const initial = candidate(
      "spanish",
      { kind: "project" },
      {
        title: "Optimización molecular",
        claim: "La geometría converge.",
      },
    );
    const verified = memory.verify("spanish", initial.current.digest, service);
    const lesson = memory.review("spanish", verified.current.digest, human, "Reviewed", confidence);
    // The Unicode filter must run before the 500 matching-candidate bound.
    for (let i = 0; i < 501; i++) candidate(`unrelated-${i}`);
    memory.close();
    memory = new ExperienceMemory(path, boundary, () => now);
    for (const query of ["optimización", "OPTIMIZACION", "geometri\u0301a", "geometria"]) {
      expect(memory.search(query, context).map((hit) => hit.lesson.candidate.id)).toEqual([
        "spanish",
      ]);
      expect(memory.search(query, { facts: { cluster: "another-site" } })).toEqual([]);
    }
    expect(
      memory
        .search("", context, { semanticIds: ["spanish"] })
        .map((hit) => hit.lesson.candidate.id),
    ).toEqual(["spanish"]);
    expect(memory.get("spanish")).toEqual(lesson);
  });
  test("persists normalized, redacted, append-only evidence and a complete review chain", () => {
    const lesson = reviewed();
    const promoted = memory.promote(
      "lesson-a",
      lesson.current.digest,
      human,
      "Reusable operational guidance",
    );
    expect(promoted.history.map((e) => e.state)).toEqual([
      "candidate",
      "evidence_verified",
      "reviewed",
      "promoted",
    ]);
    memory.close();
    memory = new ExperienceMemory(path, boundary, () => now);
    expect(memory.get("lesson-a")).toEqual(promoted);
    expect(memory.search("AMBER modules", context)[0].lesson.current.state).toBe("promoted");
    const db = new Database(path);
    try {
      for (const table of ["evidence", "lessons", "events"])
        expect(() => db.exec(`DELETE FROM experience_${table}_v1`)).toThrow("append-only");
    } finally {
      db.close();
    }
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(root).mode & 0o777).toBe(0o700);
    }
  });
  test("similarity never promotes candidates or crosses owner/project boundaries", () => {
    const lesson = candidate();
    expect(memory.search("AMBER", context, { semanticIds: [lesson.candidate.id] })).toEqual([]);
    expect(memory.search("AMBER", context, { includeIneligible: true })[0].excludedBy).toContain(
      "candidate",
    );
    for (const other of [
      { ...boundary, ownerId: "bob" },
      { ...boundary, projectId: "project-b" },
    ]) {
      const isolated = new ExperienceMemory(path, other, () => now);
      try {
        expect(
          isolated.search("AMBER", context, { includeIneligible: true, semanticIds: ["lesson-a"] }),
        ).toEqual([]);
        expect(isolated.recentEvidence()).toEqual([]);
        expect(() => isolated.get("lesson-a")).toThrow("unavailable");
      } finally {
        isolated.close();
      }
    }
  });
  test("requires exact scope, host facts and validity even for highly similar reviewed lessons", () => {
    const initial = candidate("installation", {
      kind: "installation",
      installationId: "cluster-a",
    });
    const verified = memory.verify(initial.candidate.id, initial.current.digest, service);
    memory.review(
      initial.candidate.id,
      verified.current.digest,
      human,
      "Site observations checked",
      confidence,
    );
    expect(memory.search("AMBER", context)).toEqual([]);
    expect(memory.search("AMBER", { installationId: "cluster-a" })).toEqual([]);
    expect(memory.search("AMBER", { ...context, installationId: "cluster-b" })).toEqual([]);
    expect(memory.search("AMBER", { ...context, installationId: "cluster-a" })).toHaveLength(1);
    now += 86400000;
    expect(memory.search("AMBER", { ...context, installationId: "cluster-a" })).toEqual([]);
  });
  test("rejects model verification, human impersonation, premature promotion and wrong scientific roles", () => {
    const initial = candidate("scientific", { kind: "project" }, { domain: "scientific" });
    expect(() => memory.verify("scientific", initial.current.digest, model)).toThrow(
      "Models cannot",
    );
    expect(() => memory.promote("scientific", initial.current.digest, human, "skip")).toThrow();
    const verified = memory.verify("scientific", initial.current.digest, service);
    expect(() =>
      memory.review(
        "scientific",
        verified.current.digest,
        { ...model, role: "scientific_reviewer" },
        "self approval",
        confidence,
      ),
    ).toThrow();
    expect(() =>
      memory.review(
        "scientific",
        verified.current.digest,
        { ...human, id: "bob", role: "scientific_reviewer" },
        "wrong owner",
        confidence,
      ),
    ).toThrow();
    expect(() =>
      memory.review("scientific", verified.current.digest, human, "wrong role", confidence),
    ).toThrow();
    expect(
      memory.review(
        "scientific",
        verified.current.digest,
        { ...human, role: "scientific_reviewer" },
        "Domain review completed",
        confidence,
      ).current.state,
    ).toBe("reviewed");
  });
  test("CAS prevents concurrent stale review and replay cannot change evidence identity", () => {
    const initial = candidate();
    const second = new ExperienceMemory(path, boundary, () => now);
    try {
      memory.verify("lesson-a", initial.current.digest, service);
      expect(() => second.verify("lesson-a", initial.current.digest, service)).toThrow("Stale");
    } finally {
      second.close();
    }
    const e = memory.evidence("evidence:lesson-a");
    const { schemaVersion: _schema, digest: _digest, boundary: _boundary, ...input } = e;
    expect(memory.observe({ ...input, observedAt: new Date(now + 1000).toISOString() })).toEqual(e);
    expect(() => memory.observe({ ...input, observation: "AMBER available" })).toThrow(
      "identity conflict",
    );
  });
  test("refuses missing, mismatched and cross-scope evidence and invalid validity/conditions", () => {
    const initial = candidate();
    const {
      schemaVersion: _schema,
      digest: _digest,
      boundary: _boundary,
      author: _author,
      createdAt: _created,
      ...input
    } = initial.candidate;
    expect(() =>
      memory.propose(
        { ...input, id: "missing", evidence: [{ id: "absent", digest: "f".repeat(64) }] },
        model,
      ),
    ).toThrow("unavailable");
    expect(() =>
      memory.propose(
        {
          ...input,
          id: "mismatch",
          evidence: [{ id: input.evidence[0].id, digest: "f".repeat(64) }],
        },
        model,
      ),
    ).toThrow("digest");
    expect(() =>
      memory.propose(
        { ...input, id: "scope", scope: { kind: "session", sessionId: "other" } },
        model,
      ),
    ).toThrow("scope");
    expect(() =>
      memory.propose({ ...input, id: "expired", expiresAt: input.validFrom }, model),
    ).toThrow("validity");
    expect(() =>
      memory.propose(
        { ...input, id: "duplicate", conditions: [...input.conditions, ...input.conditions] },
        model,
      ),
    ).toThrow("Duplicate");
  });
  test("quarantines contradictions, requires fresh review after resolution and retains refutation history", () => {
    const old = reviewed("old");
    const newer = candidate("new");
    const related = memory.relate(
      {
        sourceId: "new",
        sourceExpected: newer.current.digest,
        targetId: "old",
        targetExpected: old.current.digest,
        kind: "contradicts",
        reason: "Found AMBER outside the original PATH",
      },
      model,
    );
    expect(memory.search("AMBER", context)).toEqual([]);
    expect(related.source.current.state).toBe("contested");
    expect(related.target.current.confidence.level).toBe("unknown");
    expect(() =>
      memory.resolve("new", related.source.current.digest, model, "self resolve"),
    ).toThrow();
    const resolved = memory.resolve(
      "new",
      related.source.current.digest,
      human,
      "New module evidence supports a narrower claim",
    );
    expect(resolved.current.state).toBe("candidate");
    const verified = memory.verify("new", resolved.current.digest, service);
    const fresh = memory.review(
      "new",
      verified.current.digest,
      human,
      "Evidence and conditions rechecked",
      confidence,
    );
    const refuted = memory.relate(
      {
        sourceId: "new",
        sourceExpected: fresh.current.digest,
        targetId: "old",
        targetExpected: related.target.current.digest,
        kind: "refutes",
        reason: "Initial absence claim disproved",
      },
      human,
    );
    expect(refuted.target.current.state).toBe("refuted");
    expect(refuted.target.history.map((e) => e.action)).toContain("contradicts");
    expect(memory.search("AMBER", context).map((hit) => hit.lesson.candidate.id)).toEqual(["new"]);
    expect(() => memory.resolve("old", refuted.target.current.digest, human, "resurrect")).toThrow(
      "retired",
    );
  });
  test("rolls back both sides if a relationship event cannot be appended", () => {
    const a = reviewed("a"),
      b = reviewed("b");
    const db = new Database(path);
    try {
      db.exec(
        "CREATE TRIGGER simulate_write_failure BEFORE INSERT ON experience_events_v1 WHEN NEW.id='b' BEGIN SELECT RAISE(ABORT, 'disk failure'); END;",
      );
      expect(() =>
        memory.relate(
          {
            sourceId: "a",
            sourceExpected: a.current.digest,
            targetId: "b",
            targetExpected: b.current.digest,
            kind: "supersedes",
            reason: "Replacement",
          },
          human,
        ),
      ).toThrow("disk failure");
      expect(memory.get("a").current.digest).toBe(a.current.digest);
      expect(memory.get("b").current.digest).toBe(b.current.digest);
    } finally {
      db.close();
    }
  });
  test("detects tampered stored evidence and history instead of trusting a retrieved match", () => {
    const original = reviewed();
    const db = new Database(path);
    try {
      db.exec("DROP TRIGGER immutable_experience_evidence_UPDATE");
      db.query("UPDATE experience_evidence_v1 SET body=replace(body, ?, ?)").run(
        "absent from PATH",
        "available in PATH",
      );
      expect(() => memory.search("AMBER", context)).toThrow("integrity");
      expect(() => memory.promote("lesson-a", original.current.digest, human, "approve")).toThrow(
        "integrity",
      );
      db.exec("DROP TRIGGER immutable_experience_events_UPDATE");
      db.query("UPDATE experience_events_v1 SET body=replace(body, ?, ?)").run(
        "reviewed",
        "promoted",
      );
      expect(() => memory.get("lesson-a")).toThrow("integrity");
    } finally {
      db.close();
    }
  });
  test("bounds and redacts snapshots before retention and rejects unsafe JSON/storage", () => {
    const redacted = redactMemory(
      'password="hunter2" {"api_key":"private-value"} Bearer abcdefghijkl ' + "科学".repeat(4000),
      128,
    );
    expect(redacted).not.toContain("hunter2");
    expect(redacted).not.toContain("private-value");
    expect(redacted).not.toContain("abcdefghijkl");
    expect(Buffer.byteLength(redacted)).toBeLessThanOrEqual(128);
    expect(() =>
      canonical({
        get secret() {
          throw new Error("getter invoked");
        },
      }),
    ).toThrow("accessors");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonical(cyclic)).toThrow("acyclic");
    const sparse: unknown[] = [];
    sparse.length = 100;
    expect(() => canonical(sparse)).toThrow("dense arrays");
    // Long ordinary model responses must not trigger quadratic URI-pattern backtracking.
    expect(redactMemory("K".repeat(524288)).length).toBeLessThanOrEqual(4000);
    expect(redactMemory("Authorization: Bearer private-token-value")).not.toContain(
      "private-token-value",
    );
    expect(redactMemory("Authorization: Basic cHJpdmF0ZQ==")).not.toContain("cHJpdmF0ZQ==");
    expect(redactMemory(JSON.stringify({ password: 'prefix"secret-tail' }))).not.toContain(
      "secret-tail",
    );
    expect(() => canonical({ value: "x".repeat(3 * 1024 * 1024) })).toThrow("limit");
    symlinkSync(join(root, "missing"), join(root, "linked.sqlite"));
    expect(() => new ExperienceMemory(join(root, "linked.sqlite"), boundary)).toThrow(
      "regular file",
    );
  });
});
