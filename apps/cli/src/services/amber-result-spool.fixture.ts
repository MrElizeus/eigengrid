import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { ContentAddressedArtifactStore } from "@eigengrid/mission-runtime";
import { canonicalJson, digestCanonical } from "@eigengrid/scientific-schema";
import {
  createSlurmSubmissionBinding,
  slurmSubmissionJobName,
  slurmScriptDigest,
} from "@eigengrid/slurm";
import { syntheticAmberBundleFixture } from "./amber-stage-bundle.fixture";
import { publishAmberStageBundle } from "./amber-stage-bundle";
import {
  amberRunnerCapsuleDigest,
  buildAmberSlurmRunnerScript,
  computeAmberSlurmSiteProfileDigest,
  type AmberRunnerCapsule,
  type AmberSlurmSiteProfile,
} from "./amber-slurm-profile";
import type { AmberRunnerIO } from "./amber-slurm-runner";
import type { AmberResultPublicationSiteConfig } from "./amber-result-publication";
import type { AmberResultSpoolFileIO } from "./amber-result-spool-files";
import { createAmberResultSpoolForTest } from "./amber-result-spool";

/** Real local files, process, bytes and links. Root ownership and the second UID
 * are explicitly MODELED; this is not a two-UID/NFS/site security qualification.
 * The fake engine writes synthetic text, never scientific Amber evidence. */
export async function amberResultSpoolFixture(mode = "complete") {
  const root = await mkdtemp(join(tmpdir(), "eg-result-spool-"));
  const user = userInfo();
  const input = new ContentAddressedArtifactStore(join(root, "inputs"));
  await input.init();
  const { seed } = await syntheticAmberBundleFixture(input, {
    resourceProfile: {
      cpuCores: 1,
      memoryBytes: 128 * 1024 * 1024,
      scratchBytes: 16 * 1024 * 1024,
    },
  });
  const bundle = await publishAmberStageBundle(input, seed);
  const scratchRoot = join(root, "scratch");
  const amberHome = join(root, "fake-amber");
  await mkdir(scratchRoot, { mode: 0o700 });
  await mkdir(join(amberHome, "bin"), { recursive: true, mode: 0o700 });
  const engine = join(amberHome, "bin/sander");
  const launches = join(root, "launches");
  await writeFile(
    engine,
    `#!/usr/bin/python3 -I
import pathlib,sys
args=sys.argv[1:]
with pathlib.Path(${JSON.stringify(launches)}).open('a') as f: f.write('launch\\n')
for flag in ['-o','-r','-inf','-x']:
    if flag not in args or (${JSON.stringify(mode)} == 'missing' and flag == '-r'): continue
    pathlib.Path(args[args.index(flag)+1]).write_text('synthetic '+flag+'\\n')
sys.exit(42 if ${JSON.stringify(mode)} == 'exit42' else 0)
`,
    { mode: 0o700 },
  );
  const profile: AmberSlurmSiteProfile = {
    schemaVersion: "eigengrid.amber-slurm-site/v1",
    profilePath: join(root, "profile.json"),
    transport: {
      cluster: "fixture-cluster",
      slurmVersion: "23.11.4",
      uid: user.uid,
      username: user.username,
      home: user.homedir,
      submissionDirectory: join(user.homedir, ".eg-submit"),
      siteProfileDigest: "0".repeat(64),
      partition: "chem",
      node: hostname(),
      account: "fixture",
      cpuLimit: 2,
      memoryMiBLimit: 1024,
      walltimeLimitSeconds: 3600,
    },
    gid: user.gid,
    runnerExecutable: "/opt/eigengrid/runner",
    runnerSha256: "1".repeat(64),
    amberHome,
    sanderSha256: seed.request.environment.binaryDigest,
    amberVersion: seed.request.environment.engine.version,
    engineEnvironmentDigest: seed.request.environment.engineEnvironmentDigest,
    scratchRoot,
    resultPublicationConfigPath: join(root, "result-site.json"),
    projects: [
      { subject: "fixture-user", projectId: "project-1", publicationRoot: join(root, "inputs") },
    ],
  };
  profile.transport.siteProfileDigest = computeAmberSlurmSiteProfileDigest(profile);
  const capsule: AmberRunnerCapsule = {
    schemaVersion: "eigengrid.amber-runner-capsule/v1",
    operationId: "operation-1",
    admissionDigest: "2".repeat(64),
    fencingGeneration: 1,
    uid: user.uid,
    gid: user.gid,
    subject: "fixture-user",
    projectId: "project-1",
    siteProfileDigest: profile.transport.siteProfileDigest,
    request: seed.request,
    bundle: bundle.reference,
  };
  const binding = createSlurmSubmissionBinding({
    operationId: capsule.operationId,
    requestDigest: digestCanonical(capsule.request),
    admissionDigest: capsule.admissionDigest,
    scriptDigest: slurmScriptDigest(buildAmberSlurmRunnerScript(capsule, profile)),
    siteProfileDigest: capsule.siteProfileDigest,
    cluster: profile.transport.cluster,
    uid: capsule.uid,
    notBefore: "2026-09-20T10:00:00.000Z",
    expiresAt: "2026-09-20T10:01:00.000Z",
    resources: {
      partition: "chem",
      node: hostname(),
      account: "fixture",
      cpus: 1,
      memoryMiB: 128,
      walltimeSeconds: bundle.manifest.stage.resourceProfile.wallTimeSeconds,
    },
  });
  const config: AmberResultPublicationSiteConfig = {
    schemaVersion: "eigengrid.amber-result-publication-site/v1",
    configPath: profile.resultPublicationConfigPath!,
    siteProfilePath: profile.profilePath,
    siteProfileDigest: capsule.siteProfileDigest,
    resultSpoolRoot: join(root, "results"),
    writer: { uid: user.uid, gid: user.gid },
    collector: { uid: user.uid + 1, gid: user.gid + 1 },
    publicationGroupId: user.gid + 40,
    projects: [{ subject: capsule.subject, projectId: capsule.projectId }],
    limits: {
      maxManifestBytes: 1024 * 1024,
      maxObjectBytes: 8 * 1024 * 1024,
      maxTotalBytes: 32 * 1024 * 1024,
      maxObjectCount: 19,
      maxFileCount: 21,
      maxPathBytes: 4096,
    },
  };
  await mkdir(config.resultSpoolRoot, { mode: 0o750 });
  const uidRoot = join(config.resultSpoolRoot, String(capsule.uid));
  await mkdir(uidRoot, { mode: 0o750 });
  const project = join(uidRoot, capsule.projectId);
  await mkdir(project, { mode: 0o2750 });
  if (Bun.spawnSync(["/usr/bin/chmod", "2750", project]).exitCode !== 0)
    throw new Error("Fixture provisioning chmod failed");
  async function writeConfig() {
    await writeFile(config.configPath, canonicalJson(config), { mode: 0o600 });
    await writeFile(profile.profilePath, canonicalJson(profile), { mode: 0o600 });
  }
  await writeConfig();
  let actor = config.writer;
  const io: AmberResultSpoolFileIO = {
    uid: () => actor.uid,
    gid: () => actor.gid,
    groups: () => [config.publicationGroupId],
    async stat(file, path) {
      const actual = await file.stat();
      // Only identities are modeled; actual modes/links/sizes/timestamps remain
      // kernel observations. /tmp's sticky writable ancestry models /srv.
      if (path === "/tmp") actual.mode = (actual.mode & ~0o7777) | 0o755;
      if (!path.startsWith(project)) actual.uid = 0;
      if (path === config.resultSpoolRoot || path.startsWith(config.resultSpoolRoot + "/"))
        actual.gid = config.publicationGroupId;
      return actual;
    },
    async chown() {
      /* root/group membership modeled, no privileged host mutation */
    },
  };
  const factory = (path: string) => createAmberResultSpoolForTest(path, io);
  const runnerIO: AmberRunnerIO = {
    host: () => ({
      uid: user.uid,
      gid: user.gid,
      node: hostname(),
      cluster: profile.transport.cluster,
      jobId: "43",
      jobName: slurmSubmissionJobName(binding),
      cpus: 1,
      memoryMiB: 128,
      ordinaryBatch: true,
    }),
    async verifyBinary() {},
    async verifyLibraryTree() {},
    async checkDisk() {},
    resultSpool: factory,
  };
  const workspace = join(scratchRoot, amberRunnerCapsuleDigest(capsule));
  const publicationRoot = join(project, capsule.operationId, amberRunnerCapsuleDigest(capsule));
  return {
    root,
    input,
    profile,
    capsule,
    bundle,
    binding,
    config,
    io,
    runnerIO,
    factory,
    workspace,
    project,
    publicationRoot,
    engine,
    launches,
    writeConfig,
    writer() {
      actor = config.writer;
    },
    collector() {
      actor = config.collector;
    },
    async observation() {
      return JSON.parse(
        await readFile(join(workspace, ".eigengrid/result-observation.json"), "utf8"),
      );
    },
    async source() {
      const source = new ContentAddressedArtifactStore(join(workspace, ".eigengrid/objects"), {
        access: "read-only",
      });
      await source.init();
      return source;
    },
    async close() {
      await input.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
