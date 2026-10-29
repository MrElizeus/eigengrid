/**
 * tui-message-ids.test.ts
 *
 * Ticket 13, coverage item 1:
 *   - message IDs are unique
 */
import { describe, it, expect } from "bun:test";
import { nextMessageId } from "../../apps/cli/src/tui/state/tui-types";

describe("nextMessageId", () => {
  it("generates unique IDs", () => {
    const ids = Array.from({ length: 1000 }, () => nextMessageId("msg"));
    const set = new Set(ids);
    expect(set.size).toBe(1000);
  });

  it("prefix is reflected in the ID", () => {
    const id = nextMessageId("user");
    expect(id.startsWith("user-")).toBe(true);
  });

  it("each call increments the sequence", () => {
    const a = nextMessageId("x");
    const b = nextMessageId("x");
    const seqA = parseInt(a.split("-")[2]);
    const seqB = parseInt(b.split("-")[2]);
    expect(seqB).toBeGreaterThan(seqA);
  });
});
