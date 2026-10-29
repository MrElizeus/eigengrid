import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// Existing installations store this checksum. A source-file rename or a
// terminology cleanup must not invalidate an installed immutable migration.
test("the published HTTP schema retains its exact bytes after source reorganization", () => {
  const schema = readFileSync(
    new URL("../../apps/cli/src/services/http/schema-v1.sql", import.meta.url),
  );
  expect(createHash("sha256").update(schema).digest("hex")).toBe(
    "9d68cc7b7acfbeb50cac1c8ebd114f806766a6764535cb0f320fb821e2cd0b29",
  );
});
