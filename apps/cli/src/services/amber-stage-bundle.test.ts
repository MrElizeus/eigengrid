import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  link,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContentAddressedArtifactStore } from "@eigengrid/mission-runtime";
import { canonicalJson, computeMdStageSpecDigest } from "@eigengrid/scientific-schema";
import {
  computeAmberCanonicalStageMappingDigest,
  computeCanonicalMdExecutionBindingDigest,
  createAmberMdStageOperationRequest,
  renderCanonicalAmberStage,
} from "@eigengrid/amber-adapter";
import { digest } from "../../../../packages/amber-adapter/src/canonical-stage.fixture";
import { syntheticAmberBundleFixture } from "./amber-stage-bundle.fixture";
import { syntheticGpuAmberSeed } from "./amber-gpu-test-fixture";
import {
  AMBER_BUNDLE_LIMITS,
  copyAmberStageBundle,
  publishAmberStageBundle,
  readAmberStageBundle,
  type AmberBundleReference,
  type AmberStageBundle,
} from "./amber-stage-bundle";

const stores: { root: string; store: ContentAddressedArtifactStore }[] = [];
afterEach(async () => {
  for (const { root, store } of stores.splice(0)) {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
async function newStore() {
  const root = await mkdtemp(join(tmpdir(), "eg-amber-bundle-"));
  const store = new ContentAddressedArtifactStore(root);
  stores.push({ root, store });
  await store.init();
  return { root, store };
}
function objectPath(root: string, sha256: string) {
  return join(root, "sha256", sha256.slice(0, 2), sha256);
}
async function putJson(store: ContentAddressedArtifactStore, value: unknown) {
  return putRaw(store, Buffer.from(canonicalJson(value)));
}
async function putRaw(store: ContentAddressedArtifactStore, bytes: Uint8Array) {
  const stored = await store.put(bytes);
  return { sha256: stored.digest, sizeBytes: stored.sizeBytes };
}

async function fixture(options: Parameters<typeof syntheticAmberBundleFixture>[1] = {}) {
  const { root, store } = await newStore();
  return { root, store, ...(await syntheticAmberBundleFixture(store, options)) };
}

function rebindRequest(seed: Awaited<ReturnType<typeof fixture>>["seed"]) {
  seed.mapping.canonicalWorkUnit.bindingDigest = computeCanonicalMdExecutionBindingDigest(
    seed.executionBinding,
  );
  seed.mapping.mappingDigest = computeAmberCanonicalStageMappingDigest(seed.mapping);
  const rendered = renderCanonicalAmberStage(
    seed.stage,
    seed.mapping,
    seed.executionBinding,
    seed.atomMap,
  );
  seed.request = createAmberMdStageOperationRequest(rendered, seed.mapping.environment, {
    workUnitId: seed.request.workUnitId,
    bindingDigest: seed.mapping.canonicalWorkUnit.bindingDigest,
    outputContractDigest: seed.request.outputContractDigest,
  });
  return seed;
}

describe("verified canonical Amber stage bundles (not scientific QC)", () => {
  test("publishes deterministic bundles and regenerates mdin from exact canonical inputs", async () => {
    const { store, seed } = await fixture();
    const bundles = await Promise.all(
      Array.from({ length: 8 }, () => publishAmberStageBundle(store, seed)),
    );
    const bundle = bundles[0]!;
    for (const other of bundles) expect(other).toEqual(bundle);
    expect(bundle.manifest.inputs.map((input) => input.role)).toEqual([
      "topology.prmtop",
      "coordinates.input",
      "stage.mdin",
    ]);
    const mdin = bundle.manifest.inputs[2]!;
    expect(Buffer.from((await store.get(mdin.sha256)).bytes).toString()).toBe(
      bundle.rendered.renderedMdin.content,
    );
    expect(bundle.rendered.commandRequest.executable).toBe("sander");
    expect(bundle.rendered.commandRequest.shell).toBe(false);
    expect(await readAmberStageBundle(store, bundle.reference, seed.request)).toEqual(bundle);
  });

  test("publishes the synthetic pmemd.cuda bundle only with one admitted GPU", async () => {
    const { store } = await newStore();
    const seed = await syntheticGpuAmberSeed(store);
    const bundle = await publishAmberStageBundle(store, seed);
    expect(bundle.rendered.commandRequest.executable).toBe("pmemd.cuda");
    expect(bundle.manifest.stage.resourceProfile.gpuCount).toBe(1);
    expect(await readAmberStageBundle(store, bundle.reference, seed.request)).toEqual(bundle);

    const noGpu = structuredClone(seed);
    noGpu.stage.resourceProfile.gpuCount = 0;
    noGpu.stage.stageDigest = computeMdStageSpecDigest(noGpu.stage);
    await expect(publishAmberStageBundle(store, noGpu)).rejects.toThrow();
  });

  test("rejects a self-hashed render/command and a different admitted request", async () => {
    const { store, seed } = await fixture();
    for (const addition of [
      { script: "exit 0" },
      { argv: ["/bin/sh"] },
      { renderedStage: {} },
      { env: { LD_PRELOAD: "bad" } },
    ]) {
      await expect(publishAmberStageBundle(store, { ...seed, ...addition })).rejects.toThrow();
    }
    await expect(
      publishAmberStageBundle(store, {
        ...seed,
        request: {
          ...seed.request,
          render: { ...seed.request.render, commandRequestDigest: digest("0") },
        },
      }),
    ).rejects.toThrow(/exact verified render/);
    const bundle = await publishAmberStageBundle(store, seed);
    await expect(
      readAmberStageBundle(store, bundle.reference, { ...seed.request, workUnitId: "other-work" }),
    ).rejects.toThrow(/exact admitted request/);
  });

  test("rejects path traversal and file/directory collisions even when individually valid paths were bound in the render", async () => {
    const { store, seed } = await fixture();
    for (const cwd of [
      "../outside",
      "/tmp/outside",
      "inputs/system.prmtop",
      "inputs/system.prmtop/work",
    ]) {
      const changed = structuredClone(seed);
      changed.mapping.artifactPaths.cwd = cwd;
      if (cwd.startsWith("inputs/")) rebindRequest(changed);
      await expect(publishAmberStageBundle(store, changed)).rejects.toThrow();
    }
    const changed = structuredClone(seed);
    changed.mapping.artifactPaths.outputs.find((output) => output.role === "mdout")!.logicalPath =
      "inputs/system.prmtop/file.mdout";
    rebindRequest(changed);
    await expect(publishAmberStageBundle(store, changed)).rejects.toThrow(/path collision/);
  });

  test("binds continuation inputs and separate segment seeds to distinct immutable requests", async () => {
    const { store, seed } = await fixture({ continuation: true });
    const first = await publishAmberStageBundle(store, seed);
    expect(first.manifest.inputs[1]!.sha256).toBe(
      seed.executionBinding.parentRestart!.contentDigest,
    );
    expect(first.manifest.inputs[1]!.sha256).not.toBe(seed.stage.system.coordinateDigest);
    expect(first.rendered.renderedMdin.content).toContain("irest=1,");
    expect(first.rendered.renderedMdin.content).toContain("ig=771001,");
    const next = structuredClone(seed);
    next.request.workUnitId = "work-unit-segment-2";
    next.executionBinding.replicaSegment!.segmentIndex = 1;
    next.executionBinding.replicaSegment!.segmentSeed = 771002;
    rebindRequest(next);
    const second = await publishAmberStageBundle(store, next);
    expect(second.reference.sha256).not.toBe(first.reference.sha256);
    expect(second.manifest.atomMap).toEqual(first.manifest.atomMap);
    expect(second.rendered.renderedMdin.content).toContain("ig=771002,");
    await expect(
      readAmberStageBundle(store, second.reference, first.manifest.request),
    ).rejects.toThrow(/exact admitted request/);
    const changed = structuredClone(next);
    changed.executionBinding.parentRestart!.contentDigest = digest("0");
    await expect(publishAmberStageBundle(store, changed)).rejects.toThrow(
      /binding digest mismatch/,
    );
  });

  test("rejects inventory substitution, forged sizes and mutated scientific bindings even with a new valid CAS hash", async () => {
    const { store, seed } = await fixture();
    const bundle = await publishAmberStageBundle(store, seed);
    const mutations: ((manifest: AmberStageBundle) => void)[] = [
      (m) => {
        m.inputs.reverse();
      },
      (m) => {
        m.inputs[0]!.sha256 = m.inputs[1]!.sha256;
      },
      (m) => {
        m.inputs[0]!.logicalPath = "other/system.prmtop";
      },
      (m) => {
        m.inputs[0]!.role = "coordinates.reference";
      },
      (m) => {
        m.inputs[0]!.sizeBytes += 1;
      },
      (m) => {
        m.inputs[2]!.sizeBytes += 1;
      },
      (m) => {
        m.inputs[0]!.sizeBytes = 0;
      },
      (m) => {
        m.inputs[0]!.sizeBytes = AMBER_BUNDLE_LIMITS.inputBytes + 1;
      },
      (m) => {
        m.atomMap.sizeBytes += 1;
      },
      (m) => {
        m.stage.steps += 1;
        m.stage.stageDigest = computeMdStageSpecDigest(m.stage);
      },
      (m) => {
        m.executionBinding.system.approvalRef = "different-approval";
      },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(bundle.manifest);
      mutate(changed);
      const ref = await putJson(store, changed);
      await expect(readAmberStageBundle(store, ref, seed.request)).rejects.toThrow();
    }
  });

  test("rejects noncanonical JSON, duplicate keys and invalid UTF-8, including atom-map metadata", async () => {
    const { store, seed } = await fixture();
    const bundle = await publishAmberStageBundle(store, seed);
    const canonical = canonicalJson(bundle.manifest);
    const invalid = [
      Buffer.from(JSON.stringify(bundle.manifest, null, 2)),
      Buffer.from(`{"schemaVersion":"discarded",${canonical.slice(1)}`),
      Buffer.concat([Buffer.from(canonical.slice(0, -1)), Buffer.from([0xff]), Buffer.from("}")]),
      Buffer.from(canonicalJson({ ...bundle.manifest, script: "false" })),
    ];
    for (const bytes of invalid) {
      const ref = await putRaw(store, bytes);
      await expect(readAmberStageBundle(store, ref, seed.request)).rejects.toThrow();
    }
    const atomMap = await putRaw(store, Buffer.from(JSON.stringify(seed.atomMap, null, 2)));
    const ref = await putJson(store, { ...bundle.manifest, atomMap });
    await expect(readAmberStageBundle(store, ref, seed.request)).rejects.toThrow(
      /atom map is not canonical/,
    );
  });

  test("rehashes consumed streams and closes them after metadata or byte tampering", async () => {
    const { store, seed } = await fixture();
    const bundle = await publishAmberStageBundle(store, seed);
    for (const corruptMetadata of [false, true]) {
      let closed = false;
      const reader = {
        verify: store.verify.bind(store),
        getStream: async (hash: string) => {
          const real = await store.getStream(hash);
          return {
            ...real,
            sizeBytes: real.sizeBytes + (corruptMetadata ? 1 : 0),
            bytes: (async function* () {
              try {
                for await (const chunk of real.bytes) {
                  if (!corruptMetadata) chunk[0] = chunk[0]! ^ 1;
                  yield chunk;
                }
              } finally {
                closed = true;
              }
            })(),
          };
        },
      };
      await expect(readAmberStageBundle(reader, bundle.reference, seed.request)).rejects.toThrow(
        /metadata|hash\/size/,
      );
      expect(closed).toBe(true);
    }
  });

  test("detects actual CAS corruption, symlink escape and hardlink aliases", async () => {
    for (const mutation of ["corrupt", "symlink", "hardlink"]) {
      const { root, store, seed, topology } = await fixture();
      const bundle = await publishAmberStageBundle(store, seed);
      const path = objectPath(root, topology.digest);
      if (mutation === "corrupt") {
        await chmod(path, 0o600);
        await writeFile(path, Buffer.alloc(topology.sizeBytes, 0x41));
      } else if (mutation === "hardlink") {
        await link(path, join(root, "extra-alias"));
      } else {
        const external = join(root, "external-input");
        await writeFile(external, await readFile(path));
        await unlink(path);
        await symlink(external, path);
      }
      await expect(readAmberStageBundle(store, bundle.reference, seed.request)).rejects.toThrow();
    }
  });

  test("copies all referenced objects and publishes the manifest last; interrupted copy resumes by hash", async () => {
    const { store, seed } = await fixture();
    const bundle = await publishAmberStageBundle(store, seed);
    const target = await newStore();
    let copies = 0;
    const failingTarget = {
      verify: target.store.verify.bind(target.store),
      getStream: target.store.getStream.bind(target.store),
      put: target.store.put.bind(target.store),
      putStream: async (...args: Parameters<ContentAddressedArtifactStore["putStream"]>) => {
        if (++copies === 3) {
          return target.store.putStream(
            (async function* () {
              for await (const chunk of args[0]) {
                yield chunk;
                throw new Error("injected collection/staging interruption");
              }
            })(),
            args[1],
          );
        }
        return target.store.putStream(...args);
      },
    };
    await expect(
      copyAmberStageBundle(store, failingTarget, bundle.reference, seed.request),
    ).rejects.toThrow();
    expect(await target.store.has(bundle.reference.sha256)).toBe(false);
    expect(await target.store.has(bundle.manifest.inputs[1]!.sha256)).toBe(false);
    expect(await readdir(join(target.root, "sha256", ".staging"))).toEqual([]);
    const existingPath = objectPath(target.root, bundle.manifest.atomMap.sha256);
    const inode = (await stat(existingPath)).ino;
    expect(await copyAmberStageBundle(store, target.store, bundle.reference, seed.request)).toEqual(
      bundle,
    );
    expect((await stat(existingPath)).ino).toBe(inode);
    expect(await copyAmberStageBundle(store, target.store, bundle.reference, seed.request)).toEqual(
      bundle,
    );
    expect(await readdir(join(target.root, "sha256", ".staging"))).toEqual([]);
  });

  test("corrupted receiving objects are errors, never silently overwritten as a successful replay", async () => {
    const { store, seed } = await fixture();
    const bundle = await publishAmberStageBundle(store, seed);
    const target = await newStore();
    await copyAmberStageBundle(store, target.store, bundle.reference, seed.request);
    const path = objectPath(target.root, bundle.manifest.inputs[0]!.sha256);
    await chmod(path, 0o600);
    await writeFile(path, "partial");
    await expect(
      copyAmberStageBundle(store, target.store, bundle.reference, seed.request),
    ).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("partial");
  });

  test("verifies and copies through the non-mutating published-CAS reader", async () => {
    const { root, store, seed } = await fixture();
    const bundle = await publishAmberStageBundle(store, seed);
    const reader = new ContentAddressedArtifactStore(root, { access: "read-only" });
    const target = await newStore();
    try {
      await reader.init();
      expect(await readAmberStageBundle(reader, bundle.reference, seed.request)).toEqual(bundle);
      expect(
        await copyAmberStageBundle(reader, target.store, bundle.reference, seed.request),
      ).toEqual(bundle);
      await expect(
        copyAmberStageBundle(target.store, reader, bundle.reference, seed.request),
      ).rejects.toMatchObject({ code: "READ_ONLY" });
      expect(await readAmberStageBundle(reader, bundle.reference, seed.request)).toEqual(bundle);
    } finally {
      await reader.close();
    }
  });

  test("keeps large complete atom maps outside the small transport manifest", async () => {
    const { store, seed } = await fixture({ atomCount: 5000 });
    const bundle = await publishAmberStageBundle(store, seed);
    expect(bundle.manifest.atomMap.sizeBytes).toBeGreaterThan(512 * 1024);
    expect(bundle.reference.sizeBytes).toBeLessThan(512 * 1024);
    expect(bundle.rendered.runtimeBindings.atomMapView.atomCount).toBe(5000);
    const target = await newStore();
    expect(await copyAmberStageBundle(store, target.store, bundle.reference, seed.request)).toEqual(
      bundle,
    );
  });

  test("fails closed before oversized metadata IO and on insufficient staging allowance", async () => {
    const { store, seed } = await fixture({ largeInput: true });
    await expect(publishAmberStageBundle(store, seed)).rejects.toThrow(/staging\/scratch/);
    let reads = 0;
    const reader = {
      verify: store.verify.bind(store),
      getStream: async (hash: string) => {
        reads += 1;
        return store.getStream(hash);
      },
    };
    const ref: AmberBundleReference = {
      sha256: digest("0"),
      sizeBytes: AMBER_BUNDLE_LIMITS.manifestBytes + 1,
    };
    await expect(readAmberStageBundle(reader, ref, seed.request)).rejects.toThrow();
    expect(reads).toBe(0);
  });
});
