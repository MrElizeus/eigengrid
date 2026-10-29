import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindEffectOperationIdentity, digestEffectValue } from "./digest";
import {
  EffectJournal,
  EffectJournalConflictError,
  EffectJournalRevisionConflictError,
} from "./journal";
import {
  AtomicJsonlEffectJournalTestStore,
  EffectJournalJsonlIntegrityError,
  type JsonlTestStoreFaultPhase,
} from "./jsonl-test-store";
import type { EffectEvidence, EffectOperationIdentity } from "./schemas";

const BASE_TIME = Date.parse("2026-08-30T15:00:00.000Z");

function at(offset: number): string {
  return new Date(BASE_TIME + offset * 1_000).toISOString();
}

function identity(seed: string): EffectOperationIdentity {
  return bindEffectOperationIdentity(
    {
      operationId: `operation:${seed}`,
      operationKind: "provider.effect",
      aggregate: { type: "aggregate", id: `aggregate:${seed}` },
      idempotency: { scope: "jsonl-tests", key: `effect:${seed}` },
      correlationId: `correlation:${seed}`,
    },
    { action: "effect", seed },
  );
}

function receipt(seed: string): EffectEvidence {
  return {
    kind: "receipt",
    source: "provider:test",
    evidenceDigest: digestEffectValue({ receipt: seed }),
    externalIdentity: { providerId: `external-${seed}` },
  };
}

function temporaryJournal(): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "eigengrid-effect-journal-"));
  return { directory, path: join(directory, "effect-journal.jsonl") };
}

describe("atomic JSONL effect journal test store", () => {
  test("serializes concurrent independent writers without lost updates or sequence gaps", async () => {
    const { directory, path } = temporaryJournal();
    try {
      const operations = Array.from({ length: 32 }, (_, index) => identity(`concurrent-${index}`));
      const results = await Promise.all(
        operations.map((operationIdentity, index) =>
          new EffectJournal(new AtomicJsonlEffectJournalTestStore(path)).appendIntent({
            mutationId: `mutation:concurrent:${index}`,
            identity: operationIdentity,
            at: at(index),
          }),
        ),
      );
      expect(results.every(({ appended }) => appended)).toBe(true);
      const snapshot = await new EffectJournal(
        new AtomicJsonlEffectJournalTestStore(path),
      ).snapshot();
      expect(snapshot.sequence).toBe(32);
      expect(snapshot.operations).toHaveLength(32);
      expect(snapshot.outboxEvents).toHaveLength(32);
      expect(snapshot.outboxEvents.map(({ sequence }) => sequence)).toEqual(
        Array.from({ length: 32 }, (_, index) => index + 1),
      );
      expect(readFileSync(path, "utf8").split("\n").filter(Boolean)).toHaveLength(32);
      expect(existsSync(`${path}.lock`)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("concurrent identical append and reconcile each commit exactly once", async () => {
    const { directory, path } = temporaryJournal();
    try {
      const operationIdentity = identity("same");
      const appendInput = {
        mutationId: "mutation:same:pending",
        identity: operationIdentity,
        at: at(0),
      };
      const appended = await Promise.all(
        Array.from({ length: 24 }, () =>
          new EffectJournal(new AtomicJsonlEffectJournalTestStore(path)).appendIntent(appendInput),
        ),
      );
      expect(appended.filter((result) => result.appended)).toHaveLength(1);

      const reconcileInput = {
        mutationId: "mutation:same:confirmed",
        operationId: operationIdentity.operationId,
        requestDigest: operationIdentity.requestDigest,
        expectedRevision: 1,
        state: "confirmed" as const,
        at: at(1),
        evidence: receipt("same"),
      };
      const reconciled = await Promise.all(
        Array.from({ length: 24 }, () =>
          new EffectJournal(new AtomicJsonlEffectJournalTestStore(path)).reconcile(reconcileInput),
        ),
      );
      expect(reconciled.filter((result) => result.appended)).toHaveLength(1);
      const snapshot = await new EffectJournal(
        new AtomicJsonlEffectJournalTestStore(path),
      ).snapshot();
      expect(snapshot.sequence).toBe(2);
      expect(snapshot.operations).toEqual([
        expect.objectContaining({ state: "confirmed", revision: 2 }),
      ]);
      expect(snapshot.outboxEvents).toHaveLength(2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("concurrent competing reconciliation has one winner and a visible revision conflict", async () => {
    const { directory, path } = temporaryJournal();
    try {
      const operationIdentity = identity("race");
      const journal = new EffectJournal(new AtomicJsonlEffectJournalTestStore(path));
      await journal.appendIntent({
        mutationId: "mutation:race:pending",
        identity: operationIdentity,
        at: at(0),
      });
      const confirmed = new EffectJournal(new AtomicJsonlEffectJournalTestStore(path)).reconcile({
        mutationId: "mutation:race:confirmed",
        operationId: operationIdentity.operationId,
        requestDigest: operationIdentity.requestDigest,
        expectedRevision: 1,
        state: "confirmed",
        at: at(1),
        evidence: receipt("race-confirmed"),
      });
      const failed = new EffectJournal(new AtomicJsonlEffectJournalTestStore(path)).reconcile({
        mutationId: "mutation:race:failed",
        operationId: operationIdentity.operationId,
        requestDigest: operationIdentity.requestDigest,
        expectedRevision: 1,
        state: "failed",
        at: at(1),
        evidence: {
          kind: "failure",
          source: "provider:test",
          evidenceDigest: digestEffectValue({ failure: "race" }),
        },
      });
      const settled = await Promise.allSettled([confirmed, failed]);
      expect(settled.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      const rejection = settled.find(({ status }) => status === "rejected");
      expect(rejection?.status).toBe("rejected");
      if (rejection?.status === "rejected") {
        expect(rejection.reason).toBeInstanceOf(EffectJournalRevisionConflictError);
      }
      const snapshot = await journal.snapshot();
      expect(snapshot.sequence).toBe(2);
      expect(["confirmed", "failed"]).toContain(snapshot.operations[0]?.state);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  for (const phase of ["before-temp-fsync", "before-rename"] as const) {
    test(`a ${phase} fault leaves the prior complete journal and cleans temporary state`, async () => {
      const { directory, path } = temporaryJournal();
      try {
        const operationIdentity = identity(`fault-${phase}`);
        const stable = new EffectJournal(new AtomicJsonlEffectJournalTestStore(path));
        await stable.appendIntent({
          mutationId: `mutation:fault:${phase}:pending`,
          identity: operationIdentity,
          at: at(0),
        });
        let injected = false;
        const faulting = new EffectJournal(
          new AtomicJsonlEffectJournalTestStore(path, {
            observeFault(observed) {
              if (!injected && observed === phase) {
                injected = true;
                throw new Error(`injected ${phase}`);
              }
            },
          }),
        );
        await expect(
          faulting.reconcile({
            mutationId: `mutation:fault:${phase}:confirmed`,
            operationId: operationIdentity.operationId,
            requestDigest: operationIdentity.requestDigest,
            expectedRevision: 1,
            state: "confirmed",
            at: at(1),
            evidence: receipt(`fault-${phase}`),
          }),
        ).rejects.toThrow(`injected ${phase}`);
        const recovered = await stable.snapshot();
        expect(recovered.sequence).toBe(1);
        expect(recovered.operations[0]).toMatchObject({ state: "pending", revision: 1 });
        expect(readdirSync(directory).filter((name) => name.includes(".tmp"))).toEqual([]);
        expect(existsSync(`${path}.lock`)).toBe(false);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }

  test("an after-rename failure is recovered as an idempotent committed replay", async () => {
    const { directory, path } = temporaryJournal();
    try {
      const operationIdentity = identity("after-rename");
      const stable = new EffectJournal(new AtomicJsonlEffectJournalTestStore(path));
      await stable.appendIntent({
        mutationId: "mutation:after-rename:pending",
        identity: operationIdentity,
        at: at(0),
      });
      let injected = false;
      const input = {
        mutationId: "mutation:after-rename:confirmed",
        operationId: operationIdentity.operationId,
        requestDigest: operationIdentity.requestDigest,
        expectedRevision: 1,
        state: "confirmed" as const,
        at: at(1),
        evidence: receipt("after-rename"),
      };
      await expect(
        new EffectJournal(
          new AtomicJsonlEffectJournalTestStore(path, {
            observeFault(phase: JsonlTestStoreFaultPhase) {
              if (!injected && phase === "after-rename") {
                injected = true;
                throw new Error("injected after-rename");
              }
            },
          }),
        ).reconcile(input),
      ).rejects.toThrow("injected after-rename");

      const reopened = new EffectJournal(new AtomicJsonlEffectJournalTestStore(path));
      expect(await reopened.get(operationIdentity.operationId)).toMatchObject({
        state: "confirmed",
        revision: 2,
      });
      expect((await reopened.reconcile(input)).appended).toBe(false);
      expect((await reopened.snapshot()).sequence).toBe(2);
      expect(existsSync(`${path}.lock`)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("replay fails closed on a torn tail, blank record, unknown field, or digest change", async () => {
    const { directory, path } = temporaryJournal();
    try {
      const operationIdentity = identity("integrity");
      const journal = new EffectJournal(new AtomicJsonlEffectJournalTestStore(path));
      await journal.appendIntent({
        mutationId: "mutation:integrity:pending",
        identity: operationIdentity,
        at: at(0),
      });
      const valid = readFileSync(path, "utf8").trimEnd();
      for (const content of [
        `${valid}\n{"schema":`,
        `${valid}\n\n`,
        `${valid.slice(0, -1)},"inventedAuthority":true}\n`,
        `${valid.replace(/sha256:[a-f0-9]{64}/u, `sha256:${"0".repeat(64)}`)}\n`,
      ]) {
        writeFileSync(path, content, "utf8");
        await expect(
          new EffectJournal(new AtomicJsonlEffectJournalTestStore(path)).snapshot(),
        ).rejects.toBeInstanceOf(EffectJournalJsonlIntegrityError);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("same idempotency key with another operation remains a visible conflict after replay", async () => {
    const { directory, path } = temporaryJournal();
    try {
      const firstIdentity = identity("idempotency");
      await new EffectJournal(new AtomicJsonlEffectJournalTestStore(path)).appendIntent({
        mutationId: "mutation:idempotency:first",
        identity: firstIdentity,
        at: at(0),
      });
      const otherIdentity = { ...firstIdentity, operationId: "operation:idempotency:other" };
      await expect(
        new EffectJournal(new AtomicJsonlEffectJournalTestStore(path)).appendIntent({
          mutationId: "mutation:idempotency:second",
          identity: otherIdentity,
          at: at(1),
        }),
      ).rejects.toBeInstanceOf(EffectJournalConflictError);
      expect(await new AtomicJsonlEffectJournalTestStore(path).read()).toHaveLength(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
