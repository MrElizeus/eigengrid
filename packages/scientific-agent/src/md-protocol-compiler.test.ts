import { describe, expect, test } from "bun:test";
import * as legacy from "./md-protocol-compiler";
import * as core from "@eigengrid/protocol-core/md-protocol-compiler";

describe("legacy MD compiler compatibility", () => {
  test("retains exactly the neutral exports and function identities", () => {
    expect(Object.keys(legacy).sort()).toEqual(Object.keys(core).sort());
    for (const key of Object.keys(core) as (keyof typeof core)[]) {
      expect(legacy[key]).toBe(core[key]);
    }
  });
});
