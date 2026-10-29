import { describe, expect, test } from "bun:test";
import {
  AmberSlurmSiteProfileSchema,
  amberEnginePath,
  assertAmberSlurmEngineResources,
  computeAmberSlurmSiteProfileDigest,
  type AmberSlurmSiteProfile,
} from "./amber-slurm-profile";

const D = (value: string) => value.repeat(64);

function profile(pmemdCudaSha256?: string): AmberSlurmSiteProfile {
  return {
    schemaVersion: "eigengrid.amber-slurm-site/v1",
    profilePath: "/etc/eigengrid/amber.json",
    transport: {
      cluster: "cluster",
      slurmVersion: "23.11.4",
      uid: 1000,
      username: "scientific",
      home: "/home/scientific",
      submissionDirectory: "/home/scientific/.eg-submit",
      siteProfileDigest: D("0"),
      partition: "chem",
      node: "node1",
      account: "chemistry",
      cpuLimit: 4,
      memoryMiBLimit: 2048,
      walltimeLimitSeconds: 3600,
      ...(pmemdCudaSha256 ? { gpuType: "rtx_5090", gpuLimit: 1 as const } : {}),
    },
    gid: 1000,
    runnerExecutable: "/opt/eigengrid/runner",
    runnerSha256: D("1"),
    amberHome: "/opt/amber",
    sanderSha256: D("2"),
    ...(pmemdCudaSha256 ? { pmemdCudaSha256, gpuLibraryTreeSha256: D("b") } : {}),
    amberVersion: "24",
    engineEnvironmentDigest: D("3"),
    scratchRoot: "/scratch/eigengrid",
    projects: [
      { subject: "user", projectId: "project", publicationRoot: "/srv/eigengrid/project" },
    ],
  };
}

describe("Amber Slurm engine profile", () => {
  test("keeps the existing sander CPU identity and admits only the provisioned pmemd.cuda GPU pair", () => {
    const site = profile(D("4"));
    expect(amberEnginePath(site, "sander")).toBe("/opt/amber/bin/sander");
    expect(amberEnginePath(site, "pmemd.cuda")).toBe("/opt/amber/bin/pmemd.cuda");
    expect(() => assertAmberSlurmEngineResources(site, "sander", D("2"), 0)).not.toThrow();
    expect(() => assertAmberSlurmEngineResources(site, "pmemd.cuda", D("4"), 1)).not.toThrow();
    expect(() => assertAmberSlurmEngineResources(site, "pmemd.cuda", D("5"), 1)).toThrow();
    expect(() => assertAmberSlurmEngineResources(site, "pmemd.cuda", D("4"), 0)).toThrow();
    expect(() => assertAmberSlurmEngineResources(site, "sander", D("2"), 1)).toThrow();
    expect(() => amberEnginePath(site, "pmemd")).toThrow();
  });

  test("remains CPU-only when the root-owned GPU digest is absent", () => {
    const site = profile();
    expect(() => amberEnginePath(site, "pmemd.cuda")).toThrow();
    expect(() => assertAmberSlurmEngineResources(site, "sander", D("2"), 0)).not.toThrow();
  });

  test("binds the GPU library contents into the site profile identity", () => {
    const site = profile(D("4"));
    const first = computeAmberSlurmSiteProfileDigest(site);
    expect(computeAmberSlurmSiteProfileDigest({ ...site, gpuLibraryTreeSha256: D("c") })).not.toBe(
      first,
    );
    expect(() =>
      AmberSlurmSiteProfileSchema.parse({ ...site, gpuLibraryTreeSha256: undefined }),
    ).toThrow();
  });
});
