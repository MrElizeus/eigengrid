import { expect, test } from "bun:test";
import { applicationJson } from "./application-json";

test("optional application output properties are transportable without relaxing untrusted input canonicalization", () => {
  expect(applicationJson({ state: "ready", absent: undefined, result: { count: 1 } })).toEqual({
    state: "ready",
    result: { count: 1 },
  });
  expect(() => applicationJson(undefined)).toThrow();
  expect(() => applicationJson([undefined])).toThrow();
  const sparse: unknown[] = [];
  sparse.length = 2;
  expect(() => applicationJson(sparse)).toThrow();
  let invoked = false;
  expect(() =>
    applicationJson({
      get secret() {
        invoked = true;
        return "private";
      },
    }),
  ).toThrow("accessor");
  expect(invoked).toBe(false);
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  expect(() => applicationJson(cycle)).toThrow("cycle");
});
