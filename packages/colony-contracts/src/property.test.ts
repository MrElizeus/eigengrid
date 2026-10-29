import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { versionInRange } from "./compatibility";
import { canonicalJson, computeContractDigest, digestCanonical } from "./digest";
import { parseColonyContract, parseVerifiedColonyContract } from "./registry";
import { everyValidContract } from "./test-fixtures";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function reorder(value: unknown, random: () => number): unknown {
  if (Array.isArray(value)) return value.map((item) => reorder(item, random));
  if (typeof value !== "object" || value === null) return value;
  const entries = Object.entries(value as Record<string, unknown>);
  for (let index = entries.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [entries[index], entries[swap]] = [entries[swap]!, entries[index]!];
  }
  return Object.fromEntries(entries.map(([key, child]) => [key, reorder(child, random)]));
}

describe("colony contract deterministic properties", () => {
  test("round-trips every contract through JSON without widening its schema", () => {
    for (const fixture of everyValidContract()) {
      const roundTripped = JSON.parse(JSON.stringify(fixture)) as unknown;
      expect(parseVerifiedColonyContract(roundTripped)).toEqual(fixture);
    }
  });

  test("canonical bytes and self-digests are invariant across 200 key permutations", () => {
    const random = generator(0x0e_02_00_20);
    for (const fixture of everyValidContract()) {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const permuted = reorder(fixture, random);
        expect(canonicalJson(permuted)).toBe(canonicalJson(fixture));
        if ((fixture as { schema: string }).schema !== "eigengrid.species-identity.v1") {
          expect(computeContractDigest(permuted)).toBe(computeContractDigest(fixture));
        }
      }
    }
  });

  test("accepts exactly the generated in-range V1 versions and rejects the upper bound", () => {
    const random = generator(0xc011_0a17);
    const range = { minimumInclusive: "1.0.0", maximumExclusive: "2.0.0" };
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const minor = Math.floor(random() * 1_000);
      const patch = Math.floor(random() * 1_000);
      expect(versionInRange(`1.${minor}.${patch}`, range)).toBe(true);
      expect(versionInRange(`2.${minor}.${patch}`, range)).toBe(false);
    }
  });

  test("rejects unknown major contract IDs instead of downgrading", () => {
    const context = everyValidContract()[0] as Record<string, unknown>;
    expect(() => parseColonyContract({ ...context, schema: "eigengrid.context-pack.v2" })).toThrow(
      "Unsupported colony contract schema",
    );
  });

  test("matches the checked-in Unicode/key-order golden digest vector", async () => {
    const vector = JSON.parse(
      await readFile(join(packageRoot, "vectors/canonical-digest-v1.json"), "utf8"),
    ) as {
      input: Record<string, unknown>;
      canonicalUnsignedJson: string;
      digest: string;
      omittedTopLevelField: string;
    };
    const unsigned = { ...vector.input };
    delete unsigned[vector.omittedTopLevelField];
    expect(canonicalJson(unsigned)).toBe(vector.canonicalUnsignedJson);
    expect(computeContractDigest(vector.input)).toBe(vector.digest);
    expect(digestCanonical(unsigned)).toBe(vector.digest);
    expect(digestCanonical({ ...unsigned, name: "Café" })).toBe(vector.digest);
  });

  test("rejects ambiguous JavaScript values before hashing", () => {
    expect(() => canonicalJson({ value: undefined })).toThrow("undefined");
    expect(() => canonicalJson({ value: Number.NaN })).toThrow("non-finite");
    expect(() => canonicalJson(new Date())).toThrow("non-plain object");
    expect(() => canonicalJson({ é: 1, "e\u0301": 2 })).toThrow("key collision");
    expect(() => canonicalJson({ value: 1, [Symbol("hidden")]: 2 })).toThrow("symbol property");
    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, "value", { enumerable: true, get: () => 1 });
    expect(() => canonicalJson(accessor)).toThrow("accessor");
  });
});
