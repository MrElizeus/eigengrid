import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const runtimeFiles = [
  "compatibility.ts",
  "contracts.ts",
  "digest.ts",
  "index.ts",
  "primitives.ts",
  "registry.ts",
  "species.ts",
] as const;

describe("colony contracts package boundary", () => {
  test("keeps the published runtime dependency surface schema-only", async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      exports: Record<string, string>;
    };
    expect(manifest.dependencies).toEqual({ zod: "^3.24.0" });
    expect(Object.values(manifest.exports)).not.toContain("./src/json-schema-artifacts.ts");
  });

  test("imports no database, runner, shell, network, scheduler, or model-provider runtime", async () => {
    for (const file of runtimeFiles) {
      const source = await readFile(join(packageRoot, "src", file), "utf8");
      const imports = [...source.matchAll(/from\s+["']([^"']+)["']/gu)].map((match) => match[1]!);
      expect(
        imports.every(
          (specifier) =>
            specifier.startsWith("./") || specifier === "zod" || specifier === "node:crypto",
        ),
        `${file}: ${imports.join(", ")}`,
      ).toBe(true);
    }
  });
});
