import { lstatSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { DigestSchema } from "@eigengrid/scientific-schema";
import { sacctContractForVersion } from "@eigengrid/slurm";
import {
  HeadMdSiteAuthorityConfigSchema,
  readProtectedHeadJson,
  createHeadMdSiteAuthorityReader,
} from "./head-md-site-authority";
import { createHeadMdPostprocessingAuthority } from "./head-md-postprocessing-authority";
import {
  SubmitterServiceConfigSchema,
  SubmitterSitePolicySchema,
} from "./submitter-site-authority";
import { AmberSlurmSiteProfileSchema, assertAmberSlurmSiteProfile } from "./amber-slurm-profile";

const path = z
  .string()
  .refine((value) => isAbsolute(value) && resolve(value) === value && value !== "/");

/** Explicit site admission, bound to a particular installed release and policy.
 * It enables only the existing exact-approval MD gateway, never legacy runners.
 */
export const ProductionDispatchConfigSchema = z
  .object({
    schemaVersion: z.literal("eigengrid.production-dispatch/v1"),
    releaseCommit: z.string().regex(/^[a-f0-9]{40}$/u),
    policyDigest: DigestSchema,
    slurmVersion: z.string(),
    mdSiteAuthority: path,
    mdArtifactRoot: path,
    mdPostprocessing: path,
    qualificationReport: path,
    qualificationSha256: DigestSchema,
  })
  .strict();

export const ProductionQualificationSchema = z
  .object({
    schemaVersion: z.literal("eigengrid.production-qualification/v1"),
    releaseCommit: z.string().regex(/^[a-f0-9]{40}$/u),
    slurmVersion: z.string(),
    checks: z
      .object({
        submission: z.literal(true),
        accounting: z.literal(true),
        resultCollection: z.literal(true),
        restartRecovery: z.literal(true),
        cancellation: z.literal(true),
      })
      .strict(),
  })
  .strict();

export function validateProductionQualification(
  config: z.infer<typeof ProductionDispatchConfigSchema>,
  report: unknown,
  releaseCommit: string | undefined,
): void {
  const qualification = ProductionQualificationSchema.parse(report);
  sacctContractForVersion(config.slurmVersion);
  if (
    !releaseCommit ||
    config.releaseCommit !== releaseCommit ||
    qualification.releaseCommit !== releaseCommit ||
    qualification.slurmVersion !== config.slurmVersion
  )
    throw new Error(
      "Production qualification does not match the installed release and Slurm version",
    );
}

export async function loadProductionDispatchConfig(
  configPath: string,
  releaseCommit: string | undefined,
) {
  const { createHash } = await import("node:crypto");
  const { canonicalJson } = await import("@eigengrid/scientific-schema");
  const config = readProtectedHeadJson(configPath, ProductionDispatchConfigSchema);
  const report = readProtectedHeadJson(config.qualificationReport, ProductionQualificationSchema);
  validateProductionQualification(config, report, releaseCommit);
  if (
    createHash("sha256").update(canonicalJson(report)).digest("hex") !== config.qualificationSha256
  )
    throw new Error("Production qualification digest mismatch");
  const authority = readProtectedHeadJson(config.mdSiteAuthority, HeadMdSiteAuthorityConfigSchema);
  if (authority.configPath !== config.mdSiteAuthority || authority.headUid !== process.getuid?.())
    throw new Error("Production Head identity differs from its protected MD authority");
  const root = lstatSync(config.mdArtifactRoot);
  if (
    !root.isDirectory() ||
    root.isSymbolicLink() ||
    root.uid !== authority.headUid ||
    (root.mode & 0o077) !== 0
  )
    throw new Error("Production MD artifacts require a private Head-owned directory");
  createHeadMdPostprocessingAuthority(config.mdPostprocessing, config.policyDigest).resolve();
  const liveAuthority = createHeadMdSiteAuthorityReader(config.mdSiteAuthority);
  let members = 0;
  for (const servicePath of authority.submitterConfigPaths) {
    const service = readProtectedHeadJson(servicePath, SubmitterServiceConfigSchema);
    const policy = readProtectedHeadJson(service.policyPath, SubmitterSitePolicySchema);
    const profile = assertAmberSlurmSiteProfile(
      readProtectedHeadJson(service.siteProfilePath, AmberSlurmSiteProfileSchema),
    );
    if (
      service.configPath !== servicePath ||
      service.headUid !== authority.headUid ||
      policy.headUid !== authority.headUid ||
      policy.uid !== service.uid ||
      policy.gid !== service.gid ||
      profile.transport.uid !== service.uid ||
      profile.gid !== service.gid ||
      profile.transport.slurmVersion !== config.slurmVersion ||
      policy.currentPolicyDigest !== config.policyDigest ||
      policy.siteProfileDigest !== profile.transport.siteProfileDigest ||
      !profile.resultPublicationConfigPath
    )
      throw new Error("Production submitter identity, scheduler or policy mismatch");
    for (const member of policy.memberships) {
      if (
        !profile.projects.some(
          (p) => p.subject === member.subject && p.projectId === member.projectId,
        )
      )
        throw new Error("Production membership has no publication project");
      liveAuthority.resolveCurrentGrant({ subject: member.subject, projectId: member.projectId });
      liveAuthority.resolveResultPublication({
        subject: member.subject,
        projectId: member.projectId,
      });
      members++;
    }
  }
  if (members === 0) throw new Error("Production dispatch has no admitted project memberships");
  return config;
}
