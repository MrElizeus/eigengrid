import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { digestBytes } from "./digest";
import { generateArtifacts, generateJsonSchema } from "./json-schema-artifacts";
import { CONTRACT_SCHEMA_IDS, type ContractSchemaId } from "./primitives";
import { everyValidContract, validVerificationRequest, validWorkResult } from "./test-fixtures";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

function resolvePointer(root: unknown, pointer: string): unknown {
  if (!pointer.startsWith("#/")) throw new TypeError(`Non-local JSON Schema reference: ${pointer}`);
  return pointer
    .slice(2)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce<unknown>((value, part) => {
      if (typeof value !== "object" || value === null) return undefined;
      return Reflect.get(value, part);
    }, root);
}

function inspectSchemaNode(root: unknown, value: unknown, path = "$"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectSchemaNode(root, item, `${path}[${index}]`));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const node = value as Record<string, unknown>;
  if (node.type === "object" || node.properties) {
    expect(node.additionalProperties, `${path} must reject unknown properties`).toBe(false);
  }
  if (typeof node.$ref === "string") {
    expect(resolvePointer(root, node.$ref), `${path} contains an unresolved $ref`).toBeDefined();
  }
  for (const [key, child] of Object.entries(node)) inspectSchemaNode(root, child, `${path}.${key}`);
}

describe("generated colony JSON Schema artifacts", () => {
  test("are deterministic and checked in without stale or missing files", async () => {
    const generated = await generateArtifacts();
    for (const artifact of generated) {
      expect(await readFile(join(packageRoot, artifact.relativePath), "utf8")).toBe(
        artifact.content,
      );
    }
    const expectedSchemas = generated
      .filter((artifact) => artifact.relativePath.endsWith(".schema.json"))
      .map((artifact) => artifact.relativePath.slice("schemas/".length))
      .sort();
    const actualSchemas = (await readdir(join(packageRoot, "schemas")))
      .filter((file) => file.endsWith(".schema.json"))
      .sort();
    expect(actualSchemas).toEqual(expectedSchemas);
  });

  test("pass Draft 2020-12 meta-validation, resolve local references, and close every object", () => {
    const ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: false });
    for (const schemaId of CONTRACT_SCHEMA_IDS) {
      const schema = generateJsonSchema(schemaId);
      expect(ajv.validateSchema(schema), `${schemaId}: ${ajv.errorsText()}`).toBe(true);
      expect(() => ajv.compile(schema)).not.toThrow();
      inspectSchemaNode(schema, schema);
    }
  });

  test("generated validators accept every runtime fixture and reject unknown fields", () => {
    const ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: false });
    const fixtures = new Map(
      everyValidContract().map((fixture) => [
        (fixture as { schema: ContractSchemaId }).schema,
        fixture,
      ]),
    );
    for (const schemaId of CONTRACT_SCHEMA_IDS) {
      const validate = ajv.compile(generateJsonSchema(schemaId));
      const fixture = fixtures.get(schemaId);
      expect(fixture, `Missing fixture for ${schemaId}`).toBeDefined();
      expect(validate(fixture), `${schemaId}: ${ajv.errorsText(validate.errors)}`).toBe(true);
      expect(validate({ ...(fixture as object), unknownAuthority: true })).toBe(false);
    }
  });

  test("generated validators retain critical no-effect, evidence, trust, and correction bounds", () => {
    const rejects: Array<[ContractSchemaId, unknown]> = [
      [
        "eigengrid.verification-request.v1",
        {
          ...validVerificationRequest(),
          budget: { ...validVerificationRequest().budget, effects: 1 },
        },
      ],
      ["eigengrid.agent-work-result.v1", { ...validWorkResult(), evidence: [] }],
      [
        "eigengrid.agent-work-result.v1",
        {
          ...validWorkResult(),
          candidates: [{ ...validWorkResult().candidates[0]!, trustClass: "authoritative_state" }],
        },
      ],
    ];
    for (const [schemaId, value] of rejects) {
      const ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: false });
      const validate = ajv.compile(generateJsonSchema(schemaId));
      expect(validate(value), `${schemaId} unexpectedly accepted a safety-negative fixture`).toBe(
        false,
      );
    }
  });

  test("artifact manifest binds every generated schema byte-for-byte", async () => {
    const manifest = JSON.parse(
      await readFile(join(packageRoot, "schemas/artifact-manifest.json"), "utf8"),
    ) as { contracts: Array<{ schema: string; file: string; digest: string }> };
    expect(manifest.contracts.map((entry) => entry.schema)).toEqual([...CONTRACT_SCHEMA_IDS]);
    for (const entry of manifest.contracts) {
      const content = await readFile(join(packageRoot, "schemas", entry.file), "utf8");
      expect(digestBytes(content)).toBe(entry.digest);
    }
  });
});
