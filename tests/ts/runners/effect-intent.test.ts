import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { effectRequestDigest, persistEffectIntent, readEffectIntent } from "@eigengrid/runners";

describe("durable effect intent records", () => {
  test("writes atomically and round-trips a 0600-compatible intent", () => {
    const root = mkdtempSync(join(tmpdir(), "eigengrid-intent-"));
    const path = join(root, "nested", "intent.json");
    const intent = {
      schema: "eigengrid.effect-intent.v1" as const,
      operationId: "op-1",
      jobId: "job-1",
      attemptId: "attempt-1",
      backend: "slurm" as const,
      state: "intent_persisted" as const,
      requestDigest: effectRequestDigest({ a: 1 }),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    persistEffectIntent(path, intent);
    expect(readEffectIntent(path)).toEqual(intent);
    expect(readFileSync(path, "utf8")).toContain("intent_persisted");
  });

  test("fails closed on a corrupt or semantically invalid intent", () => {
    const root = mkdtempSync(join(tmpdir(), "eigengrid-intent-corrupt-"));
    const corrupt = join(root, "corrupt.json");
    writeFileSync(corrupt, '{"schema":"eigengrid.effect-intent.v1"');
    expect(() => readEffectIntent(corrupt)).toThrow("Effect intent is corrupt");

    const invalid = join(root, "invalid.json");
    writeFileSync(
      invalid,
      JSON.stringify({ schema: "eigengrid.effect-intent.v1", operationId: "op" }),
    );
    expect(() => readEffectIntent(invalid)).toThrow("Effect intent is invalid");
  });

  test("rejects identity conflicts, backward transitions, and traversal IDs", () => {
    const root = mkdtempSync(join(tmpdir(), "eigengrid-intent-conflict-"));
    const path = join(root, "intent.json");
    const createdAt = new Date().toISOString();
    const base = {
      schema: "eigengrid.effect-intent.v1" as const,
      operationId: "op-conflict",
      jobId: "job-conflict",
      attemptId: "attempt-conflict",
      backend: "local" as const,
      requestDigest: effectRequestDigest({ request: "one" }),
      createdAt,
      updatedAt: createdAt,
    };
    persistEffectIntent(path, { ...base, state: "intent_persisted" });

    expect(() =>
      persistEffectIntent(path, {
        ...base,
        state: "intent_persisted",
        requestDigest: effectRequestDigest({ request: "two" }),
      }),
    ).toThrow("identity conflict");
    expect(() =>
      persistEffectIntent(path, {
        ...base,
        state: "confirmed",
        updatedAt: new Date(Date.now() + 1).toISOString(),
      }),
    ).toThrow("Invalid effect intent transition");
    expect(() =>
      persistEffectIntent(join(root, "../escape.json"), {
        ...base,
        operationId: "../escape",
        state: "intent_persisted",
      }),
    ).toThrow("unsafe characters");
    expect(readEffectIntent(path)?.state).toBe("intent_persisted");
  });

  test("allows cancellation and uncertainty after backend acknowledgement", () => {
    const root = mkdtempSync(join(tmpdir(), "eigengrid-intent-confirmed-"));
    const path = join(root, "intent.json");
    const createdAt = new Date().toISOString();
    const base = {
      schema: "eigengrid.effect-intent.v1" as const,
      operationId: "op-confirmed",
      jobId: "job-confirmed",
      attemptId: "attempt-confirmed",
      backend: "ssh" as const,
      requestDigest: effectRequestDigest({ request: "confirmed" }),
      createdAt,
      updatedAt: createdAt,
    };

    persistEffectIntent(path, { ...base, state: "intent_persisted" });
    const submittedAt = new Date(Date.now() + 1).toISOString();
    persistEffectIntent(path, {
      ...base,
      state: "submitted",
      updatedAt: submittedAt,
      externalId: "/scratch/job",
    });
    const confirmedAt = new Date(Date.now() + 2).toISOString();
    persistEffectIntent(path, {
      ...base,
      state: "confirmed",
      updatedAt: confirmedAt,
      externalId: "/scratch/job",
    });

    const cancelAt = new Date(Date.now() + 3).toISOString();
    persistEffectIntent(path, {
      ...base,
      state: "cancel_requested",
      updatedAt: cancelAt,
      externalId: "/scratch/job",
    });
    expect(readEffectIntent(path)?.state).toBe("cancel_requested");
  });
});
