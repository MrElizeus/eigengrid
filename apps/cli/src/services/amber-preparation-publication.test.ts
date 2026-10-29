import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ContentAddressedArtifactStore,
  MdPreparationPublicationSchema,
  type MdPreparationPublication,
} from "@eigengrid/mission-runtime";
import { WorkUnitSchema, canonicalJson, digestCanonical } from "@eigengrid/scientific-schema";
import {
  AmberPreparationPublicationService,
  createHeadMdExecutionGateway,
} from "./amber-preparation-publication";
import { publishApprovedMdPreparation } from "./amber-md-preparation";
import { syntheticAmberBundleFixture } from "./amber-stage-bundle.fixture";
import { SYNTHETIC_PMEMD_CUDA_SHA256, syntheticGpuAmberSeed } from "./amber-gpu-test-fixture";
import { publishAmberStageBundle, readAmberStageBundle } from "./amber-stage-bundle";

const resources: { root: string; store: ContentAddressedArtifactStore }[] = [];
afterEach(async () => {
  for (const { root, store } of resources.splice(0)) {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
const at = "2026-09-22T12:00:00.000Z";
const policy = "f".repeat(64);

/** Component boundary tests use real CAS bytes/renderer and an explicitly
 * modeled DB authority. PostgreSQL publication/migration tests separately
 * establish that these authorization ports cannot be forged in production.
 */
async function fixture(snapshot = false, gpu = false) {
  const root = await mkdtemp(join(tmpdir(), "eigengrid-preparation-reader-"));
  const store = new ContentAddressedArtifactStore(root);
  resources.push({ root, store });
  await store.init();
  const { seed: cpuSeed } = await syntheticAmberBundleFixture(store);
  const seed = gpu ? await syntheticGpuAmberSeed(store) : cpuSeed;
  const source = {
    skillId: "amber.production-md",
    version: "1.0.0",
    contentDigest: "1".repeat(64),
    fragmentId: "fixture-md",
    fragmentDigest: "2".repeat(64),
    relativePath: "protocols/core.yaml",
    selector: "fixture",
  };
  const outputContract = {
    requiredEvidenceKinds: seed.request.outputs.bindings
      .filter((item) => item.required)
      .map((item) => item.canonicalRole),
    requiredObservationKinds: [],
  };
  // The immutable request must bind this exact WorkUnit output contract.
  seed.request.outputContractDigest = digestCanonical(outputContract);
  const workUnit = WorkUnitSchema.parse({
    id: seed.request.workUnitId,
    missionId: "mission-preparation",
    planId: seed.executionBinding.plan.id,
    planVersion: seed.executionBinding.plan.version,
    kind: "scientific_capability",
    state: "claimed",
    reason: "Preparation component test",
    dependencies: [],
    inputRefs: [],
    outputContract,
    skillRefs: [source],
    protocolFragment: {
      schemaVersion: "eigengrid.scientific-capability-fragment/v1",
      id: "fixture-md",
      kind: "scientific_capability",
      capability: {
        id: "amber.production-md",
        version: "1.0.0",
        contractDigest: "3".repeat(64),
      },
      reason: "Preparation component test",
      parameters: seed.executionBinding,
      sourceFragments: [source],
      riskClass: 3,
    },
    retryPolicy: { maximumAttempts: 1, ambiguityRequiresReconciliation: true },
    approvalPolicy: { required: true, minimumRole: "scientific_reviewer" },
    executionPolicy: { capability: "amber.production-md", riskClass: 3 },
    revision: 1,
    claimOwner: "head-preparation",
    claimExpiresAt: "2026-09-22T13:00:00.000Z",
    jobId: null,
    attemptId: null,
    createdAt: at,
    updatedAt: at,
  });
  const bundle = await publishAmberStageBundle(store, seed);
  const association = {
    schemaVersion: "eigengrid.scientific-mission-project/v1" as const,
    missionId: workUnit.missionId,
    ownerUserId: "scientist-preparation",
    projectId: "project-preparation",
    createdAt: at,
    associationDigest: "c".repeat(64),
  };
  const unsignedPublication = {
    schemaVersion: "eigengrid.md-preparation-publication/v1",
    workUnitId: workUnit.id,
    missionId: workUnit.missionId,
    ownerUserId: association.ownerUserId,
    projectId: association.projectId,
    bundle: bundle.reference,
    manifest: bundle.manifest,
    createdAt: at,
    associationDigest: "c".repeat(64),
    bindingDigest: digestCanonical(seed.executionBinding),
    requestDigest: digestCanonical(seed.request),
    mappingDigest: seed.mapping.mappingDigest,
    environmentBindingDigest: seed.request.environment.bindingDigest,
    inputEvidenceRefs: [],
  };
  let publication = MdPreparationPublicationSchema.parse({
    ...unsignedPublication,
    publicationDigest: digestCanonical(unsignedPublication),
  });
  let authority = {
    publicationRoot: root,
    grant: {
      principal: {
        subject: association.ownerUserId,
        projectId: association.projectId,
        uid: 2101,
        gid: 2101,
        siteProfileDigest: "a".repeat(64),
      },
      recoveryEpoch: "epoch-1",
      membershipGeneration: 1,
      currentPolicyDigest: policy,
    },
    endpointBinding: "b".repeat(64),
    environment: {
      amberVersion: seed.request.environment.engine.version,
      sanderSha256: seed.request.environment.binaryDigest,
      pmemdCudaSha256: gpu ? SYNTHETIC_PMEMD_CUDA_SHA256 : undefined,
      engineEnvironmentDigest: seed.request.environment.engineEnvironmentDigest,
    },
  };
  const calls = { resolve: 0, site: 0, authorize: 0, publish: 0 };
  let beforeResolve: (() => void) | undefined;
  let missingPublication = false;
  let beforeSite: (() => void) | undefined;
  let beforePublish: (() => void) | undefined;
  const publications = {
    async authorize() {
      calls.authorize++;
      return { workUnit, stage: seed.stage, association };
    },
    async resolve() {
      calls.resolve++;
      beforeResolve?.();
      return missingPublication ? null : structuredClone(publication);
    },
    async publish(input: { manifest: unknown; bundle: unknown }) {
      calls.publish++;
      beforePublish?.();
      expect(input.manifest).toEqual(bundle.manifest);
      expect(input.bundle).toEqual(bundle.reference);
      return { publication, created: true };
    },
  };
  const site = {
    resolvePublication(value: { subject: string; projectId: string }) {
      calls.site++;
      beforeSite?.();
      expect(value).toEqual({ subject: association.ownerUserId, projectId: association.projectId });
      return structuredClone(authority);
    },
  };
  let privateObjects: ContentAddressedArtifactStore | undefined;
  if (snapshot) {
    const privateRoot = await mkdtemp(join(tmpdir(), "eigengrid-private-md-"));
    privateObjects = new ContentAddressedArtifactStore(privateRoot);
    resources.push({ root: privateRoot, store: privateObjects });
    await privateObjects.init();
  }
  const service = new AmberPreparationPublicationService(
    // The in-memory port models authorization only; it is never exposed by
    // createHeadMdExecutionGateway or reachable from service configuration.
    publications,
    site,
    policy,
    () => new Date(at),
    privateObjects,
  );
  return {
    root,
    store,
    publications,
    site,
    seed,
    bundle,
    workUnit,
    calls,
    service,
    privateObjects,
    get publication() {
      return publication;
    },
    set publication(value: MdPreparationPublication) {
      publication = value;
    },
    get authority() {
      return authority;
    },
    onResolve: (hook: () => void) => {
      beforeResolve = hook;
    },
    removePublication: () => {
      missingPublication = true;
    },
    onSite: (hook: () => void) => {
      beforeSite = hook;
    },
    onPublish: (hook: () => void) => {
      beforePublish = hook;
    },
  };
}

describe("authorized durable Amber preparation composition", () => {
  test("retains a fully verified private snapshot for historical collection after publication disappears", async () => {
    const f = await fixture(true);
    const prepared = await f.service.prepareBundle(f.workUnit);
    await f.store.close();
    await rm(f.root, { recursive: true });
    const recovered = await readAmberStageBundle(
      f.privateObjects!,
      prepared.reference,
      prepared.manifest.request,
    );
    expect(recovered.manifest).toEqual(prepared.manifest);
    expect(recovered.rendered.commandRequest).toEqual(prepared.rendered.commandRequest);
    // Historical bytes survive; pre-effect authorization still cannot proceed
    // from that snapshot when the provisioned live source has disappeared.
    await expect(f.service.prepareBundle(f.workUnit)).rejects.toThrow();
  });
  test("resolves the durable locator and rehashes real CAS bytes with no publication writes", async () => {
    const f = await fixture();
    expect(await f.service.prepareBundle(f.workUnit)).toEqual(f.bundle);
    expect(f.calls).toEqual({ resolve: 2, site: 2, authorize: 0, publish: 0 });
    const concurrent = await Promise.all(
      Array.from({ length: 4 }, () => f.service.prepareBundle(f.workUnit)),
    );
    expect(concurrent.every((item) => canonicalJson(item) === canonicalJson(f.bundle))).toBe(true);
  });

  test("accepts only the exact provisioned pmemd.cuda digest during GPU preparation", async () => {
    const provisioned = await fixture(false, true);
    expect(provisioned.seed.request.environment.engine.executable).toBe("pmemd.cuda");
    expect(await provisioned.service.prepareBundle(provisioned.workUnit)).toEqual(
      provisioned.bundle,
    );
    expect(provisioned.calls.resolve).toBe(2);

    const absent = await fixture(false, true);
    absent.authority.environment.pmemdCudaSha256 = undefined;
    await expect(absent.service.prepareBundle(absent.workUnit)).rejects.toThrow(/engine tuple/);
    expect(absent.calls.resolve).toBe(1);

    const incorrect = await fixture(false, true);
    incorrect.authority.environment.pmemdCudaSha256 = "0".repeat(64);
    await expect(incorrect.service.prepareBundle(incorrect.workUnit)).rejects.toThrow(
      /engine tuple/,
    );
    expect(incorrect.calls.resolve).toBe(1);
  });

  test("registers only bytes verified against authorized projection and current site policy", async () => {
    const f = await fixture();
    expect(
      await f.service.registerPublished({
        workUnitId: f.workUnit.id,
        reference: f.bundle.reference,
        request: f.seed.request,
      }),
    ).toEqual({
      publication: f.publication,
      created: true,
    });
    expect(f.calls).toEqual({ resolve: 0, site: 3, authorize: 1, publish: 1 });
  });

  test("missing or cross-mission publication fails before opening any site namespace", async () => {
    const f = await fixture();
    f.onResolve(() => {
      throw new Error("publication is absent");
    });
    await expect(f.service.prepareBundle(f.workUnit)).rejects.toThrow(/absent/);
    expect(f.calls.site).toBe(0);
    f.onResolve(() => {});
    await expect(
      f.service.prepareBundle({ ...f.workUnit, missionId: "another-mission" }),
    ).rejects.toThrow(/another mission/);
    expect(f.calls.site).toBe(0);
    f.removePublication();
    await expect(f.service.prepareBundle(f.workUnit)).rejects.toThrow(/no durable/);
    expect(f.calls.site).toBe(0);
  });

  test("revocation during I/O prevents handing the bundle to admission", async () => {
    const f = await fixture();
    f.onResolve(() => {
      if (f.calls.resolve === 2) throw new Error("membership revoked");
    });
    await expect(f.service.prepareBundle(f.workUnit)).rejects.toThrow(/revoked/);
    expect(f.calls.publish).toBe(0);
  });

  test("changed durable preparation and protected configuration cannot reuse a verified snapshot", async () => {
    const f = await fixture();
    f.onResolve(() => {
      if (f.calls.resolve === 2)
        f.publication = {
          ...f.publication,
          bundle: { ...f.bundle.reference, sizeBytes: f.bundle.reference.sizeBytes + 1 },
        };
    });
    await expect(f.service.prepareBundle(f.workUnit)).rejects.toThrow(
      /Durable MD preparation changed/,
    );
    const g = await fixture();
    g.onSite(() => {
      if (g.calls.site === 2) g.authority.grant.membershipGeneration++;
    });
    await expect(g.service.prepareBundle(g.workUnit)).rejects.toThrow(/authority changed/);
  });

  test("engine and policy drift fail before consuming publication bytes", async () => {
    for (const field of ["amberVersion", "sanderSha256", "engineEnvironmentDigest"] as const) {
      const f = await fixture();
      f.authority.environment[field] = field === "amberVersion" ? "unexpected" : "0".repeat(64);
      await expect(f.service.prepareBundle(f.workUnit)).rejects.toThrow(/engine tuple/);
      expect(f.calls.resolve).toBe(1);
    }
    const f = await fixture();
    f.authority.grant.currentPolicyDigest = "0".repeat(64);
    await expect(f.service.prepareBundle(f.workUnit)).rejects.toThrow(/policy/);
  });

  test("corrupt actual input bytes cannot resolve or register an authoritative preparation", async () => {
    const f = await fixture();
    const input = f.bundle.manifest.inputs[0]!;
    const path = join(f.root, "sha256", input.sha256.slice(0, 2), input.sha256);
    await chmod(path, 0o600);
    await writeFile(path, Buffer.alloc(input.sizeBytes, 0x41));
    await expect(f.service.prepareBundle(f.workUnit)).rejects.toThrow();
    await expect(
      f.service.registerPublished({
        workUnitId: f.workUnit.id,
        reference: f.bundle.reference,
        request: f.seed.request,
      }),
    ).rejects.toThrow();
    expect(f.calls.publish).toBe(0);
  });

  test("oversized replacement is rejected before hashing beyond its approved size", async () => {
    const f = await fixture();
    const input = f.bundle.manifest.inputs[0]!;
    const path = join(f.root, "sha256", input.sha256.slice(0, 2), input.sha256);
    await chmod(path, 0o600);
    await writeFile(path, Buffer.alloc(input.sizeBytes + 1, 0x41));
    await expect(f.service.prepareBundle(f.workUnit)).rejects.toMatchObject({
      code: "OBJECT_TOO_LARGE",
    });
    expect(f.calls.publish).toBe(0);
  });

  test("registration revalidates authority transactionally after rehash and preserves rejection", async () => {
    const f = await fixture();
    f.onPublish(() => {
      throw new Error("exact approval revoked");
    });
    await expect(
      f.service.registerPublished({
        workUnitId: f.workUnit.id,
        reference: f.bundle.reference,
        request: f.seed.request,
      }),
    ).rejects.toThrow(/revoked/);
    expect(f.calls.authorize).toBe(1);
    expect(f.calls.publish).toBe(1);
  });

  test("production gateway refuses a SQLite fallback before reading configuration", () => {
    expect(() =>
      createHeadMdExecutionGateway({
        artifactRoot: "/unused-private-md-cas",
        database: {
          _provider: "sqlite",
          beginTransaction: async () => {
            throw new Error("unused");
          },
        },
        siteAuthorityConfigPath: "/not-opened",
        currentPolicyDigest: policy,
      }),
    ).toThrow(/PostgreSQL/);
  });
});

test("native preparation facade derives the approved stage, checks access and publishes exact bytes", async () => {
  const f = await fixture();
  const publicRoot = await mkdtemp(join(tmpdir(), "md-native-publication-"));
  const publicStore = new ContentAddressedArtifactStore(publicRoot);
  resources.push({ root: publicRoot, store: publicStore });
  await publicStore.init();
  f.authority.publicationRoot = publicRoot;
  // Provision only this test publication namespace, including pre-existing CAS shards.
  const root = f.site.resolvePublication({
    subject: f.publication.ownerUserId,
    projectId: f.publication.projectId,
  }).publicationRoot;
  execFileSync("chmod", ["2750", root]);
  execFileSync("chmod", ["2750", join(root, "sha256")]);
  execFileSync("chmod", ["2700", join(root, "sha256/.staging")]);
  for (let n = 0; n < 256; n++) {
    const shard = join(root, "sha256", n.toString(16).padStart(2, "0"));
    await mkdir(shard, { recursive: true });
    execFileSync("chmod", ["2750", shard]);
  }
  let accessCount = 0;
  const deps = {
    store: { getWorkUnit: async () => f.workUnit },
    mdStore: {
      getProtocol: async () => ({ stages: [f.seed.stage] }),
      getAtomMap: async () => f.seed.atomMap,
    },
    artifacts: f.store,
    publications: f.publications,
    siteAuthority: f.site,
    policyDigest: policy,
    assertAccess: async (address: unknown) => {
      expect(Object.keys(address as object).sort()).toEqual(["missionId", "projectId"]);
      accessCount++;
    },
  };
  const request = {
    projectId: f.publication.projectId,
    missionId: f.workUnit.missionId,
    workUnitId: f.workUnit.id,
    mapping: f.seed.mapping,
  };
  expect((await publishApprovedMdPreparation(request, deps)).publication.bundle).toEqual(
    f.bundle.reference,
  );
  expect(accessCount).toBe(2);
  expect(f.calls.authorize).toBe(2);
  const count = f.calls.publish;
  await expect(
    publishApprovedMdPreparation({ ...request, missionId: "other-mission" }, deps),
  ).rejects.toThrow("outside");
  await expect(
    publishApprovedMdPreparation(request, {
      ...deps,
      assertAccess: async () => {
        throw new Error("access revoked");
      },
    }),
  ).rejects.toThrow("revoked");
  await expect(
    publishApprovedMdPreparation(request, {
      ...deps,
      publications: {
        ...f.publications,
        authorize: async () => {
          throw new Error("approval revoked");
        },
      },
    }),
  ).rejects.toThrow("revoked");
  expect(f.calls.publish).toBe(count);
});
