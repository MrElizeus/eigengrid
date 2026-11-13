import { expect, test } from "bun:test";
import {
  ProductionDispatchConfigSchema,
  validateProductionQualification,
  validateQualificationConfigurations,
} from "./production-dispatch";

const config = ProductionDispatchConfigSchema.parse({
  schemaVersion: "eigengrid.production-dispatch/v1",
  releaseCommit: "a".repeat(40),
  policyDigest: "b".repeat(64),
  slurmVersion: "26.05.5",
  mdSiteAuthority: "/etc/eigengrid/md-authority.json",
  mdArtifactRoot: "/var/lib/eigengrid/head/artifacts",
  mdPostprocessing: "/etc/eigengrid/md-postprocessing.json",
  qualificationReport: "/etc/eigengrid/qualification.json",
  qualificationSha256: "c".repeat(64),
});
const report = {
  schemaVersion: "eigengrid.production-qualification/v2",
  releaseCommit: config.releaseCommit,
  slurmVersion: config.slurmVersion,
  policyDigest: config.policyDigest,
  artifactRoot: config.mdArtifactRoot,
  reviewedBy: "Site reviewer",
  reviewedAt: "2026-11-13T00:00:00Z",
  fixtureDigests: ["d".repeat(64)],
  configurationDigests: { "/etc/eigengrid/md-authority.json": "e".repeat(64) },
  checks: Object.fromEntries(
    ["submission", "accounting", "resultCollection", "restartRecovery", "cancellation"].map(
      (name) => [name, { observation: "Observed and retained", evidenceSha256: ["f".repeat(64)] }],
    ),
  ),
};
test("production admission requires this exact release, scheduler and every completed qualification check", () => {
  expect(() => validateProductionQualification(config, report, config.releaseCommit)).not.toThrow();
  for (const altered of [
    { ...report, releaseCommit: "d".repeat(40) },
    { ...report, slurmVersion: "23.11.4" },
    { ...report, policyDigest: "d".repeat(64) },
    { ...report, artifactRoot: "/elsewhere" },
    { ...report, fixtureDigests: [] },
    { ...report, reviewedBy: "" },
    { ...report, checks: { ...report.checks, resultCollection: false } },
    { ...report, checks: { ...report.checks, restartRecovery: undefined } },
  ])
    expect(() => validateProductionQualification(config, altered, config.releaseCommit)).toThrow();
  expect(() => validateProductionQualification(config, report, undefined)).toThrow();
  expect(() =>
    validateProductionQualification(
      { ...config, slurmVersion: "27.05.1" },
      report,
      config.releaseCommit,
    ),
  ).toThrow();
});

test("qualification binds the exact protected configuration set and content", () => {
  const qualified = { "/etc/eigengrid/site.json": "a".repeat(64) };
  expect(() => validateQualificationConfigurations(qualified, { ...qualified })).not.toThrow();
  expect(() => validateQualificationConfigurations(qualified, {})).toThrow();
  expect(() =>
    validateQualificationConfigurations(qualified, {
      ...qualified,
      "/etc/eigengrid/extra.json": "b".repeat(64),
    }),
  ).toThrow();
  expect(() =>
    validateQualificationConfigurations(qualified, { "/etc/eigengrid/site.json": "b".repeat(64) }),
  ).toThrow();
});
