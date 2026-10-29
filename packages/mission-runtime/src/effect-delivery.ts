import { createHash } from "node:crypto";
import { z } from "zod";
import {
  DigestSchema,
  IdSchema,
  TimestampSchema,
  canonicalJson,
  digestCanonical,
  type ExternalOperation,
  type ScientificMission,
} from "@eigengrid/scientific-schema";
import { ScientificIntegrityError } from "./errors";
import type { MdSubmissionAuthority } from "./effect-reconciliation";
import { readScientificEffectAdmission } from "./operation-outbox";
import { readScientificMissionProjectAssociation } from "./mission-project";
import type { ScientificTransaction } from "./types";

const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u);
const linuxId = z.number().int().positive().max(4_294_967_294);
/** Resolved by the trusted Head/site registry, never a browser-provided UID. */
export const MdDeliveryPrincipalSchema = z
  .object({
    subject: identity,
    projectId: identity,
    uid: linuxId,
    gid: linuxId,
    siteProfileDigest: DigestSchema,
  })
  .strict();
export type MdDeliveryPrincipal = z.infer<typeof MdDeliveryPrincipalSchema>;

export const MAX_EFFECT_DELIVERY_BODY_BYTES = 512 * 1024;
export const MdDeliveryDraftSchema = z
  .object({
    transport: z.literal("slurm.amber-md/v1"),
    bindingDigest: DigestSchema,
    bodyBase64: z
      .string()
      .min(4)
      .max(Math.ceil(MAX_EFFECT_DELIVERY_BODY_BYTES / 3) * 4),
    notBefore: TimestampSchema,
    expiresAt: TimestampSchema,
  })
  .strict();
export type MdDeliveryDraft = z.infer<typeof MdDeliveryDraftSchema>;

export const MdEffectDeliverySchema = MdDeliveryDraftSchema.extend({
  schemaVersion: z.literal("eigengrid.md-effect-delivery/v1"),
  operationId: IdSchema,
  missionId: IdSchema,
  workUnitId: IdSchema,
  requestDigest: DigestSchema,
  admissionDigest: DigestSchema,
  fencingGeneration: z.number().int().positive().safe(),
  principal: MdDeliveryPrincipalSchema,
  bodyDigest: DigestSchema,
  deliveryDigest: DigestSchema,
  createdAt: TimestampSchema,
}).strict();
export type MdEffectDelivery = z.infer<typeof MdEffectDeliverySchema>;

type Row = Record<string, unknown> & { payload_json: string };
function columns(row: Row, expected: Record<string, unknown>): void {
  if (Object.entries(expected).some(([key, value]) => row[key] !== value))
    throw new ScientificIntegrityError("Effect delivery index differs from its immutable payload");
}
export function effectDeliveryBody(delivery: Pick<MdEffectDelivery, "bodyBase64">): Buffer {
  const body = Buffer.from(delivery.bodyBase64, "base64");
  if (
    !body.length ||
    body.length > MAX_EFFECT_DELIVERY_BODY_BYTES ||
    body.toString("base64") !== delivery.bodyBase64
  )
    throw new ScientificIntegrityError("Effect delivery body is not exact bounded base64");
  return body;
}
export function assertMdEffectDelivery(value: unknown): MdEffectDelivery {
  const delivery = MdEffectDeliverySchema.parse(value);
  const { deliveryDigest, ...unsigned } = delivery;
  const duration = Date.parse(delivery.expiresAt) - Date.parse(delivery.notBefore);
  if (
    deliveryDigest !== digestCanonical(unsigned) ||
    duration < 1_000 ||
    duration > 60_000 ||
    delivery.createdAt !== delivery.notBefore ||
    createHash("sha256").update(effectDeliveryBody(delivery)).digest("hex") !== delivery.bodyDigest
  )
    throw new ScientificIntegrityError(
      "Effect delivery digest or frozen dispatch window is invalid",
    );
  return delivery;
}

/** Current DB authorization complements, but never replaces, independent site
 * UID/epoch/membership authority. Keep these locks until the enclosing TX ends.
 */
export async function assertMdDeliveryProjectAccess(
  tx: ScientificTransaction,
  mission: ScientificMission,
  principalValue: MdDeliveryPrincipal,
  provider: string,
  access: "submit" | "observe",
): Promise<MdDeliveryPrincipal> {
  const principal = MdDeliveryPrincipalSchema.parse(principalValue);
  if (mission.requestedBy.kind !== "human" || mission.requestedBy.id !== principal.subject)
    throw new ScientificIntegrityError("MD delivery must belong to its actual human mission owner");
  const lock = provider === "postgres" ? " FOR UPDATE" : "";
  const users = await tx.queryRows<Record<string, unknown>>(
    `SELECT * FROM users WHERE id = $1${lock}`,
    [principal.subject],
  );
  const projects = await tx.queryRows<Record<string, unknown>>(
    `SELECT * FROM projects WHERE id = $1${lock}`,
    [principal.projectId],
  );
  const memberships = await tx.queryRows<Record<string, unknown>>(
    `SELECT * FROM project_memberships WHERE project_id = $1 AND user_id = $2 ORDER BY id${lock}`,
    [principal.projectId, principal.subject],
  );
  const allowed =
    access === "submit" ? ["owner", "admin", "member"] : ["owner", "admin", "member", "viewer"];
  if (
    users.length !== 1 ||
    users[0]!.status !== "active" ||
    projects.length !== 1 ||
    projects[0]!.status !== "active" ||
    memberships.length !== 1 ||
    !allowed.includes(String(memberships[0]!.role))
  )
    throw new ScientificIntegrityError(
      "MD delivery project membership is missing, revoked, ambiguous or insufficient",
    );
  const association = await readScientificMissionProjectAssociation(tx, mission.id, provider, true);
  if (
    !association ||
    association.ownerUserId !== principal.subject ||
    association.projectId !== principal.projectId
  ) {
    throw new ScientificIntegrityError(
      "MD delivery requires its exact immutable mission-project association",
    );
  }
  return principal;
}

export async function readMdEffectDelivery(
  tx: ScientificTransaction,
  operation: ExternalOperation,
): Promise<MdEffectDelivery | null> {
  const [row] = await tx.queryRows<Row>(
    "SELECT * FROM scientific_effect_deliveries WHERE operation_id = $1",
    [operation.id],
  );
  if (!row) return null;
  const delivery = assertMdEffectDelivery(JSON.parse(row.payload_json));
  const admission = await readScientificEffectAdmission(tx, operation);
  const association = await readScientificMissionProjectAssociation(tx, operation.missionId);
  if (
    !admission ||
    !association ||
    operation.kind !== "md_stage_execution" ||
    delivery.operationId !== operation.id ||
    delivery.missionId !== operation.missionId ||
    delivery.workUnitId !== operation.workUnitId ||
    delivery.requestDigest !== operation.requestDigest ||
    delivery.admissionDigest !== admission.admissionDigest ||
    delivery.fencingGeneration !== admission.fencingGeneration ||
    delivery.principal.subject !== association.ownerUserId ||
    delivery.principal.projectId !== association.projectId ||
    Date.parse(delivery.notBefore) < Date.parse(admission.admittedAt) ||
    Date.parse(delivery.expiresAt) > Date.parse(admission.claimExpiresAt)
  )
    throw new ScientificIntegrityError("Effect delivery is outside its exact admission/project");
  columns(row, {
    operation_id: delivery.operationId,
    mission_id: delivery.missionId,
    work_unit_id: delivery.workUnitId,
    admission_digest: delivery.admissionDigest,
    request_digest: delivery.requestDigest,
    binding_digest: delivery.bindingDigest,
    body_digest: delivery.bodyDigest,
    delivery_digest: delivery.deliveryDigest,
    created_at: delivery.createdAt,
  });
  return delivery;
}

/** Caller holds the canonical MD authority/mission/operation locks. The callback
 * is a trusted pure transport builder, never an RPC or a scientific command.
 * An existing delivery is returned WITHOUT invoking the builder or extending time.
 */
export async function freezeMdEffectDelivery(
  tx: ScientificTransaction,
  authority: MdSubmissionAuthority,
  principalValue: MdDeliveryPrincipal,
  provider: string,
  build: (authority: MdSubmissionAuthority) => MdDeliveryDraft,
): Promise<{ delivery: MdEffectDelivery; created: boolean }> {
  const principal = await assertMdDeliveryProjectAccess(
    tx,
    authority.mission,
    principalValue,
    provider,
    "submit",
  );
  const existing = await readMdEffectDelivery(tx, authority.operation);
  if (existing) {
    if (canonicalJson(existing.principal) !== canonicalJson(principal))
      throw new ScientificIntegrityError("A consumed delivery cannot change user/project/UID/site");
    return { delivery: existing, created: false };
  }
  const draft = MdDeliveryDraftSchema.parse(build(structuredClone(authority)));
  const body = effectDeliveryBody(draft);
  if (
    draft.notBefore !== authority.checkedAt ||
    Date.parse(draft.expiresAt) > Date.parse(authority.expiresAt)
  )
    throw new ScientificIntegrityError(
      "Transport builder exceeded the current MD authority window",
    );
  const unsigned = {
    ...draft,
    schemaVersion: "eigengrid.md-effect-delivery/v1" as const,
    operationId: authority.operation.id,
    missionId: authority.mission.id,
    workUnitId: authority.workUnit.id,
    requestDigest: authority.operation.requestDigest,
    admissionDigest: authority.admission.admissionDigest,
    fencingGeneration: authority.admission.fencingGeneration,
    principal,
    bodyDigest: createHash("sha256").update(body).digest("hex"),
    createdAt: draft.notBefore,
  };
  const delivery = assertMdEffectDelivery({
    ...unsigned,
    deliveryDigest: digestCanonical(unsigned),
  });
  await tx.query(
    `INSERT INTO scientific_effect_deliveries
    (operation_id, mission_id, work_unit_id, admission_digest, request_digest, binding_digest, body_digest, delivery_digest, payload_json, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      delivery.operationId,
      delivery.missionId,
      delivery.workUnitId,
      delivery.admissionDigest,
      delivery.requestDigest,
      delivery.bindingDigest,
      delivery.bodyDigest,
      delivery.deliveryDigest,
      canonicalJson(delivery),
      delivery.createdAt,
    ],
  );
  return { delivery, created: true };
}
