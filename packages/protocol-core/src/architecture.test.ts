import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, resolve, relative, extname } from "node:path";
import { tmpdir } from "node:os";
import ts from "typescript";

const core = import.meta.dir;
const root = resolve(core, "../../..");
const schemaRoot = resolve(root, "packages/scientific-schema/src");
const allowedExternal = new Set(["zod", "node:crypto"]);
function audit(entry: string): string[] {
  const seen = new Set<string>(),
    errors: string[] = [];
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.ESNext,
      true,
    );
    const follow = (specifier: string) => {
      if (allowedExternal.has(specifier)) return;
      let target: string;
      if (specifier === "@eigengrid/scientific-schema") target = resolve(schemaRoot, "index.ts");
      else if (specifier.startsWith("."))
        target = resolve(dirname(file), specifier + (extname(specifier) ? "" : ".ts"));
      else {
        errors.push(`${relative(root, file)} imports ${specifier}`);
        return;
      }
      if (![core, schemaRoot].some((base) => target.startsWith(base + "/"))) {
        errors.push(`Dependency escapes neutral packages: ${target}`);
        return;
      }
      walk(target);
    };
    const visit = (node: ts.Node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        if (ts.isStringLiteral(node.moduleSpecifier)) follow(node.moduleSpecifier.text);
        else errors.push("Nonliteral module dependency");
      }
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require"))
      ) {
        const arg = node.arguments[0];
        if (!arg || !ts.isStringLiteral(arg))
          errors.push("Dynamic dependency is not statically bounded");
        else follow(arg.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  };
  walk(entry);
  return errors;
}

describe("protocol kernel independence", () => {
  test("transitive production imports contain only neutral schema and crypto/Zod", () => {
    expect(audit(resolve(core, "index.ts"))).toEqual([]);
    const manifest = JSON.parse(readFileSync(resolve(core, "../package.json"), "utf8"));
    expect(Object.keys(manifest.dependencies).sort()).toEqual([
      "@eigengrid/scientific-schema",
      "zod",
    ]);
  });
  test("all public entry points obey the same dependency boundary", () => {
    const manifest = JSON.parse(readFileSync(resolve(core, "../package.json"), "utf8"));
    for (const entry of Object.values(manifest.exports) as string[]) {
      expect(audit(resolve(core, "..", entry))).toEqual([]);
    }
  });
  test("no runtime or fixture packages leak through the kernel exports", () => {
    for (const filename of readdirSync(core).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.includes("fixtures"),
    )) {
      const text = readFileSync(resolve(core, filename), "utf8");
      expect(text).not.toMatch(
        /(?:from|import\s*\()\s*["']@eigengrid\/(?:agent|model-gateway|mission-runtime|db|slurm|agent-substrate)/u,
      );
    }
  });
  test("bundled compiler runs in a fresh process with no LLM configuration", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "eigengrid-compiler-no-model-"));
    try {
      const entry = resolve(dir, "entry.ts");
      await Bun.write(
        entry,
        `import { compileMdWorkflowProtocol } from ${JSON.stringify(resolve(core, "index.ts"))};\nimport { makeInput } from ${JSON.stringify(resolve(core, "md-fixtures.ts"))};\nconst result = compileMdWorkflowProtocol(makeInput()); console.log(JSON.stringify({ digest: result.graphDigest, count: result.workUnits.length }));`,
      );
      const build = await Bun.build({ entrypoints: [entry], target: "bun", outdir: dir });
      expect(build.success).toBe(true);
      const output = build.outputs.find((file) => file.kind === "entry-point")!;
      const execute = () =>
        Bun.spawnSync({ cmd: [process.execPath, output.path], env: {}, cwd: dir });
      const first = execute(),
        second = execute();
      expect(first.exitCode).toBe(0);
      expect(second.exitCode).toBe(0);
      expect(first.stdout.toString()).toBe(second.stdout.toString());
      const report = JSON.parse(first.stdout.toString());
      expect(report.count).toBe(1);
      expect(report.digest).toMatch(/^[a-f0-9]{64}$/u);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
