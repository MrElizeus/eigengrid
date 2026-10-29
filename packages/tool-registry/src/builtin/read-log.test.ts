import { afterEach, describe, expect, test } from "bun:test";
import {
  closeSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../types";
import { ToolRegistry } from "../registry";
import { readLogTool } from "./read-log";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "eigengrid-log-tail-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "stdout.log");
  const ctx = {
    db: {
      listArtifacts: async () => [{ kind: "log", label: "stdout", path }],
      getJob: async () => null,
    },
  } as unknown as ToolContext;
  return { directory, path, ctx };
}

describe("read-log bounded file boundary", () => {
  test("tails a sparse multi-gigabyte log without reading the complete file", async () => {
    const { path, ctx } = fixture();
    const descriptor = openSync(path, "w");
    const size = 3 * 1024 * 1024 * 1024;
    const tail = Buffer.from("previous stage\nfinal energy: -76.123 Hartree");
    try {
      ftruncateSync(descriptor, size);
      writeSync(descriptor, tail, 0, tail.length, size - tail.length);
    } finally {
      closeSync(descriptor);
    }
    const result = await readLogTool.execute(ctx, { jobId: "job", lines: 1 });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      ok: true,
      content: "final energy: -76.123 Hartree",
      truncated: true,
    });
  });

  test("bounds encoded content even when invalid UTF-8 expands during decoding", async () => {
    const { path, ctx } = fixture();
    writeFileSync(path, Buffer.concat([Buffer.alloc(100_000, 0xff), Buffer.from("END")]));
    const result = await readLogTool.execute(ctx, { jobId: "job" });
    expect(result.ok).toBe(true);
    expect(result.data?.truncated).toBe(true);
    expect(Buffer.byteLength(result.data?.content ?? "")).toBeLessThanOrEqual(64 * 1024);
    expect(result.data?.content?.endsWith("END")).toBe(true);
  });

  test("preserves complete small logs and reports line truncation explicitly", async () => {
    const { path, ctx } = fixture();
    writeFileSync(path, "first\nsecond\nthird");
    expect((await readLogTool.execute(ctx, { jobId: "job" })).data).toMatchObject({
      content: "first\nsecond\nthird",
      truncated: false,
    });
    expect((await readLogTool.execute(ctx, { jobId: "job", lines: 2 })).data).toMatchObject({
      content: "second\nthird",
      truncated: true,
    });
    writeFileSync(path, "first\nsecond\nthird\n");
    expect((await readLogTool.execute(ctx, { jobId: "job", lines: 1 })).data).toMatchObject({
      content: "third\n",
      truncated: true,
    });
  });

  test("rejects symlinks instead of reading their target", async () => {
    const { directory, path, ctx } = fixture();
    const target = join(directory, "private.txt");
    writeFileSync(target, "private fixture");
    symlinkSync(target, path);
    const result = await readLogTool.execute(ctx, { jobId: "job" });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("READ_ERROR");
    expect(JSON.stringify(result)).not.toContain("private fixture");
  });

  test("rejects a FIFO without waiting for a writer", async () => {
    const { path, ctx } = fixture();
    expect(spawnSync("mkfifo", [path]).status).toBe(0);
    const result = await readLogTool.execute(ctx, { jobId: "job" });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("regular file");
  });

  test("rejects invalid line limits through the tool settlement boundary", async () => {
    const registry = new ToolRegistry([{ action: "*", resource: "*", effect: "allow" }]);
    registry.register(readLogTool);
    for (const lines of [0, -1, 0.5, 2001]) {
      const result = await registry
        .materialize()
        .settle(
          { id: `invalid-${lines}`, name: "read-log", input: { jobId: "job", lines } },
          {} as ToolContext,
        );
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("INVALID_INPUT");
    }
  });
});
