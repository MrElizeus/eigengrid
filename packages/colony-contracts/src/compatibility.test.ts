import { describe, expect, test } from "bun:test";
import {
  ColonyCompatibilityManifestSchema,
  ColonyCompatibilityError,
  assertCompatibility,
  compareSemver,
  evaluateCompatibility,
  versionInRange,
} from "./compatibility";
import { sealContract } from "./digest";
import { CONTRACT_SCHEMA_IDS } from "./primitives";
import { compatibilityConsumer, validCompatibilityManifest } from "./test-fixtures";

describe("colony contract compatibility", () => {
  test("covers every supported V1 contract tuple", () => {
    const provider = validCompatibilityManifest();
    const consumer = compatibilityConsumer();
    expect(consumer.requires.map((requirement) => requirement.id)).toEqual([
      ...CONTRACT_SCHEMA_IDS,
    ]);
    expect(evaluateCompatibility(consumer, provider)).toEqual({ compatible: true, failures: [] });
    expect(() => assertCompatibility(consumer, provider)).not.toThrow();
  });

  test("fails closed on protocol-major mismatch before considering fallback", () => {
    const provider = validCompatibilityManifest();
    const incompatible = sealContract({
      ...provider,
      protocol: { ...provider.protocol, version: "2.0.0" },
      provides: provider.provides.map((capability) =>
        capability.kind === "protocol" ? { ...capability, version: "2.0.0" } : capability,
      ),
    });
    const result = evaluateCompatibility(compatibilityConsumer(), incompatible);
    expect(result.compatible).toBe(false);
    expect(result.failures.map((failure) => failure.code)).toContain("PROTOCOL_MAJOR_MISMATCH");
    expect(() => assertCompatibility(compatibilityConsumer(), incompatible)).toThrow(
      ColonyCompatibilityError,
    );
  });

  test("reports missing, version-skewed, and feature-incomplete declarations", () => {
    const provider = validCompatibilityManifest();
    const missing = sealContract({
      ...provider,
      provides: provider.provides.filter(
        (capability) => capability.id !== "eigengrid.context-pack.v1",
      ),
    });
    expect(evaluateCompatibility(compatibilityConsumer(), missing).failures).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "MISSING_CAPABILITY" })]),
    );

    const skewed = sealContract({
      ...provider,
      provides: provider.provides.map((capability) =>
        capability.id === "eigengrid.context-pack.v1"
          ? { ...capability, version: "2.0.0" }
          : capability,
      ),
    });
    expect(evaluateCompatibility(compatibilityConsumer(), skewed).failures).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "VERSION_MISMATCH" })]),
    );

    const featureless = sealContract({ ...provider, featureFlags: [] });
    expect(evaluateCompatibility(compatibilityConsumer(), featureless).failures).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "MISSING_FEATURE" })]),
    );
  });

  test("refuses an unsealed manifest and unknown compatibility fields", () => {
    const provider = validCompatibilityManifest();
    const tampered = { ...provider, featureFlags: [] };
    expect(evaluateCompatibility(compatibilityConsumer(), tampered).failures).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "INVALID_DIGEST" })]),
    );
    expect(
      ColonyCompatibilityManifestSchema.safeParse({ ...provider, forwardCompatibleMagic: true })
        .success,
    ).toBe(false);
  });

  test("implements half-open semantic-version ranges including prereleases", () => {
    const range = { minimumInclusive: "1.0.0", maximumExclusive: "2.0.0" };
    expect(versionInRange("1.0.0", range)).toBe(true);
    expect(versionInRange("1.99.99", range)).toBe(true);
    expect(versionInRange("2.0.0", range)).toBe(false);
    expect(compareSemver("1.0.0-alpha.1", "1.0.0-alpha.2")).toBeLessThan(0);
    expect(compareSemver("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
    expect(compareSemver("999999999999999999999.0.0", "2.0.0")).toBeGreaterThan(0);
    for (const invalid of ["1.0.0-01", "1.0.0-alpha..1", "1.0.0+build..1"]) {
      expect(() => compareSemver(invalid, "1.0.0")).toThrow("Invalid semantic version");
    }
  });

  test("requires the declared protocol capability to match the protocol envelope", () => {
    const provider = validCompatibilityManifest();
    const mismatched = {
      ...provider,
      provides: provider.provides.map((capability) =>
        capability.kind === "protocol" ? { ...capability, version: "1.1.0" } : capability,
      ),
    };
    expect(ColonyCompatibilityManifestSchema.safeParse(mismatched).success).toBe(false);
  });
});
