/** Independent-replica protocol. A checksum is NOT a replica acknowledgement.
 * Head trusts a provisioned replica public key; only the replica process has the
 * signing key. This library never grants site qualification or restore authority.
 */
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { z } from "zod";
import {
  DigestSchema,
  IdSchema,
  TimestampSchema,
  canonicalJson,
  digestCanonical,
} from "@eigengrid/scientific-schema";
import type { ContentAddressedArtifactStore } from "./content-addressed-store";

const objectSchema = z
  .object({
    digest: DigestSchema,
    sizeBytes: z
      .number()
      .int()
      .safe()
      .nonnegative()
      .max(32 * 1024 ** 3),
  })
  .strict();
export const MdReplicaManifestSchema = z
  .object({
    schemaVersion: z.literal("eigengrid.md-replica-manifest/v1"),
    operationId: IdSchema,
    collectionDigest: DigestSchema,
    resultDigest: DigestSchema,
    assessmentDigest: DigestSchema,
    metadataDigest: DigestSchema,
    objects: z.array(objectSchema).min(1).max(256),
    manifestDigest: DigestSchema,
  })
  .strict()
  .superRefine((m, c) => {
    if (
      m.objects.some((x, i) => i > 0 && x.digest <= m.objects[i - 1]!.digest) ||
      !m.objects.some((x) => x.digest === m.metadataDigest) ||
      m.objects.reduce((s, x) => s + x.sizeBytes, 0) > 64 * 1024 ** 3
    )
      c.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Replica manifest must be sorted, unique, bounded and include its metadata",
      });
  });
export type MdReplicaManifest = z.infer<typeof MdReplicaManifestSchema>;
export function mdReplicaManifestDigest(
  value: Omit<MdReplicaManifest, "manifestDigest"> | MdReplicaManifest,
): string {
  const { manifestDigest: _digest, ...body } = value as MdReplicaManifest;
  return digestCanonical(body);
}
export function assertMdReplicaManifest(value: unknown): MdReplicaManifest {
  const m = MdReplicaManifestSchema.parse(value);
  if (m.manifestDigest !== mdReplicaManifestDigest(m))
    throw new Error("Replica manifest digest mismatch");
  return m;
}
export const MdReplicaIdentitySchema = z
  .object({
    keyId: IdSchema,
    primaryFailureDomain: IdSchema,
    replicaFailureDomain: IdSchema,
    storageProfileDigest: DigestSchema,
  })
  .strict()
  .refine(
    (i) => i.primaryFailureDomain !== i.replicaFailureDomain,
    "Replica must belong to a separately provisioned failure domain",
  );
export type MdReplicaIdentity = z.infer<typeof MdReplicaIdentitySchema>;
const ReceiptBodySchema = z
  .object({
    schemaVersion: z.literal("eigengrid.md-replica-readback/v1"),
    identity: MdReplicaIdentitySchema,
    operationId: IdSchema,
    manifestDigest: DigestSchema,
    objectCount: z.number().int().positive().max(256),
    totalBytes: z
      .number()
      .int()
      .safe()
      .nonnegative()
      .max(64 * 1024 ** 3),
    readbackVerified: z.literal(true),
    acknowledgedAt: TimestampSchema,
  })
  .strict();
export const MdReplicaReceiptSchema = z
  .object({
    body: ReceiptBodySchema,
    algorithm: z.literal("Ed25519"),
    signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
  })
  .strict();
export type MdReplicaReceipt = z.infer<typeof MdReplicaReceiptSchema>;

/** Runs in the separately provisioned replica service, NOT inside the Head.
 * Objects and manifest are fsynced by CAS, then re-read before signing. Domain
 * independence is an operator/site qualification, not inferred from two paths.
 */
export async function replicateMdArtifactManifest(input: {
  manifest: unknown;
  source: ContentAddressedArtifactStore;
  replica: ContentAddressedArtifactStore;
  identity: MdReplicaIdentity;
  replicaPrivateKey: string;
  now: string;
}): Promise<MdReplicaReceipt> {
  const manifest = assertMdReplicaManifest(input.manifest),
    identity = MdReplicaIdentitySchema.parse(input.identity);
  TimestampSchema.parse(input.now);
  if (input.source === input.replica)
    throw new Error("Primary CAS cannot acknowledge itself as a replica");
  const key = createPrivateKey(input.replicaPrivateKey);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Replica signing key must be Ed25519");
  for (const object of manifest.objects) {
    const source = await input.source.getStream(object.digest, { maxBytes: object.sizeBytes });
    if (source.sizeBytes !== object.sizeBytes)
      throw new Error("Primary replica object size changed");
    const written = await input.replica.putStream(source.bytes, { maxBytes: object.sizeBytes });
    if (written.digest !== object.digest || written.sizeBytes !== object.sizeBytes)
      throw new Error("Replica copy does not match requested bytes");
    const verified = await input.replica.verify(object.digest, { maxBytes: object.sizeBytes });
    if (verified.sizeBytes !== object.sizeBytes) throw new Error("Replica readback size mismatch");
  }
  const stored = await input.replica.put(Buffer.from(canonicalJson(manifest)));
  await input.replica.verify(stored.digest, { maxBytes: stored.sizeBytes });
  const body = ReceiptBodySchema.parse({
    schemaVersion: "eigengrid.md-replica-readback/v1",
    identity,
    operationId: manifest.operationId,
    manifestDigest: manifest.manifestDigest,
    objectCount: manifest.objects.length,
    totalBytes: manifest.objects.reduce((sum, o) => sum + o.sizeBytes, 0),
    readbackVerified: true,
    acknowledgedAt: input.now,
  });
  return {
    body,
    algorithm: "Ed25519",
    signature: sign(null, Buffer.from(canonicalJson(body)), key).toString("base64"),
  };
}

/** A trusted internal Head capability; configuration and public keys must be
 * provisioned outside model/API payloads. Missing receipt stays pending.
 */
export class MdReplicaVerifier {
  private readonly identity: MdReplicaIdentity;
  private readonly key: ReturnType<typeof createPublicKey>;
  constructor(
    private readonly options: {
      identity: MdReplicaIdentity;
      replicaPublicKey: string;
      readReceipt: (operationId: string, manifestDigest: string) => Promise<unknown | null>;
    },
  ) {
    this.identity = MdReplicaIdentitySchema.parse(options.identity);
    this.key = createPublicKey(options.replicaPublicKey);
    if (this.key.asymmetricKeyType !== "ed25519")
      throw new Error("Replica verification key must be Ed25519");
  }
  verifyReceipt(manifestValue: unknown, value: unknown, now: string): MdReplicaReceipt {
    const manifest = assertMdReplicaManifest(manifestValue),
      receipt = MdReplicaReceiptSchema.parse(value);
    TimestampSchema.parse(now);
    if (
      digestCanonical(receipt.body.identity) !== digestCanonical(this.identity) ||
      receipt.body.operationId !== manifest.operationId ||
      receipt.body.manifestDigest !== manifest.manifestDigest ||
      receipt.body.objectCount !== manifest.objects.length ||
      receipt.body.totalBytes !== manifest.objects.reduce((s, o) => s + o.sizeBytes, 0) ||
      Date.parse(receipt.body.acknowledgedAt) > Date.parse(now) ||
      !verify(
        null,
        Buffer.from(canonicalJson(receipt.body)),
        this.key,
        Buffer.from(receipt.signature, "base64"),
      )
    )
      throw new Error(
        "Independent replica receipt signature, domain, time or exact manifest mismatch",
      );
    return receipt;
  }
  async read(manifest: MdReplicaManifest, now: string): Promise<MdReplicaReceipt | null> {
    const value = await this.options.readReceipt(manifest.operationId, manifest.manifestDigest);
    return value === null ? null : this.verifyReceipt(manifest, value, now);
  }
}
