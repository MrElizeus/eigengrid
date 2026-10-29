import { createHash } from "node:crypto";
import { z } from "zod";
import {
  AtomMapSchema,
  DigestSchema,
  MdExecutionBindingParametersSchema,
  MdStageOperationRequestSchema,
  MdStageSpecSchema,
  canonicalJson,
  type MdStageOperationRequest,
} from "@eigengrid/scientific-schema";
import {
  AmberCanonicalStageMappingSchema,
  CommandInputSchema,
  assertAmberMdStageOperationRequest,
  renderCanonicalAmberStage,
  type RenderedCanonicalAmberStage,
} from "@eigengrid/amber-adapter";
import type { ContentAddressedArtifactStore } from "@eigengrid/mission-runtime";

/** Capacity guards, not a scientifically qualified workload envelope. */
export const AMBER_BUNDLE_LIMITS = Object.freeze({
  manifestBytes: 4 * 1024 * 1024,
  atomMapBytes: 64 * 1024 * 1024,
  mdinBytes: 64 * 1024,
  inputBytes: 1024 * 1024 * 1024,
});
const sizeSchema = z.number().int().positive().safe();
const objectReferenceSchema = z
  .object({ sha256: DigestSchema, sizeBytes: sizeSchema.max(AMBER_BUNDLE_LIMITS.inputBytes) })
  .strict();
export const AmberBundleReferenceSchema = objectReferenceSchema.extend({
  sizeBytes: sizeSchema.max(AMBER_BUNDLE_LIMITS.manifestBytes),
});
export type AmberBundleReference = z.infer<typeof AmberBundleReferenceSchema>;

const seedFields = {
  stage: MdStageSpecSchema,
  mapping: AmberCanonicalStageMappingSchema,
  executionBinding: MdExecutionBindingParametersSchema,
  request: MdStageOperationRequestSchema,
};
const seedSchema = z.object({ ...seedFields, atomMap: AtomMapSchema }).strict();
export const AmberStageBundleSchema = z
  .object({
    schemaVersion: z.literal("eigengrid.amber-stage-bundle/v1"),
    ...seedFields,
    atomMap: objectReferenceSchema.extend({
      sizeBytes: sizeSchema.max(AMBER_BUNDLE_LIMITS.atomMapBytes),
    }),
    inputs: z
      .array(
        CommandInputSchema.extend({
          sizeBytes: sizeSchema.max(AMBER_BUNDLE_LIMITS.inputBytes),
        }).strict(),
      )
      .length(3),
  })
  .strict();
export type AmberStageBundle = z.infer<typeof AmberStageBundleSchema>;

/** Caller supplies an initialized, authorized CAS, never a browser path. Use
 * access: "read-only" for separately provisioned publications. This port does
 * NOT grant project/cross-UID access or expose the Head's private CAS to workers.
 */
type BundleReader = Pick<ContentAddressedArtifactStore, "verify" | "getStream">;
type BundleStore = BundleReader & Pick<ContentAddressedArtifactStore, "put" | "putStream">;
export interface VerifiedAmberStageBundle {
  reference: AmberBundleReference;
  manifest: AmberStageBundle;
  rendered: RenderedCanonicalAmberStage;
}

function reconstruct(seed: z.infer<typeof seedSchema>): RenderedCanonicalAmberStage {
  const rendered = renderCanonicalAmberStage(
    seed.stage,
    seed.mapping,
    seed.executionBinding,
    seed.atomMap,
  );
  assertAmberMdStageOperationRequest(seed.request, rendered, seed.mapping.environment, {
    workUnitId: seed.request.workUnitId,
    bindingDigest: seed.mapping.canonicalWorkUnit.bindingDigest,
    outputContractDigest: seed.request.outputContractDigest,
  });
  const executable = rendered.commandRequest.executable;
  const gpuCount = seed.stage.resourceProfile.gpuCount;
  if (
    !(
      (executable === "sander" && gpuCount === 0) ||
      (executable === "pmemd.cuda" && gpuCount === 1)
    )
  )
    throw new Error("Production Amber bundle engine and GPU allocation are unsupported");
  // File/directory collisions are invalid even when every path alone is safe.
  // Reference coordinates may share the exact state path; the canonical renderer
  // represents this as one input plus -ref, never an extra uploaded file.
  const command = rendered.commandRequest;
  const paths = [...command.inputs, ...command.outputs].map((item) => item.logicalPath);
  for (const [index, path] of paths.entries()) {
    if (
      paths.some(
        (other, otherIndex) =>
          index !== otherIndex && (other === path || other.startsWith(`${path}/`)),
      ) ||
      command.cwd === path ||
      command.cwd.startsWith(`${path}/`)
    )
      throw new Error("Amber bundle contains a file/directory path collision");
  }
  if (
    canonicalJson(command.inputs.map((input) => input.role).sort()) !==
    canonicalJson(["coordinates.input", "stage.mdin", "topology.prmtop"])
  )
    throw new Error("Amber bundle input roles are not closed");
  return rendered;
}

function boundedBytes(value: unknown, limit: number): Buffer {
  const bytes = Buffer.from(canonicalJson(value), "utf8");
  if (bytes.length > limit) throw new Error("Amber bundle metadata exceeds its byte limit");
  return bytes;
}

/** Rehash the bytes actually consumed, not just an earlier verification pass.
 * A failed/partial transfer may leave an unreferenced CAS object, never a bundle
 * ACK or permission to repeat an engine effect. CAS owns atomic publication.
 */
async function* verifiedChunks(
  store: BundleReader,
  reference: AmberBundleReference,
): AsyncGenerator<Uint8Array> {
  const stream = await store.getStream(reference.sha256, { maxBytes: reference.sizeBytes });
  let size = 0;
  const hash = createHash("sha256");
  // Enter the iterator before validation so its finally closes bound descriptors.
  for await (const chunk of stream.bytes) {
    if (stream.digest !== reference.sha256 || stream.sizeBytes !== reference.sizeBytes)
      throw new Error("Amber bundle object metadata differs from its reference");
    size += chunk.byteLength;
    if (size > reference.sizeBytes) throw new Error("Amber bundle object exceeds its byte limit");
    hash.update(chunk);
    yield chunk;
  }
  if (
    size !== reference.sizeBytes ||
    stream.sizeBytes !== reference.sizeBytes ||
    hash.digest("hex") !== reference.sha256
  )
    throw new Error("Amber bundle object bytes differ from their exact hash/size");
}

async function readJson(
  store: BundleReader,
  reference: AmberBundleReference,
): Promise<{ value: unknown; text: string }> {
  const chunks: Buffer[] = [];
  for await (const chunk of verifiedChunks(store, reference)) chunks.push(Buffer.from(chunk));
  const bytes = Buffer.concat(chunks);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes))
    throw new Error("Amber metadata is not exact UTF-8");
  return { value: JSON.parse(text), text };
}

function assertInventory(manifest: AmberStageBundle, rendered: RenderedCanonicalAmberStage): void {
  const inventory = manifest.inputs.map(({ sizeBytes: _size, ...input }) => input);
  if (canonicalJson(inventory) !== canonicalJson(rendered.commandRequest.inputs))
    throw new Error("Amber bundle inputs differ from the reconstructed command");
  const total = manifest.inputs.reduce((sum, input) => sum + input.sizeBytes, 0);
  if (total > AMBER_BUNDLE_LIMITS.inputBytes || total > manifest.stage.resourceProfile.scratchBytes)
    throw new Error("Amber bundle inputs exceed their staging/scratch bound");
  const mdin = manifest.inputs.find((input) => input.role === "stage.mdin")!;
  if (
    mdin.sizeBytes !== Buffer.byteLength(rendered.renderedMdin.content, "utf8") ||
    mdin.sizeBytes > AMBER_BUNDLE_LIMITS.mdinBytes
  )
    throw new Error("Amber bundle mdin differs from the canonical renderer");
}

/** Head-side preparation before the admission/signing transaction. It publishes
 * no command supplied by a caller: the command and mdin are reconstructed from
 * the exact canonical stage, mapping, execution binding and complete atom map.
 * This verifies identity/integrity, NOT topology physics, QC, approval or Slurm.
 */
export async function publishAmberStageBundle(
  store: BundleStore,
  seedValue: unknown,
): Promise<VerifiedAmberStageBundle> {
  const seed = seedSchema.parse(seedValue);
  const rendered = reconstruct(seed);
  const atomBytes = boundedBytes(seed.atomMap, AMBER_BUNDLE_LIMITS.atomMapBytes);
  const mdinBytes = Buffer.from(rendered.renderedMdin.content, "utf8");
  if (mdinBytes.length > AMBER_BUNDLE_LIMITS.mdinBytes)
    throw new Error("Amber mdin exceeds its byte limit");
  const inputs: AmberStageBundle["inputs"] = [];
  for (const input of rendered.commandRequest.inputs) {
    const sizeBytes =
      input.role === "stage.mdin" ? mdinBytes.length : (await store.verify(input.sha256)).sizeBytes;
    inputs.push({ ...input, sizeBytes });
  }
  const manifest = AmberStageBundleSchema.parse({
    schemaVersion: "eigengrid.amber-stage-bundle/v1",
    stage: seed.stage,
    mapping: seed.mapping,
    executionBinding: seed.executionBinding,
    request: seed.request,
    atomMap: {
      sha256: createHash("sha256").update(atomBytes).digest("hex"),
      sizeBytes: atomBytes.length,
    },
    inputs,
  });
  assertInventory(manifest, rendered);
  const manifestBytes = boundedBytes(manifest, AMBER_BUNDLE_LIMITS.manifestBytes);
  await store.put(atomBytes);
  const mdin = await store.put(mdinBytes);
  if (mdin.digest !== rendered.renderedMdin.sha256)
    throw new Error("Canonical Amber mdin bytes/hash disagree");
  const stored = await store.put(manifestBytes);
  // A publish acknowledgement includes rereading all actual objects. The caller
  // must independently verify the receiving store before the external effect.
  return readAmberStageBundle(
    store,
    { sha256: stored.digest, sizeBytes: stored.sizeBytes },
    seed.request,
  );
}

/** Submitter-side verification: never trust a self-hashed renderedStage. */
export async function readAmberStageBundle(
  store: BundleReader,
  referenceValue: unknown,
  expectedRequestValue: unknown,
): Promise<VerifiedAmberStageBundle> {
  const reference = AmberBundleReferenceSchema.parse(referenceValue);
  const expectedRequest = MdStageOperationRequestSchema.parse(expectedRequestValue);
  const raw = await readJson(store, reference);
  const manifest = AmberStageBundleSchema.parse(raw.value);
  if (canonicalJson(manifest) !== raw.text)
    throw new Error("Amber bundle manifest is not canonical");
  if (canonicalJson(manifest.request) !== canonicalJson(expectedRequest))
    throw new Error("Amber bundle does not belong to the exact admitted request");
  const rawMap = await readJson(store, manifest.atomMap);
  const atomMap = AtomMapSchema.parse(rawMap.value);
  if (canonicalJson(atomMap) !== rawMap.text)
    throw new Error("Amber bundle atom map is not canonical");
  const rendered = reconstruct({ ...manifest, atomMap });
  assertInventory(manifest, rendered);
  for (const input of manifest.inputs) {
    for await (const _chunk of verifiedChunks(store, {
      sha256: input.sha256,
      sizeBytes: input.sizeBytes,
    })) {
      // Verification drains each descriptor-bound stream without buffering inputs.
    }
  }
  return { reference, manifest, rendered };
}

/** Resumable content-addressed copy, not scientific execution or canonical ACK.
 * Do not call this with another user's private CAS. Site publication/permissions
 * and independent-replica qualification remain the deployment boundary's job.
 */
export async function copyAmberStageBundle(
  source: BundleReader,
  target: BundleStore,
  reference: unknown,
  expectedRequest: MdStageOperationRequest,
): Promise<VerifiedAmberStageBundle> {
  const verified = await readAmberStageBundle(source, reference, expectedRequest);
  const objects = [
    verified.manifest.atomMap,
    ...verified.manifest.inputs.map(({ sha256, sizeBytes }) => ({ sha256, sizeBytes })),
    verified.reference, // Publish the manifest last, after every referenced object.
  ];
  for (const object of objects) {
    const stored = await target.putStream(verifiedChunks(source, object), {
      maxBytes: object.sizeBytes,
    });
    if (stored.digest !== object.sha256 || stored.sizeBytes !== object.sizeBytes)
      throw new Error("Amber bundle copy differs from the exact source object");
  }
  return readAmberStageBundle(target, verified.reference, expectedRequest);
}
