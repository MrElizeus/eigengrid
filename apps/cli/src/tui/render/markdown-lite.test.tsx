import { describe, expect, it } from "bun:test";

import { dedentLines } from "./markdown-lite";

describe("markdown-lite", () => {
  it("dedents fenced code blocks", () => {
    expect(dedentLines(["    line1", "      line2", "    line3"])).toEqual([
      "line1",
      "  line2",
      "line3",
    ]);
  });
});
