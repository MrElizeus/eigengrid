import { describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalReceiptError, readReceipt, receiptPath, writeReceipt } from "./local-receipt";

describe("local terminal receipt immutability", () => {
  it("keeps the first exact receipt and rejects divergent replay without overwrite", () => {
    const root = mkdtempSync(join(tmpdir(), "eigengrid-receipt-cas-"));
    const attemptId = "attempt-receipt-cas";
    const receipt = {
      schemaVersion: 1,
      jobId: "job-receipt-cas",
      attemptId,
      pid: 12345,
      command: "/bin/true",
      args: [],
      cwd: root,
      exitCode: null,
      signal: "SIGTERM",
      finishedAt: 100,
      status: "cancelled",
    } as const;

    try {
      writeReceipt(root, attemptId, receipt);
      const firstMtime = statSync(receiptPath(root, attemptId)).mtimeMs;

      writeReceipt(root, attemptId, receipt);
      expect(statSync(receiptPath(root, attemptId)).mtimeMs).toBe(firstMtime);

      expect(() => writeReceipt(root, attemptId, { ...receipt, finishedAt: 101 })).toThrow(
        LocalReceiptError,
      );
      expect(readReceipt(root, attemptId)).toEqual(receipt);
      expect(
        readdirSync(join(root, ".eigengrid")).filter((name) => name.includes(".tmp-")),
      ).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
