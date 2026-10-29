import { z } from "zod";
import {
  MdStageOperationRequestSchema,
  canonicalJson,
  digestCanonical,
} from "@eigengrid/scientific-schema";
import { SlurmSubmissionBindingSchema, assertSlurmSubmissionBinding } from "@eigengrid/slurm";
import {
  MAX_EFFECT_DELIVERY_BODY_BYTES,
  assertMdEffectDelivery,
  effectDeliveryBody,
  type MdDeliveryDraft,
  type MdDeliveryPrincipal,
  type MdEffectDelivery,
  type MdSubmissionAuthority,
} from "@eigengrid/mission-runtime";
import { AmberBundleReferenceSchema } from "./amber-stage-bundle";

/** Command-free transport description, not a proof of scientific execution.
 * The referenced immutable CAS bundle must be verified by the trusted builder
 * and reconstructed/verified again by the typed submitter backend before effect.
 * No caller-supplied shell, argv, environment or filesystem path is accepted.
 */
export const AmberSlurmDeliveryBodySchema = z
  .object({
    schemaVersion: z.literal("eigengrid.amber-slurm-delivery/v1"),
    request: MdStageOperationRequestSchema,
    binding: SlurmSubmissionBindingSchema,
    bundle: AmberBundleReferenceSchema,
  })
  .strict();
export type AmberSlurmDeliveryBody = z.infer<typeof AmberSlurmDeliveryBodySchema>;

export function assertAmberSlurmDeliveryBody(value: unknown): AmberSlurmDeliveryBody {
  const body = AmberSlurmDeliveryBodySchema.parse(value);
  const binding = assertSlurmSubmissionBinding(body.binding);
  if (
    digestCanonical(body.request) !== binding.requestDigest ||
    !body.request.stage.kind ||
    body.request.environment.engine.engine !== "amber" ||
    Date.parse(binding.expiresAt) - Date.parse(binding.notBefore) > 60_000
  )
    throw new Error("Amber delivery is outside its exact typed request/window");
  return body;
}

export function parseAmberSlurmDelivery(deliveryValue: MdEffectDelivery): AmberSlurmDeliveryBody {
  const delivery = assertMdEffectDelivery(deliveryValue);
  const body = parseAmberSlurmDeliveryBytes(effectDeliveryBody(delivery));
  const binding = body.binding;
  if (
    binding.operationId !== delivery.operationId ||
    binding.requestDigest !== delivery.requestDigest ||
    body.request.workUnitId !== delivery.workUnitId ||
    binding.admissionDigest !== delivery.admissionDigest ||
    binding.bindingDigest !== delivery.bindingDigest ||
    binding.uid !== delivery.principal.uid ||
    binding.siteProfileDigest !== delivery.principal.siteProfileDigest ||
    binding.notBefore !== delivery.notBefore ||
    binding.expiresAt !== delivery.expiresAt
  )
    throw new Error("Amber delivery body differs from its durable envelope");
  return body;
}

/** Same canonical body parser at the authenticated per-UID boundary; no DB or
 * client identity is inferred here. The caller must bind the verified capability.
 */
export function parseAmberSlurmDeliveryBytes(value: Uint8Array): AmberSlurmDeliveryBody {
  const bytes = Buffer.from(value);
  if (!bytes.length || bytes.length > MAX_EFFECT_DELIVERY_BODY_BYTES)
    throw new Error("Amber delivery body exceeds its bound");
  const text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes)) throw new Error("Amber delivery is not exact UTF-8");
  const body = assertAmberSlurmDeliveryBody(JSON.parse(text));
  // Canonical JSON rejects duplicate keys, ignored fields, alternate whitespace
  // or numeric spellings even if JSON.parse would silently normalize them.
  if (canonicalJson(body) !== text) throw new Error("Amber delivery body is not canonical");
  return body;
}

export function createAmberSlurmDeliveryDraft(
  authority: MdSubmissionAuthority,
  principal: MdDeliveryPrincipal,
  value: unknown,
): MdDeliveryDraft {
  const body = assertAmberSlurmDeliveryBody(value);
  const binding = body.binding;
  const resources = authority.stage.resourceProfile;
  if (
    canonicalJson(body.request) !== canonicalJson(authority.operation.request) ||
    binding.operationId !== authority.operation.id ||
    binding.admissionDigest !== authority.admission.admissionDigest ||
    binding.uid !== principal.uid ||
    binding.siteProfileDigest !== principal.siteProfileDigest ||
    binding.notBefore !== authority.checkedAt ||
    Date.parse(binding.expiresAt) > Date.parse(authority.expiresAt) ||
    binding.resources.cpus !== resources.cpuCores ||
    binding.resources.memoryMiB !== Math.ceil(resources.memoryBytes / (1024 * 1024)) ||
    binding.resources.walltimeSeconds !== resources.wallTimeSeconds ||
    (binding.resources.gpuCount ?? 0) !== resources.gpuCount
  )
    throw new Error("Amber delivery differs from live admitted stage/principal/resources");
  const bytes = Buffer.from(canonicalJson(body), "utf8");
  if (bytes.length > MAX_EFFECT_DELIVERY_BODY_BYTES)
    throw new Error("Amber delivery exceeds its bound");
  return {
    transport: "slurm.amber-md/v1",
    bindingDigest: binding.bindingDigest,
    bodyBase64: bytes.toString("base64"),
    notBefore: binding.notBefore,
    expiresAt: binding.expiresAt,
  };
}
