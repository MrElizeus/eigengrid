import { zodToJsonSchema } from "zod-to-json-schema";
import { format } from "prettier";
import { digestBytes, canonicalJson, computeContractDigest, sealContract } from "./digest";
import {
  COLONY_CONTRACT_PACKAGE_VERSION,
  COLONY_PROTOCOL_ID,
  COLONY_PROTOCOL_VERSION,
  CONTRACT_SCHEMA_IDS,
  type ContractSchemaId,
} from "./primitives";
import { CONTRACT_SCHEMAS, CONTRACT_VERSIONS } from "./registry";
import type { ColonyCompatibilityManifest } from "./compatibility";

const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema" as const;

function schemaFileName(schema: ContractSchemaId): string {
  return `schemas/${schema}.schema.json`;
}

export function generateJsonSchema(schemaId: ContractSchemaId): Record<string, unknown> {
  const generated = zodToJsonSchema(CONTRACT_SCHEMAS[schemaId], {
    name: schemaId,
    target: "jsonSchema7",
    $refStrategy: "root",
  }) as Record<string, unknown>;
  return {
    ...generated,
    $schema: JSON_SCHEMA_DIALECT,
    $id: `https://eigengrid.dev/schemas/colony/${schemaId}.schema.json`,
    title: `${schemaId} runtime contract`,
  };
}

export function packageCompatibilityManifest(): ColonyCompatibilityManifest {
  const unsigned = {
    schema: "eigengrid.colony-compatibility-manifest.v1" as const,
    package: {
      name: "@eigengrid/colony-contracts",
      version: COLONY_CONTRACT_PACKAGE_VERSION,
    },
    protocol: {
      id: COLONY_PROTOCOL_ID,
      version: COLONY_PROTOCOL_VERSION,
    },
    provides: [
      { kind: "protocol" as const, id: COLONY_PROTOCOL_ID, version: COLONY_PROTOCOL_VERSION },
      ...CONTRACT_SCHEMA_IDS.map((schemaId) => ({
        kind: "contract" as const,
        id: schemaId,
        version: CONTRACT_VERSIONS[schemaId],
      })),
      { kind: "species_schema" as const, id: "eigengrid.species", version: "1.0.0" },
    ],
    requires: [],
    featureFlags: [
      "canonical-sha256-digests",
      "neutral-candidate-contracts",
      "strict-unknown-fields",
    ],
    unknownFieldPolicy: "reject" as const,
    manifestDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  };
  return sealContract(unsigned) as ColonyCompatibilityManifest;
}

export interface GeneratedArtifact {
  relativePath: string;
  content: string;
}

async function formatJson(value: unknown): Promise<string> {
  return format(JSON.stringify(value), {
    parser: "json",
    printWidth: 100,
    semi: true,
    singleQuote: false,
    trailingComma: "all",
  });
}

export async function generateArtifacts(): Promise<GeneratedArtifact[]> {
  const schemaArtifacts = await Promise.all(
    CONTRACT_SCHEMA_IDS.map(async (schemaId) => ({
      relativePath: schemaFileName(schemaId),
      content: await formatJson(generateJsonSchema(schemaId)),
    })),
  );
  const artifactManifest = {
    schema: "eigengrid.colony-schema-artifacts.v1",
    package: "@eigengrid/colony-contracts",
    packageVersion: COLONY_CONTRACT_PACKAGE_VERSION,
    protocol: `${COLONY_PROTOCOL_ID}@${COLONY_PROTOCOL_VERSION}`,
    jsonSchemaDialect: JSON_SCHEMA_DIALECT,
    contracts: schemaArtifacts.map((artifact, index) => ({
      schema: CONTRACT_SCHEMA_IDS[index],
      version: CONTRACT_VERSIONS[CONTRACT_SCHEMA_IDS[index]!],
      file: artifact.relativePath.slice("schemas/".length),
      digest: digestBytes(artifact.content),
    })),
  };
  const compatibility = packageCompatibilityManifest();
  const vectorInput = {
    schema: "eigengrid.context-pack.v1",
    contextDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    zeta: [3, 0, { beta: true, alpha: null }],
    name: "Cafe\u0301",
  };
  const vectorUnsigned = { ...vectorInput };
  delete (vectorUnsigned as Partial<typeof vectorInput>).contextDigest;
  const digestVector = {
    schema: "eigengrid.canonical-digest-vector.v1",
    algorithm: "sha256",
    unicodeNormalization: "NFC",
    omittedTopLevelField: "contextDigest",
    input: vectorInput,
    canonicalUnsignedJson: canonicalJson(vectorUnsigned),
    digest: computeContractDigest(vectorInput),
  };

  return [
    ...schemaArtifacts,
    {
      relativePath: "schemas/artifact-manifest.json",
      content: await formatJson(artifactManifest),
    },
    {
      relativePath: "compatibility/colony-contracts.v1.json",
      content: await formatJson(compatibility),
    },
    {
      relativePath: "vectors/canonical-digest-v1.json",
      content: await formatJson(digestVector),
    },
  ];
}
