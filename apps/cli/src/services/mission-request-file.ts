import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { resolve } from "node:path";
import type { ContentAddressedArtifactStore } from "@eigengrid/mission-runtime";

const requestLimit = 4 * 1024 * 1024;
const artifactLimit = 512 * 1024 * 1024;
const digestPattern = /^[a-f0-9]{64}$/u;

function unchanged(before: BigIntStats, after: BigIntStats): boolean {
  return ["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"].every(
    (key) => before[key as keyof BigIntStats] === after[key as keyof BigIntStats],
  );
}

/** Descriptor-bound, bounded input. Never follows a final symlink or opens a FIFO. */
async function* readStableFile(path: string, maximumBytes: number): AsyncGenerator<Uint8Array> {
  const absolute = resolve(path);
  const before = await lstat(absolute, { bigint: true });
  if (!before.isFile() || before.size < 1n || before.size > BigInt(maximumBytes))
    throw new Error(`Input must be a nonempty regular file of at most ${maximumBytes} bytes`);
  const file = await open(
    absolute,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (!unchanged(before, await file.stat({ bigint: true })))
      throw new Error("Input changed while opening");
    let offset = 0;
    while (offset < Number(before.size)) {
      const chunk = Buffer.alloc(Math.min(1024 * 1024, Number(before.size) - offset));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, offset);
      if (bytesRead === 0) throw new Error("Input was truncated during read");
      offset += bytesRead;
      yield chunk.subarray(0, bytesRead);
    }
    if (
      !unchanged(before, await file.stat({ bigint: true })) ||
      !unchanged(before, await lstat(absolute, { bigint: true }))
    )
      throw new Error("Input changed during read");
  } finally {
    await file.close();
  }
}

export async function readMissionRequestFile(
  path: string,
  maximumBytes = requestLimit,
): Promise<unknown> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 64 * 1024 * 1024)
    throw new Error("JSON input limit must be between 1 byte and 64 MiB");
  const chunks: Uint8Array[] = [];
  for await (const chunk of readStableFile(path, maximumBytes)) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(text) as unknown;
}

/** The digest is checked before the CAS generator completes, hence before publication. */
export async function importMissionArtifact(
  store: Pick<ContentAddressedArtifactStore, "putStream">,
  path: string,
  expectedDigest: string,
  beforePublish?: () => Promise<void>,
) {
  if (!digestPattern.test(expectedDigest))
    throw new Error("Expected SHA-256 must be 64 lowercase hex characters");
  async function* verifiedBytes() {
    const hash = createHash("sha256");
    for await (const chunk of readStableFile(path, artifactLimit)) {
      hash.update(chunk);
      yield chunk;
    }
    if (hash.digest("hex") !== expectedDigest)
      throw new Error("Artifact differs from its expected SHA-256");
    await beforePublish?.();
  }
  return store.putStream(verifiedBytes(), { maxBytes: artifactLimit });
}
