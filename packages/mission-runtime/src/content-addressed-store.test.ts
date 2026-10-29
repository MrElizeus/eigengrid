import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmod,
  link,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import {
  ContentAddressedArtifactStore,
  ContentAddressedStoreError,
} from "./content-addressed-store";

const roots: string[] = [];
const stores: ContentAddressedArtifactStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function storeFixture(
  options: ConstructorParameters<typeof ContentAddressedArtifactStore>[1] = {},
): Promise<{ root: string; store: ContentAddressedArtifactStore }> {
  const parent = await mkdtemp(join(tmpdir(), "eigengrid-cas-test-"));
  roots.push(parent);
  const root = join(parent, "objects");
  const store = new ContentAddressedArtifactStore(root, options);
  await store.init();
  stores.push(store);
  return { root, store };
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function objectPath(root: string, contentDigest: string): string {
  return join(root, "sha256", contentDigest.slice(0, 2), contentDigest);
}

describe("ContentAddressedArtifactStore", () => {
  it("checks descriptor byte limits before hashing corrupted oversized objects", async () => {
    const { root, store } = await storeFixture({ maxBufferedReadBytes: 8 });
    const published = await store.put(Buffer.from("small"));
    expect((await store.verify(published.digest, { maxBytes: 5 })).sizeBytes).toBe(5);
    const streaming = await store.getStream(published.digest, { maxBytes: 5 });
    const chunks = [];
    for await (const bytes of streaming.bytes) chunks.push(Buffer.from(bytes));
    expect(Buffer.concat(chunks).toString()).toBe("small");
    const path = objectPath(root, published.digest);
    await chmod(path, 0o600);
    await writeFile(path, "larger corrupt bytes");
    // DIGEST_MISMATCH would mean we hashed bytes before enforcing the limit.
    for (const reading of [
      () => store.get(published.digest),
      () => store.getStream(published.digest, { maxBytes: 5 }),
      () => store.verify(published.digest, { maxBytes: 5 }),
      () => store.verifyByUri(published.uri, { maxBytes: 5 }),
    ])
      await expect(reading()).rejects.toMatchObject({ code: "OBJECT_TOO_LARGE" });
    await expect(store.verify(published.digest)).rejects.toMatchObject({ code: "DIGEST_MISMATCH" });
    await expect(store.verify(published.digest, { maxBytes: -1 })).rejects.toThrow(/limits/);
  });

  it("publishes only into a pre-provisioned group namespace, keeping staging private", async () => {
    const parent = await mkdtemp(join(tmpdir(), "eigengrid-cas-publication-"));
    roots.push(parent);
    const root = join(parent, "publication");
    const gid = process.getgid!();
    const publisher = new ContentAddressedArtifactStore(root, { publicationGroup: gid });
    stores.push(publisher);
    await expect(publisher.init()).rejects.toMatchObject({ code: "IO_ERROR" });
    await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(root, { mode: 0o700 });
    await expect(publisher.init()).rejects.toMatchObject({ code: "UNSAFE_OBJECT" });
    expect((await stat(root)).mode & 0o7777).toBe(0o700);
    execFileSync("/bin/chmod", ["2770", root]);
    await expect(publisher.init()).rejects.toMatchObject({ code: "UNSAFE_OBJECT" });
    const directories = [
      root,
      join(root, "sha256"),
      ...Array.from({ length: 256 }, (_, index) =>
        join(root, "sha256", index.toString(16).padStart(2, "0")),
      ),
    ];
    execFileSync("/usr/bin/install", ["-d", "-m", "2750", ...directories]);
    execFileSync("/usr/bin/install", ["-d", "-m", "2700", join(root, "sha256", ".staging")]);
    await publisher.init();
    const bytes = Buffer.from("explicitly published to one provisioned reader group");
    const stored = await publisher.put(bytes);
    for (const path of [
      root,
      join(root, "sha256"),
      join(root, "sha256", stored.digest.slice(0, 2)),
    ]) {
      const info = await stat(path);
      expect([info.uid, info.gid, info.mode & 0o7777]).toEqual([process.getuid!(), gid, 0o2750]);
    }
    expect((await stat(join(root, "sha256", ".staging"))).mode & 0o7777).toBe(0o2700);
    expect((await stat(objectPath(root, stored.digest))).mode & 0o777).toBe(0o444);
    expect(await readdir(join(root, "sha256", ".staging"))).toEqual([]);
    await publisher.close();
    await publisher.init();
    expect((await publisher.put(bytes)).existed).toBe(true);
    const reader = new ContentAddressedArtifactStore(root, { access: "read-only" });
    stores.push(reader);
    await reader.init();
    expect(Buffer.from((await reader.get(stored.digest)).bytes)).toEqual(bytes);
    // A replaced, wrongly provisioned shard is rejected before chmod/repair.
    await chmod(join(root, "sha256", stored.digest.slice(0, 2)), 0o700);
    await expect(publisher.get(stored.digest)).rejects.toMatchObject({ code: "UNSAFE_OBJECT" });
    for (const publicationGroup of [0, -1, 0.5, 4_294_967_295, Number.NaN]) {
      expect(() => new ContentAddressedArtifactStore(root, { publicationGroup })).toThrow();
    }
    expect(
      () => new ContentAddressedArtifactStore(root, { access: "read-only", publicationGroup: gid }),
    ).toThrow();
  });

  it("materializes, deduplicates, and verifies content by digest", async () => {
    const { store } = await storeFixture();
    const bytes = new TextEncoder().encode("immutable trajectory evidence");

    const first = await store.put(bytes);
    const second = await store.put(bytes);
    const observed = await store.getByUri(first.uri);

    expect(first.digest).toBe(digest(bytes));
    expect(first.existed).toBe(false);
    expect(second).toEqual({ ...first, existed: true });
    expect(observed.bytes).toEqual(bytes);
    expect(await store.has(first.digest)).toBe(true);
  });

  it("converges concurrent identical writes to one verified object", async () => {
    const { store } = await storeFixture();
    const bytes = new TextEncoder().encode("same bytes from concurrent collectors");

    const results = await Promise.all(Array.from({ length: 16 }, () => store.put(bytes)));

    expect(new Set(results.map((result) => result.digest))).toEqual(new Set([digest(bytes)]));
    expect((await store.get(results[0]!.digest)).bytes).toEqual(bytes);
  });

  it("opens a published namespace read-only without chmod, staging, or consuming write input", async () => {
    const { root, store } = await storeFixture();
    const bytes = Buffer.from("published for an authorized reader");
    const stored = await store.put(bytes);
    await store.close();
    await rm(join(root, "sha256", ".staging"), { recursive: true });
    const paths = [
      root,
      join(root, "sha256"),
      join(root, "sha256", stored.digest.slice(0, 2)),
      objectPath(root, stored.digest),
    ];
    for (const path of paths.slice(0, 3)) await chmod(path, 0o750);
    const before = await Promise.all(paths.map((path) => stat(path, { bigint: true })));
    const reader = new ContentAddressedArtifactStore(root, { access: "read-only" });
    stores.push(reader);
    await reader.init();
    expect(await reader.has(stored.digest)).toBe(true);
    expect((await reader.get(stored.digest)).bytes).toEqual(new Uint8Array(bytes));
    expect((await reader.verifyByUri(stored.uri)).sizeBytes).toBe(bytes.length);
    const stream = await reader.getStream(stored.digest);
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream.bytes) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(bytes);
    let consumed = false;
    await expect(
      reader.putStream(
        (async function* () {
          consumed = true;
          yield bytes;
        })(),
      ),
    ).rejects.toMatchObject({ code: "READ_ONLY" });
    expect(consumed).toBe(false);
    await expect(reader.put(bytes)).rejects.toMatchObject({ code: "READ_ONLY" });
    expect(await reader.has("0".repeat(64))).toBe(false);
    await reader.close();
    await reader.init();
    expect((await reader.get(stored.digest)).bytes).toEqual(new Uint8Array(bytes));
    const after = await Promise.all(paths.map((path) => stat(path, { bigint: true })));
    expect(
      after.map(({ ino, mode, ctimeNs, mtimeNs }) => ({ ino, mode, ctimeNs, mtimeNs })),
    ).toEqual(before.map(({ ino, mode, ctimeNs, mtimeNs }) => ({ ino, mode, ctimeNs, mtimeNs })));
    expect(await readdir(join(root, "sha256"))).toEqual([stored.digest.slice(0, 2)]);
  });

  it("read-only initialization never creates missing roots or namespaces", async () => {
    const parent = await mkdtemp(join(tmpdir(), "eigengrid-cas-reader-"));
    roots.push(parent);
    for (const createRoot of [false, true]) {
      const path = join(parent, createRoot ? "empty" : "absent");
      if (createRoot) await mkdir(path);
      const reader = new ContentAddressedArtifactStore(path, { access: "read-only" });
      stores.push(reader);
      await expect(reader.init()).rejects.toBeInstanceOf(ContentAddressedStoreError);
      await expect(reader.get("0".repeat(64))).rejects.toMatchObject({ code: "NOT_INITIALIZED" });
      if (createRoot) expect(await readdir(path)).toEqual([]);
      else await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(
      () => new ContentAddressedArtifactStore(parent, { access: "fallback" as "read-only" }),
    ).toThrow(/access mode/);
  });

  it("read-only readers preserve descriptor anchoring and reject corrupt or redirected publications", async () => {
    const { root, store } = await storeFixture();
    const bytes = Buffer.from("readonly descriptor-bound original");
    const stored = await store.put(bytes);
    const reader = new ContentAddressedArtifactStore(root, { access: "read-only" });
    stores.push(reader);
    await reader.init();
    const displaced = join(root, "sha256-bound");
    const outside = join(root, "outside");
    await rename(join(root, "sha256"), displaced);
    await mkdir(outside);
    await symlink(outside, join(root, "sha256"));
    expect((await reader.get(stored.digest)).bytes).toEqual(new Uint8Array(bytes));
    expect(await readdir(outside)).toEqual([]);
    const path = join(displaced, stored.digest.slice(0, 2), stored.digest);
    await chmod(path, 0o600);
    await writeFile(path, "corrupted");
    await expect(reader.get(stored.digest)).rejects.toMatchObject({ code: "DIGEST_MISMATCH" });
    await reader.close();
    await expect(reader.init()).rejects.toMatchObject({ code: "INVALID_ROOT" });
  });

  it("streams large artifacts without permitting an accidental buffered read", async () => {
    const { store } = await storeFixture({ maxBufferedReadBytes: 4 });
    const chunks = [new TextEncoder().encode("abc"), new TextEncoder().encode("def")];
    const stored = await store.putStream(
      (async function* () {
        for (const chunk of chunks) yield chunk;
      })(),
    );

    await expect(store.get(stored.digest)).rejects.toMatchObject({ code: "OBJECT_TOO_LARGE" });
    expect(await store.verifyByUri(stored.uri)).toEqual({
      digest: stored.digest,
      uri: stored.uri,
      sizeBytes: 6,
    });
    const opened = await store.getStream(stored.digest);
    const observed: number[] = [];
    for await (const chunk of opened.bytes) observed.push(...chunk);
    expect(Uint8Array.from(observed)).toEqual(new TextEncoder().encode("abcdef"));
    expect(opened.sizeBytes).toBe(6);

    await expect(
      store.putStream(
        (async function* () {
          for (const chunk of chunks) yield chunk;
        })(),
        { maxBytes: 5 },
      ),
    ).rejects.toMatchObject({ code: "OBJECT_TOO_LARGE" });
  });

  it("stays anchored to the initialized namespace when its visible path is replaced", async () => {
    const { root, store } = await storeFixture();
    const original = await store.put(new TextEncoder().encode("anchored original"));
    const visibleNamespace = join(root, "sha256");
    const boundNamespace = join(root, "sha256-bound");
    const outside = join(root, "outside");
    await rename(visibleNamespace, boundNamespace);
    await mkdir(outside);
    await symlink(outside, visibleNamespace);

    expect((await store.get(original.digest)).bytes).toEqual(
      new TextEncoder().encode("anchored original"),
    );
    const secondBytes = new TextEncoder().encode("anchored second");
    const second = await store.put(secondBytes);
    expect(await readFile(join(boundNamespace, second.digest.slice(0, 2), second.digest))).toEqual(
      Buffer.from(secondBytes),
    );
    expect(await readdir(outside)).toEqual([]);
  });

  it("rejects a replaced shard and never chmods a target behind its symlink", async () => {
    const { root, store } = await storeFixture();
    const bytes = new TextEncoder().encode("replacement target");
    const contentDigest = digest(bytes);
    const shard = join(root, "sha256", contentDigest.slice(0, 2));
    const displacedShard = `${shard}-bound`;
    const outside = join(root, "outside-shard");
    await mkdir(shard);
    await rename(shard, displacedShard);
    await mkdir(outside);
    const outsideObject = join(outside, contentDigest);
    await writeFile(outsideObject, bytes, { mode: 0o600 });
    await symlink(outside, shard);

    await expect(store.put(bytes)).rejects.toMatchObject({ code: "UNSAFE_OBJECT" });
    expect((await stat(outsideObject)).mode & 0o777).toBe(0o600);
    expect(await readFile(outsideObject)).toEqual(Buffer.from(bytes));
  });

  it("rejects non-canonical digests and URIs without resolving paths", async () => {
    const { store } = await storeFixture();

    for (const value of ["../secret", "A".repeat(64), "a".repeat(63)]) {
      expect(() => store.uriForDigest(value)).toThrow(ContentAddressedStoreError);
    }
    for (const uri of [
      `file:///tmp/${"a".repeat(64)}`,
      `cas://sha256/../${"a".repeat(64)}`,
      `cas://sha256/${"A".repeat(64)}`,
    ]) {
      expect(() => store.digestFromUri(uri)).toThrow(ContentAddressedStoreError);
    }
  });

  it("detects mutable bytes at a valid content address", async () => {
    const { root, store } = await storeFixture();
    const bytes = new TextEncoder().encode("original");
    const stored = await store.put(bytes);
    const path = objectPath(root, stored.digest);
    await chmod(path, 0o600);
    await writeFile(path, "tampered");

    await expect(store.get(stored.digest)).rejects.toMatchObject({ code: "DIGEST_MISMATCH" });
  });

  it("rejects symbolic links and multiply linked objects", async () => {
    const symlinkFixture = await storeFixture();
    const symlinkBytes = new TextEncoder().encode("symlink target");
    const symlinkDigest = digest(symlinkBytes);
    const symlinkObject = objectPath(symlinkFixture.root, symlinkDigest);
    await mkdir(join(symlinkFixture.root, "sha256", symlinkDigest.slice(0, 2)), {
      recursive: true,
    });
    const outside = join(symlinkFixture.root, "outside");
    await writeFile(outside, symlinkBytes);
    await symlink(outside, symlinkObject);
    await expect(symlinkFixture.store.get(symlinkDigest)).rejects.toMatchObject({
      code: "UNSAFE_OBJECT",
    });

    const hardlinkFixture = await storeFixture();
    const stored = await hardlinkFixture.store.put(new TextEncoder().encode("hardlink target"));
    await link(
      objectPath(hardlinkFixture.root, stored.digest),
      join(hardlinkFixture.root, "alias"),
    );
    await expect(hardlinkFixture.store.get(stored.digest)).rejects.toMatchObject({
      code: "UNSAFE_OBJECT",
    });
  });

  it("rejects relative roots and use before initialization", async () => {
    expect(() => new ContentAddressedArtifactStore("relative/store")).toThrow(
      ContentAddressedStoreError,
    );
    const parent = await mkdtemp(join(tmpdir(), "eigengrid-cas-uninitialized-"));
    roots.push(parent);
    const store = new ContentAddressedArtifactStore(join(parent, "objects"));
    await expect(store.get("a".repeat(64))).rejects.toMatchObject({ code: "NOT_INITIALIZED" });
  });

  it("rejects symlinked storage namespaces during initialization", async () => {
    const parent = await mkdtemp(join(tmpdir(), "eigengrid-cas-symlink-root-"));
    roots.push(parent);
    const root = join(parent, "objects");
    const outside = join(parent, "outside");
    await mkdir(root);
    await mkdir(outside);
    await symlink(outside, join(root, "sha256"));

    const store = new ContentAddressedArtifactStore(root);
    await expect(store.init()).rejects.toMatchObject({ code: "INVALID_ROOT" });
  });
});
