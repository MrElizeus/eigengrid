import {
  ExternalOperationSchema,
  IdSchema,
  ScientificMissionSchema,
  canonicalJson,
  digestCanonical,
} from "@eigengrid/scientific-schema";
import {
  MdDeliveryPrincipalSchema,
  assertMdDeliveryProjectAccess,
  freezeMdEffectDelivery,
  readMdEffectDelivery,
  type MdDeliveryDraft,
  type MdDeliveryPrincipal,
  type MdEffectDelivery,
} from "../effect-delivery";
import { ScientificIntegrityError } from "../errors";
import { EffectReconciliationContext } from "./context";
import { type MdSubmissionAuthority, type MdSubmissionAuthorityInput } from "./contracts";
import { withMdSubmissionAuthority } from "./md-authority";
import { parsePayload } from "./payload";

/** Revalidate an ALREADY CONSUMED MD admission from persistence, never from a
 * caller-supplied admission/digest/UID. Reads use the same lock order and MD
 * authority checks as admission. No state mutation, signature or external I/O.
 * An indeterminate/acknowledged effect is observation-only, not new submission.
 */
/** Revalidate an ALREADY CONSUMED MD admission from persistence, never from a
 * caller-supplied admission/digest/UID. Reads use the same lock order and MD
 * authority checks as admission. No state mutation, signature or external I/O.
 * An indeterminate/acknowledged effect is observation-only, not new submission.
 */
export async function readMdSubmissionAuthority(
  store: EffectReconciliationContext,
  input: MdSubmissionAuthorityInput,
): Promise<MdSubmissionAuthority> {
  return (await withMdSubmissionAuthority(store, input, async () => undefined)).authority;
}

/** Persist once under the same authority locks. Nothing may be signed/sent
 * until this returns a committed created=true delivery. Duplicate calls only
 * recover the immutable bytes; they do NOT authorize resubmission.
 */
/** Persist once under the same authority locks. Nothing may be signed/sent
 * until this returns a committed created=true delivery. Duplicate calls only
 * recover the immutable bytes; they do NOT authorize resubmission.
 */
export async function prepareMdSubmissionDelivery(
  store: EffectReconciliationContext,
  input: MdSubmissionAuthorityInput,
  principalValue: MdDeliveryPrincipal,
  build: (authority: MdSubmissionAuthority) => MdDeliveryDraft,
): Promise<{ delivery: MdEffectDelivery; created: boolean }> {
  const principal = MdDeliveryPrincipalSchema.parse(principalValue);
  return (
    await withMdSubmissionAuthority(store, input, (authority, tx) =>
      freezeMdEffectDelivery(tx, authority, principal, store.database._provider, build),
    )
  ).value;
}

/** Live submit revalidation of the EXACT committed delivery. This is not a
 * one-shot signing permit: only the creator's in-flight Head call may use it
 * for submit. Replays/restarts must use the historical observe reader instead.
 */
/** Live submit revalidation of the EXACT committed delivery. This is not a
 * one-shot signing permit: only the creator's in-flight Head call may use it
 * for submit. Replays/restarts must use the historical observe reader instead.
 */
export async function readMdDeliverySigningAuthority(
  store: EffectReconciliationContext,
  input: MdSubmissionAuthorityInput,
  principalValue: MdDeliveryPrincipal,
): Promise<{ authority: MdSubmissionAuthority; delivery: MdEffectDelivery }> {
  const principal = MdDeliveryPrincipalSchema.parse(principalValue);
  const result = await withMdSubmissionAuthority(store, input, async (authority, tx) => {
    await assertMdDeliveryProjectAccess(
      tx,
      authority.mission,
      principal,
      store.database._provider,
      "submit",
    );
    const delivery = await readMdEffectDelivery(tx, authority.operation);
    if (!delivery || canonicalJson(delivery.principal) !== canonicalJson(principal))
      throw new ScientificIntegrityError("Signing requires the exact committed MD delivery");
    if (Date.parse(delivery.expiresAt) <= Date.parse(authority.checkedAt))
      throw new ScientificIntegrityError("Frozen MD delivery has expired");
    return delivery;
  });
  if (Date.parse(result.value.expiresAt) <= Date.parse(result.authority.checkedAt))
    throw new ScientificIntegrityError("Frozen MD delivery expired before signing");
  return { authority: result.authority, delivery: result.value };
}

/** Historical transport recovery remains available after scientific lease/
 * approval expiry, but only to the currently authorized mission owner/project.
 * This never returns permission to submit. Site epoch/UID policy is additional.
 */
/** Historical transport recovery remains available after scientific lease/
 * approval expiry, but only to the currently authorized mission owner/project.
 * This never returns permission to submit. Site epoch/UID policy is additional.
 */
export async function readMdSubmissionDelivery(
  store: EffectReconciliationContext,
  operationIdValue: string,
  principalValue: MdDeliveryPrincipal,
): Promise<MdEffectDelivery | null> {
  const operationId = IdSchema.parse(operationIdValue);
  const principal = MdDeliveryPrincipalSchema.parse(principalValue);
  return store.inTransaction("read MD delivery", async (tx) => {
    const operation = parsePayload(
      ExternalOperationSchema,
      await store.requiredRow(tx, "scientific_external_operations", operationId, "operation", true),
      "MD operation",
    );
    const missionRow = await store.requiredRow(
      tx,
      "scientific_missions",
      operation.missionId,
      "mission",
      true,
    );
    const mission = parsePayload(ScientificMissionSchema, missionRow, "MD mission");
    if (
      operation.id !== operationId ||
      mission.id !== operation.missionId ||
      missionRow.payload_digest !== digestCanonical(mission)
    )
      throw new ScientificIntegrityError("MD delivery owner is outside its exact durable mission");
    await assertMdDeliveryProjectAccess(
      tx,
      mission,
      principal,
      store.database._provider,
      "observe",
    );
    const delivery = await readMdEffectDelivery(tx, operation);
    if (delivery && canonicalJson(delivery.principal) !== canonicalJson(principal))
      throw new ScientificIntegrityError(
        "MD delivery belongs to a different user/project/UID/site",
      );
    return delivery;
  });
}
