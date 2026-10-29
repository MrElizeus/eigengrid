import { describe, expect, test } from "bun:test";
import { bindEffectOperationIdentity, sealEffectJournalFrame } from "./digest";
import {
  EffectJournal,
  InMemoryEffectJournalStore,
  type EffectJournalCursor,
  type EffectJournalStore,
  type EffectJournalTail,
} from "./journal";
import type { EffectJournalFrame } from "./schemas";

function intent(id: string) {
  return {
    mutationId: `mutation:${id}`,
    identity: bindEffectOperationIdentity(
      {
        operationId: `operation:${id}`,
        operationKind: "compute.submit",
        aggregate: { type: "mission-work-unit", id },
        idempotency: { scope: "fixture", key: id },
        correlationId: id,
      },
      { id },
    ),
    at: "2026-10-25T00:00:00.000Z",
  };
}

class CountingStore extends InMemoryEffectJournalStore {
  framesRead = 0;
  fullReads = 0;
  override async read() {
    this.fullReads++;
    return super.read();
  }
  override async readAfter(cursor: EffectJournalCursor) {
    const result = await super.readAfter(cursor);
    this.framesRead += result.frames.length;
    return result;
  }
}

describe("immutable journal incremental replay", () => {
  test("reads each frame once, observes another writer and rebuilds on restart", async () => {
    const store = new CountingStore();
    const journal = new EffectJournal(store);
    for (let i = 0; i < 100; i++) await journal.appendIntent(intent(String(i)));
    expect((await journal.snapshot()).sequence).toBe(100);
    expect(store.framesRead).toBe(100);
    for (let i = 0; i < 20; i++) expect((await journal.get("operation:0"))?.revision).toBe(1);
    expect(store.framesRead).toBe(100);
    expect(store.fullReads).toBe(0);

    const restarted = new EffectJournal(store);
    expect(await restarted.snapshot()).toEqual(await journal.snapshot());
    expect(store.framesRead).toBe(200);
    await restarted.appendIntent(intent("external"));
    expect((await journal.get("operation:external"))?.state).toBe("pending");
    expect(store.framesRead).toBe(201);
    // Public results cannot mutate the cached authority.
    const operation = (await journal.get("operation:0"))!;
    operation.identity.operationId = "changed";
    expect((await journal.get("operation:0"))?.identity.operationId).toBe("operation:0");
  });

  test("concurrent readers and independent writers preserve one durable mutation", async () => {
    const store = new CountingStore();
    const journals = [new EffectJournal(store), new EffectJournal(store)];
    const input = intent("race");
    const writes = await Promise.all(
      Array.from({ length: 24 }, (_, i) => journals[i % 2]!.appendIntent(input)),
    );
    expect(writes.filter((write) => write.appended)).toHaveLength(1);
    expect((await journals[0]!.snapshot()).sequence).toBe(1);
    await Promise.all(
      Array.from({ length: 16 }, (_, i) => journals[i % 2]!.get(input.identity.operationId)),
    );
    expect(store.framesRead).toBe(2);
  });

  test("rejects invalid prefix cursors instead of falling back to stale cached state", async () => {
    const store = new InMemoryEffectJournalStore();
    await new EffectJournal(store).appendIntent(intent("cursor"));
    for (const cursor of [
      { sequence: 1, frameDigest: null },
      { sequence: 2, frameDigest: null },
      { sequence: -1, frameDigest: null },
      { sequence: 0.5, frameDigest: null },
    ])
      await expect(store.readAfter(cursor)).rejects.toThrow("cursor");
  });

  test("an invalid tail never poisons a later replay, including a partially valid suffix", async () => {
    const store = new InMemoryEffectJournalStore();
    const writer = new EffectJournal(store);
    await writer.appendIntent(intent("initial"));
    let corrupt: ((tail: EffectJournalTail) => EffectJournalTail) | undefined;
    const adapter: EffectJournalStore = {
      read: () => store.read(),
      compareAndAppend: (sequence, frame) => store.compareAndAppend(sequence, frame),
      async readAfter(cursor) {
        const tail = await store.readAfter(cursor);
        return corrupt ? corrupt(tail) : tail;
      },
    };
    const reader = new EffectJournal(adapter);
    await reader.snapshot();
    await writer.appendIntent(intent("second"));
    await writer.appendIntent(intent("third"));
    const attacks: Array<(tail: EffectJournalTail) => EffectJournalTail> = [
      (tail) => ({ ...tail, after: { ...tail.after, sequence: 12 } }),
      (tail) => ({ ...tail, frames: tail.frames.slice(1) }),
      (tail) => ({ ...tail, head: { ...tail.head, frameDigest: null } }),
      (tail) => ({
        ...tail,
        frames: tail.frames.map((frame, index) =>
          index === tail.frames.length - 1 ? { ...frame, sequence: frame.sequence + 1 } : frame,
        ),
      }),
      (tail) => ({
        ...tail,
        frames: tail.frames.map((frame, index) =>
          index === tail.frames.length - 1 &&
          frame.schema === "eigengrid.effect-journal-operation-commit.v1"
            ? sealEffectJournalFrame({ ...frame, operation: { ...frame.operation, revision: 7 } })
            : frame,
        ),
      }),
    ];
    for (const attack of attacks) {
      corrupt = attack;
      await expect(reader.snapshot()).rejects.toThrow();
      // Stay fail-closed on repeated reads until the source is repaired.
      await expect(reader.get("operation:initial")).rejects.toThrow();
      corrupt = undefined;
      expect(await reader.snapshot()).toEqual(await writer.snapshot());
      // Add fresh frames so every attack exercises a nonempty suffix.
      await writer.appendIntent(intent(`next:${attacks.indexOf(attack)}`));
    }
  });

  test("mutable adapters revalidate the whole history on every read", async () => {
    const store = new InMemoryEffectJournalStore();
    await new EffectJournal(store).appendIntent(intent("mutable"));
    let frames: readonly EffectJournalFrame[] = await store.read();
    const journal = new EffectJournal({
      read: async () => structuredClone(frames),
      compareAndAppend: (sequence, frame) => store.compareAndAppend(sequence, frame),
    });
    expect((await journal.snapshot()).sequence).toBe(1);
    frames = [{ ...frames[0]!, frameDigest: `sha256:${"0".repeat(64)}` }];
    await expect(journal.get("operation:mutable")).rejects.toThrow("digest mismatch");
  });
});
