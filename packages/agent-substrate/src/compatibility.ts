export const EIGENGRID_AGENT_PROTOCOL = "eigengrid.agent.v1" as const;
export const AGENT_SUBSTRATE_ADAPTER_VERSION = "0.1.0" as const;

/** Provenance of the experimental v2 bindings used to derive the V1 method policy. */
export const PINNED_CODEX_APP_SERVER_BINDING = Object.freeze({
  codexCliVersion: "0.151.0",
  codexUpstreamCommit: "78c290807ce710180111df227df3b7a4fe845452",
  schemaSha256: "a586cdc50f84c56c7654387e869b470a689796fa1c57678dcafb5921bb2d5255",
} as const);

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GIT_COMMIT_PATTERN = /^[0-9a-f]{40}$/;

const EXPECTATION_FIELDS = Object.freeze([
  "adapterProtocol",
  "adapterVersion",
  "codexCliVersion",
  "codexUpstreamCommit",
  "codexBinarySha256",
  "schemaSha256",
  "configurationSha256",
  "requiredFeatures",
] as const);

const OBSERVATION_FIELDS = Object.freeze([
  "adapterProtocol",
  "adapterVersion",
  "codexCliVersion",
  "codexUpstreamCommit",
  "codexBinarySha256",
  "schemaSha256",
  "configurationSha256",
  "availableFeatures",
] as const);

export interface AgentSubstrateCompatibilityExpectation {
  readonly adapterProtocol: typeof EIGENGRID_AGENT_PROTOCOL;
  readonly adapterVersion: typeof AGENT_SUBSTRATE_ADAPTER_VERSION;
  readonly codexCliVersion: typeof PINNED_CODEX_APP_SERVER_BINDING.codexCliVersion;
  readonly codexUpstreamCommit: typeof PINNED_CODEX_APP_SERVER_BINDING.codexUpstreamCommit;
  readonly codexBinarySha256: string;
  readonly schemaSha256: typeof PINNED_CODEX_APP_SERVER_BINDING.schemaSha256;
  readonly configurationSha256: string;
  readonly requiredFeatures: readonly string[];
}

export interface AgentSubstrateCompatibilityObservation {
  readonly adapterProtocol: string;
  readonly adapterVersion: string;
  readonly codexCliVersion: string;
  readonly codexUpstreamCommit: string;
  readonly codexBinarySha256: string;
  readonly schemaSha256: string;
  readonly configurationSha256: string;
  readonly availableFeatures: readonly string[];
}

export type AgentSubstrateCompatibilityErrorCode =
  | "INVALID_COMPATIBILITY_MANIFEST"
  | "ADAPTER_PROTOCOL_MISMATCH"
  | "ADAPTER_VERSION_MISMATCH"
  | "CODEX_VERSION_MISMATCH"
  | "CODEX_COMMIT_MISMATCH"
  | "CODEX_BINARY_MISMATCH"
  | "SCHEMA_MISMATCH"
  | "CONFIGURATION_MISMATCH"
  | "MISSING_REQUIRED_FEATURE";

export class AgentSubstrateCompatibilityError extends Error {
  readonly name = "AgentSubstrateCompatibilityError";

  constructor(
    public readonly code: AgentSubstrateCompatibilityErrorCode,
    public readonly field: string,
  ) {
    super(`Agent substrate compatibility check failed at ${field}`);
  }
}

/**
 * Nominal proof that the exact adapter, Codex artifact, generated schema,
 * effective configuration, and required features passed preflight.
 */
export class AgentSubstratePreflightReceipt {
  readonly protocol = EIGENGRID_AGENT_PROTOCOL;

  private constructor(
    readonly adapterVersion: string,
    readonly codexCliVersion: string,
    readonly codexUpstreamCommit: string,
    readonly codexBinarySha256: string,
    readonly schemaSha256: string,
    readonly configurationSha256: string,
    readonly features: readonly string[],
  ) {
    Object.freeze(this);
  }

  static verify(expectedValue: unknown, observedValue: unknown): AgentSubstratePreflightReceipt {
    const expected = parseExpectation(expectedValue);
    const observed = parseObservation(observedValue);

    assertEqual(
      observed.adapterProtocol,
      expected.adapterProtocol,
      "ADAPTER_PROTOCOL_MISMATCH",
      "adapterProtocol",
    );
    assertEqual(
      observed.adapterVersion,
      expected.adapterVersion,
      "ADAPTER_VERSION_MISMATCH",
      "adapterVersion",
    );
    assertEqual(
      observed.codexCliVersion,
      expected.codexCliVersion,
      "CODEX_VERSION_MISMATCH",
      "codexCliVersion",
    );
    assertEqual(
      observed.codexUpstreamCommit,
      expected.codexUpstreamCommit,
      "CODEX_COMMIT_MISMATCH",
      "codexUpstreamCommit",
    );
    assertEqual(
      observed.codexBinarySha256,
      expected.codexBinarySha256,
      "CODEX_BINARY_MISMATCH",
      "codexBinarySha256",
    );
    assertEqual(observed.schemaSha256, expected.schemaSha256, "SCHEMA_MISMATCH", "schemaSha256");
    assertEqual(
      observed.configurationSha256,
      expected.configurationSha256,
      "CONFIGURATION_MISMATCH",
      "configurationSha256",
    );

    const availableFeatures = new Set(observed.availableFeatures);
    for (const feature of expected.requiredFeatures) {
      if (!availableFeatures.has(feature)) {
        throw new AgentSubstrateCompatibilityError("MISSING_REQUIRED_FEATURE", feature);
      }
    }

    return new AgentSubstratePreflightReceipt(
      expected.adapterVersion,
      expected.codexCliVersion,
      expected.codexUpstreamCommit,
      expected.codexBinarySha256,
      expected.schemaSha256,
      expected.configurationSha256,
      Object.freeze([...expected.requiredFeatures]),
    );
  }
}

export function preflightAgentSubstrate(
  expected: unknown,
  observed: unknown,
): AgentSubstratePreflightReceipt {
  return AgentSubstratePreflightReceipt.verify(expected, observed);
}

function parseExpectation(value: unknown): AgentSubstrateCompatibilityExpectation {
  const record = exactRecord(value, EXPECTATION_FIELDS, "expectation");
  const adapterProtocol = requiredString(record, "adapterProtocol");
  if (adapterProtocol !== EIGENGRID_AGENT_PROTOCOL) {
    throw new AgentSubstrateCompatibilityError("INVALID_COMPATIBILITY_MANIFEST", "adapterProtocol");
  }

  const adapterVersion = requiredString(record, "adapterVersion");
  const codexCliVersion = requiredString(record, "codexCliVersion");
  const codexUpstreamCommit = requiredDigest(record, "codexUpstreamCommit", GIT_COMMIT_PATTERN);
  const schemaSha256 = requiredDigest(record, "schemaSha256", SHA256_PATTERN);
  assertPinned(adapterVersion, AGENT_SUBSTRATE_ADAPTER_VERSION, "adapterVersion");
  assertPinned(codexCliVersion, PINNED_CODEX_APP_SERVER_BINDING.codexCliVersion, "codexCliVersion");
  assertPinned(
    codexUpstreamCommit,
    PINNED_CODEX_APP_SERVER_BINDING.codexUpstreamCommit,
    "codexUpstreamCommit",
  );
  assertPinned(schemaSha256, PINNED_CODEX_APP_SERVER_BINDING.schemaSha256, "schemaSha256");

  return Object.freeze({
    adapterProtocol,
    adapterVersion,
    codexCliVersion,
    codexUpstreamCommit,
    codexBinarySha256: requiredDigest(record, "codexBinarySha256", SHA256_PATTERN),
    schemaSha256,
    configurationSha256: requiredDigest(record, "configurationSha256", SHA256_PATTERN),
    requiredFeatures: requiredStringArray(record, "requiredFeatures"),
  });
}

function parseObservation(value: unknown): AgentSubstrateCompatibilityObservation {
  const record = exactRecord(value, OBSERVATION_FIELDS, "observation");
  return Object.freeze({
    adapterProtocol: requiredString(record, "adapterProtocol"),
    adapterVersion: requiredString(record, "adapterVersion"),
    codexCliVersion: requiredString(record, "codexCliVersion"),
    codexUpstreamCommit: requiredDigest(record, "codexUpstreamCommit", GIT_COMMIT_PATTERN),
    codexBinarySha256: requiredDigest(record, "codexBinarySha256", SHA256_PATTERN),
    schemaSha256: requiredDigest(record, "schemaSha256", SHA256_PATTERN),
    configurationSha256: requiredDigest(record, "configurationSha256", SHA256_PATTERN),
    availableFeatures: requiredStringArray(record, "availableFeatures"),
  });
}

function exactRecord<const Field extends string>(
  value: unknown,
  fields: readonly Field[],
  label: string,
): Readonly<Record<Field, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AgentSubstrateCompatibilityError("INVALID_COMPATIBILITY_MANIFEST", label);
  }

  const record = value as Record<string, unknown>;
  const allowedFields = new Set<string>(fields);
  for (const field of Object.keys(record)) {
    if (!allowedFields.has(field)) {
      throw new AgentSubstrateCompatibilityError("INVALID_COMPATIBILITY_MANIFEST", field);
    }
  }
  for (const field of fields) {
    if (!Object.hasOwn(record, field)) {
      throw new AgentSubstrateCompatibilityError("INVALID_COMPATIBILITY_MANIFEST", field);
    }
  }
  return record as Record<Field, unknown>;
}

function requiredString(record: Readonly<Record<string, unknown>>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new AgentSubstrateCompatibilityError("INVALID_COMPATIBILITY_MANIFEST", field);
  }
  return value;
}

function requiredDigest(
  record: Readonly<Record<string, unknown>>,
  field: string,
  pattern: RegExp,
): string {
  const value = requiredString(record, field);
  if (!pattern.test(value)) {
    throw new AgentSubstrateCompatibilityError("INVALID_COMPATIBILITY_MANIFEST", field);
  }
  return value;
}

function requiredStringArray(
  record: Readonly<Record<string, unknown>>,
  field: string,
): readonly string[] {
  const value = record[field];
  if (!Array.isArray(value)) {
    throw new AgentSubstrateCompatibilityError("INVALID_COMPATIBILITY_MANIFEST", field);
  }

  const values = value.map((item) => {
    if (typeof item !== "string" || item.length === 0) {
      throw new AgentSubstrateCompatibilityError("INVALID_COMPATIBILITY_MANIFEST", field);
    }
    return item;
  });
  if (new Set(values).size !== values.length) {
    throw new AgentSubstrateCompatibilityError("INVALID_COMPATIBILITY_MANIFEST", field);
  }
  return Object.freeze(values);
}

function assertEqual(
  actual: string,
  expected: string,
  code: AgentSubstrateCompatibilityErrorCode,
  field: string,
): void {
  if (actual !== expected) {
    throw new AgentSubstrateCompatibilityError(code, field);
  }
}

function assertPinned<const Pinned extends string>(
  actual: string,
  pinned: Pinned,
  field: string,
): asserts actual is Pinned {
  if (actual !== pinned) {
    throw new AgentSubstrateCompatibilityError("INVALID_COMPATIBILITY_MANIFEST", field);
  }
}
