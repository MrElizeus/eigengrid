import { z } from "zod";
import { verifyContractDigest } from "./digest";
import {
  COLONY_PROTOCOL_ID,
  DigestSchema,
  IdentifierSchema,
  SemverSchema,
  TechnicalIdSchema,
  distinctValues,
} from "./primitives";

interface ParsedSemver {
  major: bigint;
  minor: bigint;
  patch: bigint;
  prerelease: readonly string[];
}

export function parseSemver(value: string): ParsedSemver {
  const parsed = SemverSchema.safeParse(value);
  if (!parsed.success) throw new TypeError(`Invalid semantic version: ${value}`);
  const [withoutBuild] = value.split("+", 1);
  const separator = withoutBuild!.indexOf("-");
  const core = separator === -1 ? withoutBuild! : withoutBuild!.slice(0, separator);
  const prerelease = separator === -1 ? "" : withoutBuild!.slice(separator + 1);
  const [major, minor, patch] = core!.split(".").map((part) => BigInt(part));
  return {
    major: major!,
    minor: minor!,
    patch: patch!,
    prerelease: prerelease === "" ? [] : prerelease.split("."),
  };
}

function compareIdentifiers(left: string, right: string): number {
  const leftNumeric = /^\d+$/u.test(left);
  const rightNumeric = /^\d+$/u.test(right);
  if (leftNumeric && rightNumeric) {
    if (left.length !== right.length) return left.length < right.length ? -1 : 1;
    return left < right ? -1 : left > right ? 1 : 0;
  }
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareSemver(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  for (const field of ["major", "minor", "patch"] as const) {
    if (a[field] !== b[field]) return a[field] < b[field] ? -1 : 1;
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const compared = compareIdentifiers(leftPart, rightPart);
    if (compared !== 0) return compared;
  }
  return 0;
}

export const VersionRangeSchema = z
  .object({
    minimumInclusive: SemverSchema,
    maximumExclusive: SemverSchema,
  })
  .strict()
  .superRefine((range, context) => {
    if (compareSemver(range.minimumInclusive, range.maximumExclusive) >= 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "maximumExclusive must be greater than minimumInclusive",
        path: ["maximumExclusive"],
      });
    }
  });
export type VersionRange = z.infer<typeof VersionRangeSchema>;

export function versionInRange(version: string, range: VersionRange): boolean {
  const parsed = VersionRangeSchema.parse(range);
  return (
    compareSemver(version, parsed.minimumInclusive) >= 0 &&
    compareSemver(version, parsed.maximumExclusive) < 0
  );
}

export const CompatibilityCapabilitySchema = z
  .object({
    kind: z.enum([
      "protocol",
      "contract",
      "species_schema",
      "skill_schema",
      "artifact_evidence_schema",
      "database_schema",
      "eigengrid",
      "codex_substrate",
      "myrmex_profile",
    ]),
    id: IdentifierSchema,
    version: SemverSchema,
    digest: DigestSchema.optional(),
  })
  .strict();
export type CompatibilityCapability = z.infer<typeof CompatibilityCapabilitySchema>;

export const CompatibilityRequirementSchema = z
  .object({
    kind: CompatibilityCapabilitySchema.shape.kind,
    id: IdentifierSchema,
    range: VersionRangeSchema,
    requiredFeatureFlags: z.array(TechnicalIdSchema),
  })
  .strict();
export type CompatibilityRequirement = z.infer<typeof CompatibilityRequirementSchema>;

export const ColonyCompatibilityManifestSchema = z
  .object({
    schema: z.literal("eigengrid.colony-compatibility-manifest.v1"),
    package: z
      .object({
        name: z
          .string()
          .min(1)
          .max(214)
          .regex(
            /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u,
            "Expected an npm-style package identifier",
          ),
        version: SemverSchema,
      })
      .strict(),
    protocol: z
      .object({
        id: z.literal(COLONY_PROTOCOL_ID),
        version: SemverSchema,
      })
      .strict(),
    provides: z.array(CompatibilityCapabilitySchema).min(1),
    requires: z.array(CompatibilityRequirementSchema),
    featureFlags: z.array(TechnicalIdSchema),
    unknownFieldPolicy: z.literal("reject"),
    manifestDigest: DigestSchema,
  })
  .strict()
  .superRefine((manifest, context) => {
    const provideKeys = manifest.provides.map((item) => `${item.kind}\u0000${item.id}`);
    const requirementKeys = manifest.requires.map((item) => `${item.kind}\u0000${item.id}`);
    if (!distinctValues(provideKeys)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Duplicate provided capability" });
    }
    if (!distinctValues(requirementKeys)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Duplicate compatibility requirement",
      });
    }
    if (!distinctValues(manifest.featureFlags)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Duplicate feature flag" });
    }
    for (const [index, requirement] of manifest.requires.entries()) {
      if (!distinctValues(requirement.requiredFeatureFlags)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Duplicate required feature flag",
          path: ["requires", index, "requiredFeatureFlags"],
        });
      }
    }
    const protocolCapability = manifest.provides.find(
      (capability) => capability.kind === "protocol" && capability.id === COLONY_PROTOCOL_ID,
    );
    if (!protocolCapability || protocolCapability.version !== manifest.protocol.version) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "The provided colony protocol capability must match the manifest protocol",
        path: ["provides"],
      });
    }
  });
export type ColonyCompatibilityManifest = z.infer<typeof ColonyCompatibilityManifestSchema>;

export interface CompatibilityFailure {
  code:
    | "INVALID_DIGEST"
    | "PROTOCOL_MAJOR_MISMATCH"
    | "MISSING_CAPABILITY"
    | "VERSION_MISMATCH"
    | "MISSING_FEATURE";
  subject: string;
  detail: string;
}

export interface CompatibilityResult {
  compatible: boolean;
  failures: readonly CompatibilityFailure[];
}

/**
 * Pure, fail-closed negotiation. It observes declarations only and cannot
 * authorize or perform an operation.
 */
export function evaluateCompatibility(
  consumerInput: unknown,
  providerInput: unknown,
): CompatibilityResult {
  const consumer = ColonyCompatibilityManifestSchema.parse(consumerInput);
  const provider = ColonyCompatibilityManifestSchema.parse(providerInput);
  const failures: CompatibilityFailure[] = [];

  if (!verifyContractDigest(consumer)) {
    failures.push({
      code: "INVALID_DIGEST",
      subject: consumer.package.name,
      detail: "Consumer compatibility manifest digest does not match its contents",
    });
  }
  if (!verifyContractDigest(provider)) {
    failures.push({
      code: "INVALID_DIGEST",
      subject: provider.package.name,
      detail: "Provider compatibility manifest digest does not match its contents",
    });
  }

  const consumerProtocol = parseSemver(consumer.protocol.version);
  const providerProtocol = parseSemver(provider.protocol.version);
  if (consumerProtocol.major !== providerProtocol.major) {
    failures.push({
      code: "PROTOCOL_MAJOR_MISMATCH",
      subject: COLONY_PROTOCOL_ID,
      detail: `Consumer major ${consumerProtocol.major} does not match provider major ${providerProtocol.major}`,
    });
  }

  for (const requirement of consumer.requires) {
    const provided = provider.provides.find(
      (candidate) => candidate.kind === requirement.kind && candidate.id === requirement.id,
    );
    if (!provided) {
      failures.push({
        code: "MISSING_CAPABILITY",
        subject: `${requirement.kind}:${requirement.id}`,
        detail: "Required compatibility capability was not declared",
      });
      continue;
    }
    if (!versionInRange(provided.version, requirement.range)) {
      failures.push({
        code: "VERSION_MISMATCH",
        subject: `${requirement.kind}:${requirement.id}`,
        detail: `${provided.version} is outside [${requirement.range.minimumInclusive}, ${requirement.range.maximumExclusive})`,
      });
    }
    for (const flag of requirement.requiredFeatureFlags) {
      if (!provider.featureFlags.includes(flag)) {
        failures.push({
          code: "MISSING_FEATURE",
          subject: flag,
          detail: `Required feature ${flag} is absent from the provider manifest`,
        });
      }
    }
  }

  return { compatible: failures.length === 0, failures };
}

export class ColonyCompatibilityError extends Error {
  readonly failures: readonly CompatibilityFailure[];

  constructor(failures: readonly CompatibilityFailure[]) {
    super(`Colony compatibility failed: ${failures.map((failure) => failure.code).join(", ")}`);
    this.name = "ColonyCompatibilityError";
    this.failures = failures;
  }
}

export function assertCompatibility(consumer: unknown, provider: unknown): void {
  const result = evaluateCompatibility(consumer, provider);
  if (!result.compatible) throw new ColonyCompatibilityError(result.failures);
}
