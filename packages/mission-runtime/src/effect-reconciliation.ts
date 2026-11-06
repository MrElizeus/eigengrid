import {
  type MdDeliveryDraft,
  type MdDeliveryPrincipal,
  type MdEffectDelivery,
} from "./effect-delivery";
import { beginWorkUnitEffect } from "./effect-reconciliation/admission";
import { EffectReconciliationContext } from "./effect-reconciliation/context";
import {
  type BeginWorkUnitEffectInput,
  type BeginWorkUnitEffectResult,
  type MdSubmissionAuthority,
  type MdSubmissionAuthorityInput,
  type ReconcileWorkUnitEffectInput,
  type ReconcileWorkUnitEffectResult,
  type ScientificEffectPersistence,
} from "./effect-reconciliation/contracts";
import {
  prepareMdSubmissionDelivery,
  readMdDeliverySigningAuthority,
  readMdSubmissionAuthority,
  readMdSubmissionDelivery,
} from "./effect-reconciliation/md-delivery";
import { reconcileWorkUnitEffect } from "./effect-reconciliation/reconciliation";
import type { ScientificDatabase } from "./types";
export type {
  BeginWorkUnitEffectInput,
  BeginWorkUnitEffectResult,
  MdSubmissionAuthority,
  MdSubmissionAuthorityInput,
  ReconciledEffectOutcome,
  ReconcileWorkUnitEffectInput,
  ReconcileWorkUnitEffectResult,
  ScientificEffectPersistence,
  ScientificEffectReconciler,
} from "./effect-reconciliation/contracts";
export { assertApprovedSystemBuildDecisionReferences } from "./effect-reconciliation/system-build-evidence";
export {
  assertApprovedSystemPreparationOperation,
  assertTypedSystemPreparationIntent,
} from "./effect-reconciliation/system-preparation";

/** Stable facade; state and complete lifecycle operations live in domain modules. */
/**
 * Persistence-owned effect boundary. It atomically binds a claimed WorkUnit to
 * the exact persisted operation identity before the canonical coordinator is
 * called, and later settles expired/in-flight leases only from an exact durable
 * receipt. Models, skills, and protocol content never receive this capability.
 */
export class ScientificEffectReconciliationStore implements ScientificEffectPersistence {
  private readonly context: EffectReconciliationContext;
  constructor(database: ScientificDatabase, now: () => Date = () => new Date()) {
    this.context = new EffectReconciliationContext(database, now);
  }

  /** Revalidate an ALREADY CONSUMED MD admission from persistence, never from a
   * caller-supplied admission/digest/UID. Reads use the same lock order and MD
   * authority checks as admission. No state mutation, signature or external I/O.
   * An indeterminate/acknowledged effect is observation-only, not new submission.
   */
  async readMdSubmissionAuthority(
    input: MdSubmissionAuthorityInput,
  ): Promise<MdSubmissionAuthority> {
    return readMdSubmissionAuthority(this.context, input);
  }

  /** Persist once under the same authority locks. Nothing may be signed/sent
   * until this returns a committed created=true delivery. Duplicate calls only
   * recover the immutable bytes; they do NOT authorize resubmission.
   */
  async prepareMdSubmissionDelivery(
    input: MdSubmissionAuthorityInput,
    principalValue: MdDeliveryPrincipal,
    build: (authority: MdSubmissionAuthority) => MdDeliveryDraft,
  ): Promise<{ delivery: MdEffectDelivery; created: boolean }> {
    return prepareMdSubmissionDelivery(this.context, input, principalValue, build);
  }

  /** Live submit revalidation of the EXACT committed delivery. This is not a
   * one-shot signing permit: only the creator's in-flight Head call may use it
   * for submit. Replays/restarts must use the historical observe reader instead.
   */
  async readMdDeliverySigningAuthority(
    input: MdSubmissionAuthorityInput,
    principalValue: MdDeliveryPrincipal,
  ): Promise<{ authority: MdSubmissionAuthority; delivery: MdEffectDelivery }> {
    return readMdDeliverySigningAuthority(this.context, input, principalValue);
  }

  /** Historical transport recovery remains available after scientific lease/
   * approval expiry, but only to the currently authorized mission owner/project.
   * This never returns permission to submit. Site epoch/UID policy is additional.
   */
  async readMdSubmissionDelivery(
    operationIdValue: string,
    principalValue: MdDeliveryPrincipal,
  ): Promise<MdEffectDelivery | null> {
    return readMdSubmissionDelivery(this.context, operationIdValue, principalValue);
  }

  async beginWorkUnitEffect(input: BeginWorkUnitEffectInput): Promise<BeginWorkUnitEffectResult> {
    return beginWorkUnitEffect(this.context, input);
  }

  async reconcileWorkUnitEffect(
    input: ReconcileWorkUnitEffectInput,
  ): Promise<ReconcileWorkUnitEffectResult> {
    return reconcileWorkUnitEffect(this.context, input);
  }
}
