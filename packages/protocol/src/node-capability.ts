import { sign, verify } from "node:crypto";
import { z } from "zod";
import { canonicalPublicJson, PublicDigestSchema, publicDigest } from "./public-protocol";

export const NodeManifestSchemaVersion = "eigengrid.node-capability-manifest.v1" as const;

const JsonObject = z.record(z.unknown());

/** Measured, versioned node capability envelope. Unknown nested measurements are retained as data. */
export const NodeCapabilityManifestSchema = z
  .object({
    schema: z.literal(NodeManifestSchemaVersion),
    nodeId: z.string().min(1),
    identity: JsonObject,
    role: z.enum(["head", "worker", "slurm-login", "slurm-compute"]),
    os: JsonObject,
    architecture: z.string().min(1),
    cpu: JsonObject,
    ramBytes: z.number().int().nonnegative(),
    storage: z.array(JsonObject),
    network: JsonObject,
    gpus: z.array(JsonObject),
    runtimes: JsonObject,
    scheduler: JsonObject.nullable(),
    scientificEngines: z.array(JsonObject),
    resourceLimits: JsonObject,
    isolation: JsonObject,
    lastAudit: z.string().datetime({ offset: true }),
    provenance: JsonObject,
    manifestDigest: PublicDigestSchema,
  })
  .strict();
export type NodeCapabilityManifest = z.infer<typeof NodeCapabilityManifestSchema>;

/** Signed attestation envelope for a measured manifest. The manifest remains
 * the measurement record; this envelope authenticates its origin and freshness. */
export const NodeManifestAttestationSchema = z
  .object({
    schema: z.literal("eigengrid.node-capability-attestation.v1"),
    nodeId: z.string().min(1),
    manifestDigest: PublicDigestSchema,
    signerKeyId: z.string().min(1),
    evidenceClass: z.enum([
      "self_reported",
      "head_verified",
      "site_attested",
      "execution_verified",
    ]),
    observedAt: z.string().datetime({ offset: true }),
    signature: z.object({ algorithm: z.literal("ed25519"), value: z.string().min(1) }).strict(),
    attestationDigest: PublicDigestSchema,
  })
  .strict();
export type NodeManifestAttestation = z.infer<typeof NodeManifestAttestationSchema>;

export function createNodeManifestAttestation(input: {
  manifest: NodeCapabilityManifest;
  signerKeyId: string;
  evidenceClass: NodeManifestAttestation["evidenceClass"];
  observedAt: string;
  privateKeyPem: string;
}): NodeManifestAttestation {
  const unsigned = {
    schema: "eigengrid.node-capability-attestation.v1" as const,
    nodeId: input.manifest.nodeId,
    manifestDigest: input.manifest.manifestDigest,
    signerKeyId: input.signerKeyId,
    evidenceClass: input.evidenceClass,
    observedAt: input.observedAt,
  };
  const signature = {
    algorithm: "ed25519" as const,
    value: sign(
      null,
      Buffer.from(canonicalPublicJson(unsigned), "utf8"),
      input.privateKeyPem,
    ).toString("base64"),
  };
  const material = { ...unsigned, signature };
  return NodeManifestAttestationSchema.parse({
    ...material,
    attestationDigest: publicDigest(material),
  });
}

export function verifyNodeManifestAttestation(
  raw: unknown,
  manifest: NodeCapabilityManifest,
  trustedPublicKeys: Readonly<Record<string, string>>,
  options: { now?: Date; maxAgeMs?: number } = {},
): { ok: true; attestation: NodeManifestAttestation } | { ok: false; errors: string[] } {
  const parsed = NodeManifestAttestationSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    };
  }
  const attestation = parsed.data;
  const { attestationDigest, ...material } = attestation;
  const errors: string[] = [];
  if (publicDigest(material) !== attestationDigest) errors.push("attestationDigest mismatch");
  if (
    attestation.nodeId !== manifest.nodeId ||
    attestation.manifestDigest !== manifest.manifestDigest
  ) {
    errors.push("attestation does not bind the supplied manifest");
  }
  const publicKey = trustedPublicKeys[attestation.signerKeyId];
  if (!publicKey) errors.push("attestation signer is not trusted");
  else {
    try {
      const { signature, ...unsigned } = material;
      if (
        !verify(
          null,
          Buffer.from(canonicalPublicJson(unsigned), "utf8"),
          publicKey,
          Buffer.from(signature.value, "base64"),
        )
      ) {
        errors.push("attestation signature is invalid");
      }
    } catch {
      errors.push("attestation signature could not be verified");
    }
  }
  const now = options.now?.getTime();
  const observed = Date.parse(attestation.observedAt);
  if (
    now !== undefined &&
    options.maxAgeMs !== undefined &&
    (observed > now || now - observed > options.maxAgeMs)
  ) {
    errors.push("attestation is outside the permitted freshness window");
  }
  return errors.length === 0 ? { ok: true, attestation } : { ok: false, errors };
}

export function computeNodeManifestDigest(
  manifest: Omit<NodeCapabilityManifest, "manifestDigest"> | NodeCapabilityManifest,
): `sha256:${string}` {
  const { manifestDigest: _digest, ...material } = manifest as NodeCapabilityManifest;
  return publicDigest(material) as `sha256:${string}`;
}

export function createNodeCapabilityManifest(
  input: Omit<NodeCapabilityManifest, "schema" | "manifestDigest">,
): NodeCapabilityManifest {
  const material = { ...input, schema: NodeManifestSchemaVersion } as Omit<
    NodeCapabilityManifest,
    "manifestDigest"
  >;
  return NodeCapabilityManifestSchema.parse({
    ...material,
    manifestDigest: computeNodeManifestDigest(material),
  });
}

export function verifyNodeCapabilityManifest(
  raw: unknown,
): { ok: true; manifest: NodeCapabilityManifest } | { ok: false; errors: string[] } {
  const parsed = NodeCapabilityManifestSchema.safeParse(raw);
  if (!parsed.success)
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    };
  const expected = computeNodeManifestDigest(parsed.data);
  if (expected !== parsed.data.manifestDigest) {
    return {
      ok: false,
      errors: [`manifestDigest: expected ${expected}, got ${parsed.data.manifestDigest}`],
    };
  }
  return { ok: true, manifest: parsed.data };
}

export interface NodeDrift {
  path: string;
  observed: unknown;
  desired: unknown;
  risk: "low" | "medium" | "high";
}

export interface NodeAuditReport {
  schema: "eigengrid.node-audit.v1";
  nodeId: string;
  observedDigest: string;
  desiredDigest?: string;
  drift: NodeDrift[];
  risk: "none" | "low" | "medium" | "high";
  remediation: ReadonlyArray<{ path: string; action: "review" | "apply-typed-plan" }>;
  mutating: false;
  auditedAt: string;
}

/** Read-only structural audit. It never executes remediation or shell commands. */
export function auditNodeManifest(
  observed: NodeCapabilityManifest,
  desired?: Partial<NodeCapabilityManifest>,
  now = new Date(),
): NodeAuditReport {
  const drift: NodeDrift[] = [];
  for (const [path, desiredValue] of Object.entries(desired ?? {})) {
    if (path === "manifestDigest" || desiredValue === undefined) continue;
    const observedValue = (observed as unknown as Record<string, unknown>)[path];
    if (canonicalPublicJson(observedValue) !== canonicalPublicJson(desiredValue)) {
      const risk =
        path === "isolation" || path === "identity" || path === "resourceLimits"
          ? "high"
          : "medium";
      drift.push({ path, observed: observedValue, desired: desiredValue, risk });
    }
  }
  const risk = drift.some((entry) => entry.risk === "high")
    ? "high"
    : drift.some((entry) => entry.risk === "medium")
      ? "medium"
      : drift.length > 0
        ? "low"
        : "none";
  return {
    schema: "eigengrid.node-audit.v1",
    nodeId: observed.nodeId,
    observedDigest: observed.manifestDigest,
    desiredDigest: desired ? publicDigest(desired) : undefined,
    drift,
    risk,
    remediation: drift.map((entry) => ({
      path: entry.path,
      action: entry.risk === "high" ? "review" : "apply-typed-plan",
    })),
    mutating: false,
    auditedAt: now.toISOString(),
  };
}
