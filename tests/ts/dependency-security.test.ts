import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { z, type ZodTypeAny } from "zod";
import { z as z4, type ZodType as ZodType4 } from "zod/v4";

const commonJs = createRequire(import.meta.url)("zod") as typeof import("zod");
const commonJs4 = createRequire(import.meta.url)("zod/v4") as typeof import("zod/v4");

for (const [entry, api] of [
  ["ESM", z],
  ["CommonJS", commonJs.z],
] as const) {
  describe(`bounded Zod collections (${entry})`, () => {
    const oversized = Array.from({ length: 3000 }, (_, index) => index);
    const cases: Array<{
      name: string;
      schema: (element: ZodTypeAny) => ZodTypeAny;
      oversized: unknown;
      valid: unknown;
    }> = [
      {
        name: "array max",
        schema: (element) => api.array(element).max(2),
        oversized,
        valid: [1, 2],
      },
      {
        name: "array exact length",
        schema: (element) => api.array(element).length(2),
        oversized,
        valid: [1, 2],
      },
      {
        name: "set max",
        schema: (element) => api.set(element).max(2),
        oversized: new Set(oversized),
        valid: new Set([1, 2]),
      },
      {
        name: "set exact size",
        schema: (element) => api.set(element).size(2),
        oversized: new Set(oversized),
        valid: new Set([1, 2]),
      },
    ];

    for (const fixture of cases) {
      for (const asynchronous of [false, true]) {
        test(`${fixture.name} rejects before visiting elements (${asynchronous ? "async" : "sync"})`, async () => {
          let elementVisits = 0;
          let collectionVisits = 0;
          const visit = () => {
            elementVisits++;
          };
          const element = asynchronous
            ? api.number().superRefine(async () => visit())
            : api.number().superRefine(visit);
          const schema = fixture.schema(element).superRefine(() => {
            collectionVisits++;
          });
          const result = asynchronous
            ? await schema.safeParseAsync(fixture.oversized)
            : schema.safeParse(fixture.oversized);
          expect(result.success).toBe(false);
          if (result.success) throw new Error("oversized collection was accepted");
          expect(result.error.issues).toHaveLength(1);
          expect(result.error.issues[0]?.code).toBe("too_big");
          expect(elementVisits).toBe(0);
          expect(collectionVisits).toBe(0);

          const valid = asynchronous
            ? await schema.safeParseAsync(fixture.valid)
            : schema.safeParse(fixture.valid);
          expect(valid.success).toBe(true);
          if (valid.success) expect(valid.data).toEqual(fixture.valid);
          expect(elementVisits).toBe(2);
          expect(collectionVisits).toBe(1);
        });
      }
    }
  });
}

for (const [entry, api] of [
  ["ESM", z4],
  ["CommonJS", commonJs4.z],
] as const) {
  describe(`bounded Zod v4 collections (${entry})`, () => {
    const values = Array.from({ length: 3000 }, (_, index) => index);
    const cases: Array<{
      name: string;
      schema: (element: ZodType4) => ZodType4;
      large: unknown;
      valid: unknown;
    }> = [
      {
        name: "array max",
        schema: (element) => api.array(element).max(2),
        large: values,
        valid: [1, 2],
      },
      {
        name: "array length",
        schema: (element) => api.array(element).length(2),
        large: values,
        valid: [1, 2],
      },
      {
        name: "set max",
        schema: (element) => api.set(element).max(2),
        large: new Set(values),
        valid: new Set([1, 2]),
      },
      {
        name: "set size",
        schema: (element) => api.set(element).size(2),
        large: new Set(values),
        valid: new Set([1, 2]),
      },
    ];
    for (const fixture of cases)
      for (const asynchronous of [false, true]) {
        test(`${fixture.name} stops before refinements (${asynchronous ? "async" : "sync"})`, async () => {
          let visits = 0;
          let collections = 0;
          const visit = () => {
            visits++;
          };
          const element = asynchronous
            ? api.number().superRefine(async () => visit())
            : api.number().superRefine(visit);
          const schema = fixture.schema(element).superRefine(() => {
            collections++;
          });
          const result = asynchronous
            ? await schema.safeParseAsync(fixture.large)
            : schema.safeParse(fixture.large);
          expect(result.success).toBe(false);
          if (result.success) throw new Error("oversized collection accepted");
          expect(result.error.issues).toHaveLength(1);
          expect(result.error.issues[0]?.code).toBe("too_big");
          expect(visits).toBe(0);
          expect(collections).toBe(0);
          const valid = asynchronous
            ? await schema.safeParseAsync(fixture.valid)
            : schema.safeParse(fixture.valid);
          expect(valid.success).toBe(true);
          if (valid.success) expect(valid.data).toEqual(fixture.valid);
          expect(visits).toBe(2);
          expect(collections).toBe(1);
        });
      }
  });
}
