/** Reproducible software benchmark; never connects to an engine or production store. */
import {
  EffectJournal,
  InMemoryEffectJournalStore,
  type EffectJournalStore,
} from "../../packages/effect-journal/src/journal";
import { bindEffectOperationIdentity } from "../../packages/effect-journal/src/digest";

const counts = process.argv.slice(2).map(Number);
if (!counts.length) counts.push(50, 100, 200);
if (counts.some((count) => !Number.isSafeInteger(count) || count < 1 || count > 10_000)) {
  throw new Error("Provide journal sizes from 1 to 10000");
}
const results = [];
for (const count of counts) {
  for (const mode of ["full-replay", "immutable-tail"] as const) {
    const memory = new InMemoryEffectJournalStore();
    let framesRead = 0;
    const store: EffectJournalStore = {
      async read() {
        const frames = await memory.read();
        framesRead += frames.length;
        return frames;
      },
      compareAndAppend: (sequence, frame) => memory.compareAndAppend(sequence, frame),
      ...(mode === "immutable-tail"
        ? {
            async readAfter(cursor: Parameters<InMemoryEffectJournalStore["readAfter"]>[0]) {
              const tail = await memory.readAfter(cursor);
              framesRead += tail.frames.length;
              return tail;
            },
          }
        : {}),
    };
    const journal = new EffectJournal(store);
    const started = performance.now();
    for (let i = 0; i < count; i++) {
      const id = `benchmark:${i}`;
      await journal.appendIntent({
        mutationId: id,
        identity: bindEffectOperationIdentity(
          {
            operationId: id,
            operationKind: "compute.submit",
            aggregate: { type: "work-unit", id },
            idempotency: { scope: "benchmark", key: id },
            correlationId: id,
          },
          { id },
        ),
        at: "2026-10-25T00:00:00.000Z",
      });
    }
    await journal.snapshot();
    const appendMilliseconds = performance.now() - started;
    const readsStarted = performance.now();
    for (let i = 0; i < 20; i++) await journal.get("benchmark:0");
    results.push({
      mode,
      count,
      framesRead,
      appendMilliseconds,
      lookupMilliseconds: performance.now() - readsStarted,
    });
  }
}
console.log(
  JSON.stringify(
    { runtime: `bun ${Bun.version}`, qualification: "synthetic-software-benchmark", results },
    null,
    2,
  ),
);
