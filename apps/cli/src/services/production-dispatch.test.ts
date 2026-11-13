import { expect, test } from "bun:test";
import {
  ProductionDispatchConfigSchema,
  validateProductionQualification,
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
  schemaVersion: "eigengrid.production-qualification/v1",
  releaseCommit: config.releaseCommit,
  slurmVersion: config.slurmVersion,
  checks: {
    submission: true,
    accounting: true,
    resultCollection: true,
    restartRecovery: true,
    cancellation: true,
  },
};
test("production admission requires this exact release, scheduler and every completed qualification check", () => {
  expect(() => validateProductionQualification(config, report, config.releaseCommit)).not.toThrow();
  for (const altered of [
    { ...report, releaseCommit: "d".repeat(40) },
    { ...report, slurmVersion: "23.11.4" },
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
