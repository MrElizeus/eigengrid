import type { z } from "zod";
import {
  AgentWorkOrderSchema,
  AgentWorkResultSchema,
  ContextPackSchema,
  CorrectionOrderSchema,
  VerificationRequestSchema,
  VerificationResultSchema,
} from "./contracts";
import { ColonyCompatibilityManifestSchema } from "./compatibility";
import { DIGEST_FIELDS, verifyContractDigest } from "./digest";
import { CONTRACT_SCHEMA_IDS, type ContractSchemaId, ContractSchemaIdSchema } from "./primitives";
import { SpeciesContractSchema, SpeciesIdentitySchema } from "./species";

export const CONTRACT_SCHEMAS = {
  "eigengrid.context-pack.v1": ContextPackSchema,
  "eigengrid.agent-work-order.v1": AgentWorkOrderSchema,
  "eigengrid.agent-work-result.v1": AgentWorkResultSchema,
  "eigengrid.verification-request.v1": VerificationRequestSchema,
  "eigengrid.verification-result.v1": VerificationResultSchema,
  "eigengrid.correction-order.v1": CorrectionOrderSchema,
  "eigengrid.species-identity.v1": SpeciesIdentitySchema,
  "eigengrid.species-contract.v1": SpeciesContractSchema,
  "eigengrid.colony-compatibility-manifest.v1": ColonyCompatibilityManifestSchema,
} as const satisfies Record<ContractSchemaId, z.ZodTypeAny>;

export const CONTRACT_VERSIONS = Object.fromEntries(
  CONTRACT_SCHEMA_IDS.map((schema) => [schema, "1.0.0"]),
) as Readonly<Record<ContractSchemaId, "1.0.0">>;

export type ColonyContract = z.infer<(typeof CONTRACT_SCHEMAS)[ContractSchemaId]>;

export class ColonyContractError extends Error {
  readonly code: "INVALID_ENVELOPE" | "UNSUPPORTED_SCHEMA" | "DIGEST_MISMATCH";

  constructor(
    code: "INVALID_ENVELOPE" | "UNSUPPORTED_SCHEMA" | "DIGEST_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "ColonyContractError";
    this.code = code;
  }
}

function readSchema(input: unknown): ContractSchemaId {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ColonyContractError("INVALID_ENVELOPE", "A colony contract must be an object");
  }
  const parsed = ContractSchemaIdSchema.safeParse(Reflect.get(input, "schema"));
  if (!parsed.success) {
    throw new ColonyContractError(
      "UNSUPPORTED_SCHEMA",
      `Unsupported colony contract schema: ${String(Reflect.get(input, "schema"))}`,
    );
  }
  return parsed.data;
}

/** Strict shape validation only; it does not grant authority or admit a candidate. */
export function parseColonyContract(input: unknown): ColonyContract {
  const schema = readSchema(input);
  return CONTRACT_SCHEMAS[schema].parse(input) as ColonyContract;
}

/** Strict shape and canonical self-digest validation for authority-boundary ingestion. */
export function parseVerifiedColonyContract(input: unknown): ColonyContract {
  const schema = readSchema(input);
  const parsed = CONTRACT_SCHEMAS[schema].parse(input) as ColonyContract;
  if (DIGEST_FIELDS[schema] && !verifyContractDigest(parsed)) {
    throw new ColonyContractError("DIGEST_MISMATCH", `Canonical digest mismatch for ${schema}`);
  }
  return parsed;
}

export function isSupportedContractSchema(value: string): value is ContractSchemaId {
  return ContractSchemaIdSchema.safeParse(value).success;
}
