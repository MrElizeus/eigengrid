import { createHash, createPrivateKey, sign } from "node:crypto";
import { z } from "zod";

export const SUBMITTER_CAPABILITY_VERSION = "eigengrid.submitter-capability/v1" as const;
export const SUBMITTER_SIGNATURE_DOMAIN = `${SUBMITTER_CAPABILITY_VERSION}\n`;
export const SUBMITTER_MAX_BODY_BYTES = 512 * 1024;
export const SUBMITTER_MAX_WIRE_BYTES = 720 * 1024;
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const integer = z.number().int().positive().safe();

// This field order is a versioned, cross-language wire contract. All strings are
// ASCII and all numbers are safe positive integers, avoiding JSON float/Unicode ambiguity.
export const SubmitterCapabilitySchema = z
  .object({
    version: z.literal(SUBMITTER_CAPABILITY_VERSION),
    action: z.enum(["submit", "observe"]),
    requestId: identifier,
    subject: identifier,
    projectId: identifier,
    uid: integer.max(4_294_967_294),
    gid: integer.max(4_294_967_294),
    recoveryEpoch: identifier,
    membershipGeneration: integer,
    siteProfileDigest: digest,
    operationId: identifier,
    requestDigest: digest,
    admissionDigest: digest,
    bindingDigest: digest,
    bodyDigest: digest,
    fencingGeneration: integer,
    notBeforeMs: integer,
    expiresAtMs: integer,
  })
  .strict()
  .refine(
    (value) =>
      value.expiresAtMs > value.notBeforeMs && value.expiresAtMs - value.notBeforeMs <= 60_000,
    "Submitter capability must expire within 60 seconds",
  );

export type SubmitterCapability = z.infer<typeof SubmitterCapabilitySchema>;

/** V2 grants only an accounting read for an already consumed V1 effect. The
 * V1 schema, signature domain and canonical field order remain unchanged. */
export const SUBMITTER_ACCOUNTING_CAPABILITY_VERSION = "eigengrid.submitter-capability/v2" as const;
export const SUBMITTER_ACCOUNTING_SIGNATURE_DOMAIN = `${SUBMITTER_ACCOUNTING_CAPABILITY_VERSION}\n`;
export const SubmitterAccountingCapabilitySchema = SubmitterCapabilitySchema.innerType()
  .extend({
    version: z.literal(SUBMITTER_ACCOUNTING_CAPABILITY_VERSION),
    action: z.literal("accounting"),
  })
  .refine(
    (value) =>
      value.expiresAtMs > value.notBeforeMs && value.expiresAtMs - value.notBeforeMs <= 60_000,
    "Submitter capability must expire within 60 seconds",
  );
export type SubmitterAccountingCapability = z.infer<typeof SubmitterAccountingCapabilitySchema>;
export const AnySubmitterCapabilitySchema = z.union([
  SubmitterCapabilitySchema,
  SubmitterAccountingCapabilitySchema,
]);
export type AnySubmitterCapability = z.infer<typeof AnySubmitterCapabilitySchema>;

export function signSubmitterAccountingCapability(
  value: Omit<SubmitterAccountingCapability, "version" | "bodyDigest">,
  bodyValue: Uint8Array,
  privateKeyPem: string,
): { capability: SubmitterAccountingCapability; wire: Uint8Array } {
  const body = Buffer.from(bodyValue);
  if (body.length === 0 || body.length > SUBMITTER_MAX_BODY_BYTES)
    throw new Error("Submitter request body exceeds its bound");
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error("Submitter requires an Ed25519 Head key");
  const capability = SubmitterAccountingCapabilitySchema.parse({
    ...value,
    version: SUBMITTER_ACCOUNTING_CAPABILITY_VERSION,
    bodyDigest: createHash("sha256").update(body).digest("hex"),
  });
  const payload = Buffer.from(JSON.stringify(capability), "ascii");
  const signature = sign(
    null,
    Buffer.concat([Buffer.from(SUBMITTER_ACCOUNTING_SIGNATURE_DOMAIN), payload]),
    key,
  );
  const wire = Buffer.from(
    JSON.stringify({
      payload: payload.toString("base64"),
      signature: signature.toString("base64"),
      body: body.toString("base64"),
    }),
  );
  if (wire.length > SUBMITTER_MAX_WIRE_BYTES)
    throw new Error("Submitter request exceeds its bound");
  return { capability, wire };
}

/** Head-internal transport signing ONLY, after canonical durable admission and
 * current human/project authorization. Possession of this helper is not authority:
 * the private Ed25519 key must never be provisioned to runners, submitters or models.
 * No shell, executable, filesystem path or browser-supplied UID is interpreted here.
 */
export function signSubmitterCapability(
  value: Omit<SubmitterCapability, "version" | "bodyDigest">,
  bodyValue: Uint8Array,
  privateKeyPem: string,
): { capability: SubmitterCapability; wire: Uint8Array } {
  const body = Buffer.from(bodyValue);
  if (body.length === 0 || body.length > SUBMITTER_MAX_BODY_BYTES)
    throw new Error("Submitter request body exceeds its bound");
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error("Submitter requires an Ed25519 Head key");
  // Zod emits object keys in schema order, regardless of caller property order.
  const capability = SubmitterCapabilitySchema.parse({
    ...value,
    version: SUBMITTER_CAPABILITY_VERSION,
    bodyDigest: createHash("sha256").update(body).digest("hex"),
  });
  const payload = Buffer.from(JSON.stringify(capability), "ascii");
  const signature = sign(
    null,
    Buffer.concat([Buffer.from(SUBMITTER_SIGNATURE_DOMAIN), payload]),
    key,
  );
  const wire = Buffer.from(
    JSON.stringify({
      payload: payload.toString("base64"),
      signature: signature.toString("base64"),
      body: body.toString("base64"),
    }),
  );
  if (wire.length > SUBMITTER_MAX_WIRE_BYTES)
    throw new Error("Submitter request exceeds its bound");
  return { capability, wire };
}
