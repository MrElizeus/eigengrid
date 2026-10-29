import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { ContentAddressedArtifactStore } from "@eigengrid/mission-runtime";
import { canonicalJson, digestBytes, digestCanonical } from "@eigengrid/scientific-schema";
import { createSlurmSubmissionBinding } from "@eigengrid/slurm";
import { syntheticAmberBundleFixture } from "./amber-stage-bundle.fixture";
import {
  amberRunnerCapsuleDigest,
  computeAmberSlurmSiteProfileDigest,
  type AmberRunnerCapsule,
  type AmberSlurmSiteProfile,
} from "./amber-slurm-profile";
import {
  AMBER_RESULT_PUBLICATION_TRUST_LIMITATION,
  AmberResultPublicationManifestSchema,
  assertAmberResultPublicationManifest,
  createAmberResultPublication,
  type AmberResultPublicationInput,
  type AmberResultPublicationSiteConfig,
} from "./amber-result-publication";
import type { AmberWorkerReceipt } from "./amber-slurm-runner";

const D = (character: string) => character.repeat(64);
const cleanup: string[] = [];
afterEach(async () => {
  for (const root of cleanup.splice(0).reverse()) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "eg-amber-result-publication-"));
  cleanup.push(root);
  const store = new ContentAddressedArtifactStore(root);
  await store.init();
  const { seed } = await syntheticAmberBundleFixture(store, {
    resourceProfile: { cpuCores: 1, memoryBytes: 128 * 1024 * 1024 },
  });
  await store.close();
  const user = userInfo();
  const profile: AmberSlurmSiteProfile = {
    schemaVersion: "eigengrid.amber-slurm-site/v1",
    profilePath: "/etc/eigengrid/amber-fixture.json",
    transport: {
      cluster: "fixture-cluster",
      slurmVersion: "23.11.4",
      uid: user.uid,
      username: user.username,
      home: user.homedir,
      submissionDirectory: join(user.homedir, ".eg-submit"),
      siteProfileDigest: D("0"),
      partition: "chem",
      node: "worker-01",
      account: "fixture-account",
      cpuLimit: 2,
      memoryMiBLimit: 1024,
      walltimeLimitSeconds: 3600,
    },
    gid: user.gid,
    runnerExecutable: "/opt/eigengrid/amber-runner",
    runnerSha256: D("1"),
    amberHome: "/opt/ambertools-26",
    sanderSha256: seed.request.environment.binaryDigest,
    amberVersion: seed.request.environment.engine.version,
    engineEnvironmentDigest: seed.request.environment.engineEnvironmentDigest,
    scratchRoot: "/scratch/eigengrid",
    projects: [
      {
        subject: "fixture-user",
        projectId: "project-1",
        publicationRoot: "/srv/eigengrid/inputs/fixture-user/project-1",
      },
    ],
  };
  profile.transport.siteProfileDigest = computeAmberSlurmSiteProfileDigest(profile);
  const capsule: AmberRunnerCapsule = {
    schemaVersion: "eigengrid.amber-runner-capsule/v1",
    operationId: "operation-1",
    admissionDigest: D("2"),
    fencingGeneration: 1,
    uid: user.uid,
    gid: user.gid,
    subject: "fixture-user",
    projectId: "project-1",
    siteProfileDigest: profile.transport.siteProfileDigest,
    request: seed.request,
    bundle: { sha256: D("f"), sizeBytes: 32 },
  };
  const binding = createSlurmSubmissionBinding({
    operationId: capsule.operationId,
    requestDigest: digestCanonical(capsule.request),
    admissionDigest: capsule.admissionDigest,
    scriptDigest: D("3"),
    siteProfileDigest: capsule.siteProfileDigest,
    cluster: profile.transport.cluster,
    uid: capsule.uid,
    notBefore: "2026-09-20T10:00:00.000Z",
    expiresAt: "2026-09-20T10:01:00.000Z",
    resources: {
      partition: profile.transport.partition,
      node: profile.transport.node,
      account: profile.transport.account,
      cpus: 1,
      memoryMiB: 128,
      walltimeSeconds: 60,
    },
  });
  const receipt: AmberWorkerReceipt = {
    schemaVersion: "eigengrid.amber-worker-receipt/v1",
    capsuleDigest: amberRunnerCapsuleDigest(capsule),
    requestDigest: digestCanonical(capsule.request),
    operationId: capsule.operationId,
    admissionDigest: capsule.admissionDigest,
    uid: capsule.uid,
    gid: capsule.gid,
    node: profile.transport.node,
    cluster: profile.transport.cluster,
    jobId: "42",
    engine: {
      schema: "eigengrid.engine-exit/v1",
      commandDigest: D("4"),
      claimDigest: D("5"),
      startedAtNs: "1",
      finishedAtNs: "2",
      exitCode: 0,
      signal: null,
      supervisorSignals: [],
      executionError: null,
    },
    supervision: null,
    engineClaim: { sha256: D("5"), sizeBytes: 128 },
    engineReceipt: { sha256: D("6"), sizeBytes: 256 },
    inputsIntact: true,
    artifactStatus: "complete",
    outputs: capsule.request.outputs.bindings.map((output, index) => ({
      role: output.engineRole,
      logicalPath: `outputs/${output.engineRole}-${index}.out`,
      mediaType: output.mediaType,
      status: "present" as const,
      object: { sha256: D((7 + index).toString(16)), sizeBytes: 512 + index },
    })),
    qcStatus: "not_evaluated",
    scientificVerdict: "not_evaluated",
  };
  const collectorUid = user.uid === 4_294_967_294 ? user.uid - 1 : user.uid + 1;
  const siteConfig: AmberResultPublicationSiteConfig = {
    schemaVersion: "eigengrid.amber-result-publication-site/v1",
    configPath: "/etc/eigengrid/amber-result-publication.json",
    siteProfilePath: profile.profilePath,
    siteProfileDigest: profile.transport.siteProfileDigest,
    resultSpoolRoot: "/srv/eigengrid/results",
    writer: { uid: capsule.uid, gid: capsule.gid },
    collector: { uid: collectorUid, gid: capsule.gid },
    publicationGroupId: capsule.gid + 40,
    projects: [{ subject: capsule.subject, projectId: capsule.projectId }],
    limits: {
      maxManifestBytes: 1024 * 1024,
      maxObjectBytes: 256 * 1024,
      maxTotalBytes: 4 * 1024 * 1024,
      maxObjectCount: 19,
      maxFileCount: 21,
      maxPathBytes: 4096,
    },
  };
  const receiptBytes = Buffer.from(canonicalJson(receipt), "utf8");
  const input: AmberResultPublicationInput = {
    siteConfig,
    siteProfile: profile,
    capsule,
    binding,
    receipt,
    receiptReference: { sha256: digestBytes(receiptBytes), sizeBytes: receiptBytes.length },
    transfer: {
      schemaVersion: "eigengrid.amber-result-transfer/v1",
      transferId: "02c7d5b1-2f89-4dca-9f6f-cd8d7aa0ac1e",
      observedAt: "2026-09-20T10:02:00.000Z",
    },
  };
  return { input, profile, capsule, receipt, binding, siteConfig };
}

describe("Amber result return-publication contract", () => {
  test("creates one closed manifest, logical spool layout, and final marker", async () => {
    const fixtureValue = await fixture();
    const publication = createAmberResultPublication(fixtureValue.input);

    expect(publication.manifest.operationId).toBe(fixtureValue.capsule.operationId);
    expect(publication.manifest.capsuleDigest).toBe(amberRunnerCapsuleDigest(fixtureValue.capsule));
    expect(publication.manifest.objects).toHaveLength(fixtureValue.receipt.outputs.length + 3);
    expect(publication.paths.publicationRoot).toBe(
      `/srv/eigengrid/results/${fixtureValue.capsule.uid}/project-1/operation-1/${amberRunnerCapsuleDigest(fixtureValue.capsule)}`,
    );
    expect(publication.paths.incomingDirectory).toEndWith(
      "/incoming/02c7d5b1-2f89-4dca-9f6f-cd8d7aa0ac1e",
    );
    expect(publication.paths.objectPath(D("5"))).toEndWith(`/objects/${D("5")}`);
    expect(publication.paths.receiptPath).toEndWith("/receipt.json");
    expect(publication.paths.finalMarkerPath).toEndWith("/publication.json");
    expect(publication.marker.logicalPath).toBe("publication.json");
    expect(publication.marker.sizeBytes).toBe(Buffer.byteLength(publication.marker.body));
    expect(
      assertAmberResultPublicationManifest(publication.manifest, fixtureValue.input).manifest,
    ).toEqual(publication.manifest);
    expect(AMBER_RESULT_PUBLICATION_TRUST_LIMITATION).toContain("do not authenticate");
  });

  test("rejects a receipt or binding from another UID, operation, or capsule", async () => {
    const fixtureValue = await fixture();
    const { input, capsule, receipt, binding, siteConfig } = fixtureValue;
    for (const changed of [
      { ...input, receipt: { ...receipt, uid: receipt.uid + 1 } },
      { ...input, capsule: { ...capsule, operationId: "operation-other" } },
      { ...input, receipt: { ...receipt, capsuleDigest: D("e") } },
      { ...input, binding: { ...binding, operationId: "operation-other" } },
      {
        ...input,
        siteConfig: { ...siteConfig, writer: { uid: capsule.uid + 1, gid: capsule.gid } },
      },
    ])
      expect(() => createAmberResultPublication(changed)).toThrow();
  });

  test("rejects duplicates, partial manifests, and path/link injection", async () => {
    const fixtureValue = await fixture();
    const publication = createAmberResultPublication(fixtureValue.input);
    const firstOutput = publication.manifest.objects.find((object) => object.kind === "output")!;

    expect(
      AmberResultPublicationManifestSchema.safeParse({
        ...publication.manifest,
        objects: [...publication.manifest.objects, firstOutput],
      }).success,
    ).toBe(false);
    expect(
      AmberResultPublicationManifestSchema.safeParse({
        ...publication.manifest,
        objects: publication.manifest.objects.filter((object) => object.kind !== "engine_receipt"),
      }).success,
    ).toBe(false);
    expect(
      AmberResultPublicationManifestSchema.safeParse({
        ...publication.manifest,
        objects: publication.manifest.objects.map((object) =>
          object === firstOutput ? { ...object, logicalPath: "../../outside" } : object,
        ),
      }).success,
    ).toBe(false);
    expect(
      AmberResultPublicationManifestSchema.safeParse({
        ...publication.manifest,
        objects: [
          { ...publication.manifest.objects[0]!, linkTarget: "../../outside" },
          ...publication.manifest.objects.slice(1),
        ],
      }).success,
    ).toBe(false);
    expect(() =>
      createAmberResultPublication({
        ...fixtureValue.input,
        siteConfig: {
          ...fixtureValue.siteConfig,
          resultSpoolRoot: "/srv/eigengrid/results/../inputs",
        },
      }),
    ).toThrow();
  });
});
