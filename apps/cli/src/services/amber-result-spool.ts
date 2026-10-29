import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, mkdir, open, readdir, unlink, type FileHandle } from "node:fs/promises";
import { ContentAddressedArtifactStore } from "@eigengrid/mission-runtime";
import { DigestSchema, canonicalJson, digestBytes } from "@eigengrid/scientific-schema";
import type { SlurmSubmissionBinding } from "@eigengrid/slurm";
import {
  AmberResultPublicationManifestSchema,
  AmberResultPublicationReferenceSchema,
  AmberResultPublicationSiteConfigSchema,
  assertAmberResultPublicationManifest,
  createAmberWorkerResultPublication,
  type AmberResultPublicationReference,
  type AmberResultPublicationSiteConfig,
  type AmberResultPublicationTransfer,
} from "./amber-result-publication";
import {
  amberRunnerCapsuleDigest,
  assertAmberRunnerCapsule,
  assertAmberSlurmSiteProfile,
  type AmberRunnerCapsule,
} from "./amber-slurm-profile";
import { AmberWorkerReceiptSchema, verifyAmberWorkerReceipt } from "./amber-slurm-runner";
import { readAmberStageBundle } from "./amber-stage-bundle";
import { descriptorPath, stableAmberFile } from "./amber-runner-files";
import {
  amberResultSpoolFileIO,
  boundedBytes,
  directoryFlags,
  errno,
  fileFlags,
  parseCanonical,
  protectedDirectory,
  protectedJson,
  sameFile,
  type AmberResultSpoolFileIO,
} from "./amber-result-spool-files";

export interface AmberResultSpoolPublishInput {
  capsule: unknown;
  /** An observation, never Head submission authority. */
  observedBindingDigest: unknown;
  receiptReference: AmberResultPublicationReference;
  source: Pick<ContentAddressedArtifactStore, "getStream" | "get" | "verify">;
  transfer: AmberResultPublicationTransfer;
}
export interface AmberResultSpoolOpenInput {
  capsule: unknown;
  binding: SlurmSubmissionBinding;
  expectedJobId: string;
}
interface AnchoredDirectory {
  file: FileHandle;
  path: string;
}
interface OpenedObject {
  file: FileHandle;
  parent: AnchoredDirectory;
  name: string;
  reference: AmberResultPublicationReference;
  snapshot: Stats;
}

function assertDirectory(
  stat: Stats,
  config: AmberResultPublicationSiteConfig,
  owner: number,
  mode: number,
): void {
  if (
    !stat.isDirectory() ||
    stat.uid !== owner ||
    stat.gid !== config.publicationGroupId ||
    (stat.mode & 0o7777) !== mode
  )
    throw new Error("Amber result spool directory ownership/mode mismatch");
}
function assertObject(
  stat: Stats,
  config: AmberResultPublicationSiteConfig,
  reference?: AmberResultPublicationReference,
  links = 1,
): void {
  if (
    !stat.isFile() ||
    stat.nlink !== links ||
    stat.uid !== config.writer.uid ||
    stat.gid !== config.publicationGroupId ||
    (stat.mode & 0o7777) !== 0o440 ||
    (reference !== undefined && stat.size !== reference.sizeBytes)
  )
    throw new Error("Amber result object ownership, mode, link count or size mismatch");
}
function refBytes(bytes: Buffer): AmberResultPublicationReference {
  return { sha256: digestBytes(bytes), sizeBytes: bytes.length };
}
async function* checkedBytes(
  file: FileHandle,
  reference: AmberResultPublicationReference,
): AsyncGenerator<Buffer> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of stableAmberFile(file, reference.sizeBytes)) {
    size += chunk.length;
    hash.update(chunk);
    yield Buffer.from(chunk);
  }
  if (size !== reference.sizeBytes || hash.digest("hex") !== reference.sha256)
    throw new Error("Amber result bytes differ from the declared digest/size");
}
async function verifyBytes(
  file: FileHandle,
  reference: AmberResultPublicationReference,
): Promise<void> {
  for await (const _chunk of checkedBytes(file, reference)) {
    /* verify without buffering */
  }
}

async function loadSpool(configPath: string, io: AmberResultSpoolFileIO) {
  const siteConfig = AmberResultPublicationSiteConfigSchema.parse(
    await protectedJson(configPath, io),
  );
  if (siteConfig.configPath !== configPath)
    throw new Error("Amber result configuration path mismatch");
  const siteProfile = assertAmberSlurmSiteProfile(
    await protectedJson(siteConfig.siteProfilePath, io),
  );
  if (
    siteProfile.profilePath !== siteConfig.siteProfilePath ||
    siteProfile.transport.siteProfileDigest !== siteConfig.siteProfileDigest ||
    siteProfile.resultPublicationConfigPath !== configPath
  )
    throw new Error("Amber result configuration/profile identity mismatch");

  function principal(writer: boolean) {
    const expected = writer ? siteConfig.writer : siteConfig.collector;
    if (
      io.uid() !== expected.uid ||
      io.gid() !== expected.gid ||
      ![io.gid(), ...io.groups()].includes(siteConfig.publicationGroupId)
    )
      throw new Error("Amber result spool access is outside its provisioned principal/group");
  }
  async function child(
    parent: AnchoredDirectory,
    name: string,
    create: boolean,
    mode = 0o750,
  ): Promise<AnchoredDirectory> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(name)) throw new Error("Invalid spool component");
    const path = `${parent.path}/${name}`;
    const anchored = `${descriptorPath(parent.file)}/${name}`;
    let created = false;
    if (create) {
      try {
        await mkdir(anchored, { mode });
        created = true;
      } catch (error) {
        if (!errno(error, "EEXIST")) throw error;
      }
    }
    const file = await open(anchored, directoryFlags);
    try {
      if (created) {
        await io.chown(file, siteConfig.writer.uid, siteConfig.publicationGroupId);
        await file.chmod(mode);
        await file.sync();
        await parent.file.sync();
      }
      assertDirectory(await io.stat(file, path), siteConfig, siteConfig.writer.uid, mode);
      return { file, path };
    } catch (error) {
      await file.close();
      throw error;
    }
  }
  async function publicationDirectories(capsule: AmberRunnerCapsule, create: boolean) {
    const handles: AnchoredDirectory[] = [];
    try {
      // The writer can create operation descendants only, never the UID/project authorization boundary.
      const root = {
        file: await protectedDirectory(siteConfig.resultSpoolRoot, io),
        path: siteConfig.resultSpoolRoot,
      };
      handles.push(root);
      assertDirectory(await io.stat(root.file, root.path), siteConfig, 0, 0o750);
      const uidPath = `${root.path}/${capsule.uid}`;
      const uidDir = {
        file: await open(`${descriptorPath(root.file)}/${capsule.uid}`, directoryFlags),
        path: uidPath,
      };
      handles.push(uidDir);
      assertDirectory(await io.stat(uidDir.file, uidDir.path), siteConfig, 0, 0o750);
      const project = await child(uidDir, capsule.projectId, false, 0o2750);
      handles.push(project);
      const operation = await child(project, capsule.operationId, create);
      handles.push(operation);
      const publication = await child(operation, amberRunnerCapsuleDigest(capsule), create);
      handles.push(publication);
      const objects = await child(publication, "objects", create);
      handles.push(objects);
      return { handles, publication, objects };
    } catch (error) {
      await Promise.all(handles.map(({ file }) => file.close()));
      throw error;
    }
  }
  async function openObject(
    parent: AnchoredDirectory,
    name: string,
    reference?: AmberResultPublicationReference,
    links = 1,
  ): Promise<OpenedObject> {
    const path = `${parent.path}/${name}`;
    const file = await open(`${descriptorPath(parent.file)}/${name}`, fileFlags);
    try {
      const snapshot = await io.stat(file, path);
      assertObject(snapshot, siteConfig, reference, links);
      if (!reference) {
        const bytes = await boundedBytes(file, siteConfig.limits.maxManifestBytes);
        reference = refBytes(bytes);
      }
      return { file, parent, name, reference, snapshot };
    } catch (error) {
      await file.close();
      throw error;
    }
  }
  async function revalidateObject(object: OpenedObject) {
    const stat = await io.stat(object.file, `${object.parent.path}/${object.name}`);
    assertObject(stat, siteConfig, object.reference);
    if (!sameFile(object.snapshot, stat))
      throw new Error("Amber result object changed during collection");
    const current = await openObject(object.parent, object.name, object.reference);
    try {
      if (!sameFile(stat, current.snapshot))
        throw new Error("Amber result object path changed during collection");
    } finally {
      await current.file.close();
    }
  }

  async function publish(input: AmberResultSpoolPublishInput) {
    principal(true);
    const capsule = assertAmberRunnerCapsule(input.capsule, siteProfile);
    const reference = AmberResultPublicationReferenceSchema.parse(input.receiptReference);
    if (reference.sizeBytes > siteConfig.limits.maxObjectBytes)
      throw new Error("Amber receipt exceeds object limit");
    const receiptChunks: Buffer[] = [];
    let receiptSize = 0;
    for await (const chunk of (
      await input.source.getStream(reference.sha256, { maxBytes: reference.sizeBytes })
    ).bytes) {
      receiptSize += chunk.length;
      if (receiptSize > reference.sizeBytes)
        throw new Error("Amber receipt stream exceeds byte limit");
      receiptChunks.push(Buffer.from(chunk));
    }
    const receiptBytes = Buffer.concat(receiptChunks);
    if (canonicalJson(refBytes(receiptBytes)) !== canonicalJson(reference))
      throw new Error("Amber source receipt mismatch");
    const receipt = AmberWorkerReceiptSchema.parse(parseCanonical(receiptBytes));
    const resolved = createAmberWorkerResultPublication({
      ...input,
      siteConfig,
      siteProfile,
      receipt,
    });
    const bundle = await readAmberStageBundle(input.source, capsule.bundle, capsule.request);
    await verifyAmberWorkerReceipt(input.source, receipt, capsule, siteProfile, bundle);
    const dirs = await publicationDirectories(capsule, true);
    let incoming: AnchoredDirectory | undefined;
    let transfer: AnchoredDirectory | undefined;
    try {
      incoming = await child(dirs.publication, "incoming", true, 0o700);
      transfer = await child(incoming, resolved.manifest.transfer.transferId, true, 0o700);
      const references = new Map(
        resolved.manifest.objects.flatMap((item) =>
          item.object ? [[item.object.sha256, item.object] as const] : [],
        ),
      );
      const allowed = new Set([...references.keys(), "receipt.json", "publication.json"]);
      const staged = await readdir(descriptorPath(transfer.file));
      if (staged.some((name) => !allowed.has(name)))
        throw new Error("Unexpected incoming result file");
      // Deterministic staging names are scoped to one frozen transfer. Only its
      // own verified link window (same inode + hash) may be recovered.
      async function install(
        parent: AnchoredDirectory,
        name: string,
        ref: AmberResultPublicationReference,
        stream: () => Promise<AsyncIterable<Uint8Array>>,
      ) {
        const finalPath = `${descriptorPath(parent.file)}/${name}`;
        const tempPath = `${descriptorPath(transfer!.file)}/${name}`;
        let final: OpenedObject | undefined;
        try {
          final = await openObject(parent, name, ref);
        } catch (error) {
          if (!errno(error, "ENOENT")) {
            // A crash between link and unlink leaves exactly two links. Recover
            // only this transfer's exact verified staging inode.
            const existing = await openObject(parent, name, ref, 2);
            let pending: OpenedObject | undefined;
            try {
              pending = await openObject(transfer!, name, ref, 2);
              if (
                existing.snapshot.dev !== pending.snapshot.dev ||
                existing.snapshot.ino !== pending.snapshot.ino
              )
                throw new Error("Amber result staging link does not belong to this transfer");
              await verifyBytes(existing.file, ref);
              await unlink(tempPath);
              await transfer!.file.sync();
              await parent.file.sync();
            } finally {
              await existing.file.close();
              await pending?.file.close();
            }
            final = await openObject(parent, name, ref);
          }
        }
        if (final) {
          try {
            await verifyBytes(final.file, ref);
          } finally {
            await final.file.close();
          }
          return;
        }
        let pending: FileHandle | undefined;
        try {
          try {
            pending = await open(
              tempPath,
              constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
              0o600,
            );
          } catch (error) {
            if (!errno(error, "EEXIST")) throw error;
            // An interrupted, never-published file may be discarded only from
            // this frozen transfer, with no aliases and a bounded byte count.
            const stale = await open(tempPath, fileFlags);
            try {
              const stat = await io.stat(stale, `${transfer!.path}/${name}`);
              if (
                !stat.isFile() ||
                stat.nlink !== 1 ||
                stat.uid !== siteConfig.writer.uid ||
                stat.gid !== siteConfig.publicationGroupId ||
                stat.size > ref.sizeBytes ||
                ![0o600, 0o440].includes(stat.mode & 0o7777)
              )
                throw new Error("Unsafe interrupted result staging file");
              await unlink(tempPath);
              await transfer!.file.sync();
            } finally {
              await stale.close();
            }
            pending = await open(
              tempPath,
              constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
              0o600,
            );
          }
          await io.chown(pending, siteConfig.writer.uid, siteConfig.publicationGroupId);
          const hash = createHash("sha256");
          let size = 0;
          for await (const chunk of await stream()) {
            size += chunk.length;
            if (size > ref.sizeBytes) throw new Error("Result stream exceeds its declared size");
            hash.update(chunk);
            let offset = 0;
            while (offset < chunk.length) {
              const { bytesWritten } = await pending.write(chunk, offset, chunk.length - offset);
              if (!bytesWritten) throw new Error("Result spool short write");
              offset += bytesWritten;
            }
          }
          if (size !== ref.sizeBytes || hash.digest("hex") !== ref.sha256)
            throw new Error("Result stream digest/size mismatch");
          await pending.chmod(0o440);
          await pending.sync();
          await transfer!.file.sync();
          await link(tempPath, finalPath);
          await parent.file.sync();
          await unlink(tempPath);
          await transfer!.file.sync();
          await parent.file.sync();
          const verified = await openObject(parent, name, ref);
          try {
            await verifyBytes(verified.file, ref);
          } finally {
            await verified.file.close();
          }
        } finally {
          await pending?.close();
        }
      }
      // An existing marker must be this exact transfer, including observedAt.
      // Never append objects into a different completed publication.
      try {
        const file = await open(
          `${descriptorPath(dirs.publication.file)}/publication.json`,
          fileFlags,
        );
        try {
          const stat = await io.stat(file, `${dirs.publication.path}/publication.json`);
          assertObject(stat, siteConfig, resolved.marker, stat.nlink === 2 ? 2 : 1);
          await verifyBytes(file, resolved.marker);
          if (stat.nlink === 2) {
            const pending = await openObject(transfer, "publication.json", resolved.marker, 2);
            try {
              if (stat.dev !== pending.snapshot.dev || stat.ino !== pending.snapshot.ino)
                throw new Error("Final marker belongs to a different transfer");
            } finally {
              await pending.file.close();
            }
          }
        } finally {
          await file.close();
        }
      } catch (error) {
        if (!errno(error, "ENOENT")) throw error;
      }
      for (const [digest, ref] of references)
        await install(
          dirs.objects,
          digest,
          ref,
          async () => (await input.source.getStream(digest, { maxBytes: ref.sizeBytes })).bytes,
        );
      const one = (bytes: Buffer) =>
        async function* () {
          yield bytes;
        };
      await install(dirs.publication, "receipt.json", reference, async () => one(receiptBytes)());
      await install(dirs.publication, "publication.json", resolved.marker, async () =>
        one(Buffer.from(resolved.marker.body))(),
      );
      return {
        manifest: resolved.manifest,
        reference: { sha256: resolved.marker.sha256, sizeBytes: resolved.marker.sizeBytes },
        canonicalAcknowledged: false as const,
      };
    } finally {
      await transfer?.file.close();
      await incoming?.file.close();
      await Promise.all(dirs.handles.map(({ file }) => file.close()));
    }
  }

  async function openVerifiedPublication(input: AmberResultSpoolOpenInput) {
    principal(false);
    const capsule = assertAmberRunnerCapsule(input.capsule, siteProfile);
    // Validate authorization tuple before traversing any writer path.
    if (
      siteConfig.writer.uid !== capsule.uid ||
      siteConfig.writer.gid !== capsule.gid ||
      !siteConfig.projects.some(
        (p) => p.subject === capsule.subject && p.projectId === capsule.projectId,
      )
    )
      throw new Error("Amber result project is not provisioned");
    const dirs = await publicationDirectories(capsule, false);
    const opened: OpenedObject[] = [];
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await Promise.all([
        ...opened.map((o) => o.file.close()),
        ...dirs.handles.map((d) => d.file.close()),
      ]);
    };
    try {
      const marker = await openObject(dirs.publication, "publication.json");
      opened.push(marker);
      const manifest = AmberResultPublicationManifestSchema.parse(
        parseCanonical(await boundedBytes(marker.file, siteConfig.limits.maxManifestBytes)),
      );
      if (manifest.jobId !== input.expectedJobId)
        throw new Error("Amber result job differs from scheduler-correlated job");
      const receiptObject = await openObject(dirs.publication, "receipt.json", manifest.receipt);
      opened.push(receiptObject);
      const receiptBytes = await boundedBytes(
        receiptObject.file,
        Math.min(siteConfig.limits.maxObjectBytes, 1024 * 1024),
      );
      const receipt = AmberWorkerReceiptSchema.parse(parseCanonical(receiptBytes));
      const resolved = assertAmberResultPublicationManifest(manifest, {
        siteConfig,
        siteProfile,
        capsule,
        binding: input.binding,
        receipt,
        receiptReference: manifest.receipt,
        transfer: manifest.transfer,
      });
      if (
        canonicalJson(marker.reference) !==
        canonicalJson({ sha256: resolved.marker.sha256, sizeBytes: resolved.marker.sizeBytes })
      )
        throw new Error("Amber result marker identity mismatch");
      await verifyBytes(receiptObject.file, manifest.receipt);
      const objects = new Map<string, OpenedObject>();
      for (const item of manifest.objects) {
        if (!item.object || objects.has(item.object.sha256)) continue;
        const object = await openObject(dirs.objects, item.object.sha256, item.object);
        opened.push(object);
        objects.set(item.object.sha256, object);
      }
      async function revalidate() {
        if (closed) throw new Error("Amber result publication reader is closed");
        // Rewalk authorization directories so replacing an ancestor cannot hide
        // a different publication behind still-valid child descriptors.
        const current = await publicationDirectories(capsule, false);
        try {
          for (let i = 0; i < dirs.handles.length; i++) {
            const original = await io.stat(dirs.handles[i]!.file, dirs.handles[i]!.path);
            const now = await io.stat(current.handles[i]!.file, current.handles[i]!.path);
            if (original.dev !== now.dev || original.ino !== now.ino)
              throw new Error("Amber result directory replaced during collection");
          }
        } finally {
          await Promise.all(current.handles.map((d) => d.file.close()));
        }
        for (const object of opened) await revalidateObject(object);
      }
      await revalidate();
      return {
        manifest,
        receipt,
        reference: marker.reference,
        async getStream(digest: string, options: { maxBytes?: number } = {}) {
          DigestSchema.parse(digest);
          if (closed) throw new Error("Amber result publication reader is closed");
          const object = objects.get(digest);
          if (!object) throw new Error("Object is not in the frozen result publication");
          if (
            options.maxBytes !== undefined &&
            (!Number.isSafeInteger(options.maxBytes) ||
              options.maxBytes < object.reference.sizeBytes)
          )
            throw new Error("Amber result object exceeds caller byte limit");
          await revalidateObject(object);
          return {
            digest,
            uri: `cas://sha256/${digest}`,
            sizeBytes: object.reference.sizeBytes,
            bytes: (async function* () {
              yield* checkedBytes(object.file, object.reference);
              await revalidateObject(object);
            })(),
          };
        },
        revalidate,
        close,
      };
    } catch (error) {
      await close();
      throw error;
    }
  }
  return { siteConfig, siteProfile, publish, openVerifiedPublication };
}

/** Production entrypoint: root-protected config and actual kernel credentials. */
export function createAmberResultSpool(configPath: string) {
  return loadSpool(configPath, amberResultSpoolFileIO);
}
/** Explicit local test seam; never reachable through CLI/config/RPC. */
export function createAmberResultSpoolForTest(configPath: string, io: AmberResultSpoolFileIO) {
  return loadSpool(configPath, io);
}
export type AmberResultSpool = Awaited<ReturnType<typeof createAmberResultSpool>>;
export type VerifiedAmberResultPublication = Awaited<
  ReturnType<AmberResultSpool["openVerifiedPublication"]>
>;
