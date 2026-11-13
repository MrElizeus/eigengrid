import { expect, test } from "bun:test";
import { retryNonblockingFileIo } from "./operator-file-io";

test("nonblocking filesystem I/O retries transient errors and preserves other failures", async () => {
  let calls = 0;
  expect(
    await retryNonblockingFileIo(() => {
      if (++calls < 3)
        throw Object.assign(new Error(), { code: calls === 1 ? "EAGAIN" : "EWOULDBLOCK" });
      return "bytes";
    }),
  ).toBe("bytes");
  expect(calls).toBe(3);
  calls = 0;
  await expect(
    retryNonblockingFileIo(() => {
      calls++;
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    }),
  ).rejects.toThrow("denied");
  expect(calls).toBe(1);
});

test("persistent transient failure is bounded below half a second of retry delays", async () => {
  let calls = 0;
  await expect(
    retryNonblockingFileIo(() => {
      calls++;
      throw Object.assign(new Error("busy"), { code: "EAGAIN" });
    }),
  ).rejects.toThrow("busy");
  expect(calls).toBe(7);
});
