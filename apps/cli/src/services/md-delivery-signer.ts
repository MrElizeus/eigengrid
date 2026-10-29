import { createPrivateKey, randomUUID } from "node:crypto";
import { z } from "zod";
import { DigestSchema, IdSchema, canonicalJson } from "@eigengrid/scientific-schema";
import {
  MdDeliveryPrincipalSchema,
  ScientificEffectReconciliationStore,
  effectDeliveryBody,
  type MdDeliveryDraft,
  type MdEffectDelivery,
  type MdSubmissionAuthority,
  type ScientificDatabase,
} from "@eigengrid/mission-runtime";
import {
  signSubmitterCapability,
  signSubmitterAccountingCapability,
  type SubmitterCapability,
  type SubmitterAccountingCapability,
} from "@eigengrid/slurm";
import { createAmberSlurmDeliveryDraft, parseAmberSlurmDelivery } from "./amber-slurm-delivery";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u);
/** Resolved by protected server-side configuration, never supplied by a request.
 * The site must store epochs/membership generations outside the restored DB.
 */
export const HeadMdSubmitterGrantSchema = z
  .object({
    principal: MdDeliveryPrincipalSchema,
    recoveryEpoch: identifier,
    membershipGeneration: z.number().int().positive().safe(),
    currentPolicyDigest: DigestSchema,
  })
  .strict();
export type HeadMdSubmitterGrant = z.infer<typeof HeadMdSubmitterGrantSchema>;
export interface PreparedMdCapability {
  action: "submit" | "observe";
  delivery: MdEffectDelivery;
  capability: SubmitterCapability;
  wire: Uint8Array;
}
export interface PreparedMdAccountingCapability {
  action: "accounting";
  delivery: MdEffectDelivery;
  capability: SubmitterAccountingCapability;
  wire: Uint8Array;
}

/** Internal Head authority bridge. Not an HTTP/model API, not an independent
 * executor: it never mutates attempts or calls Slurm. The coordinator consumes
 * its wire through callSubmitter once and owns receipts/reconciliation.
 * Production PG is mandatory; no SQLite fallback. No private key leaves Head.
 */
export class HeadMdDeliverySigner {
  private readonly effects: ScientificEffectReconciliationStore;
  readonly #privateKeyPem: string;
  constructor(
    database: ScientificDatabase,
    private readonly resolveCurrentGrant: () => HeadMdSubmitterGrant,
    private readonly buildBody: (
      authority: MdSubmissionAuthority,
      grant: HeadMdSubmitterGrant,
    ) => unknown,
    privateKeyPem: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (database._provider !== "postgres")
      throw new Error("Production MD signing requires PostgreSQL");
    if (createPrivateKey(privateKeyPem).asymmetricKeyType !== "ed25519")
      throw new Error("Head MD signing requires an Ed25519 private key");
    this.#privateKeyPem = privateKeyPem;
    this.effects = new ScientificEffectReconciliationStore(database, now);
  }

  private grant(): HeadMdSubmitterGrant {
    return HeadMdSubmitterGrantSchema.parse(this.resolveCurrentGrant());
  }

  private clock(): number {
    const at = this.now().getTime();
    if (!Number.isSafeInteger(at) || at <= 0) throw new Error("Invalid Head signing clock");
    return at;
  }

  /** Only this call's successful INSERT/COMMIT may reach first submit signing.
   * Existing deliveries, including lost-ACK/crash recovery, are observe-only.
   * A failure is never permission to mint a replacement delivery or resubmit.
   */
  async prepare(inputValue: {
    operationId: string;
    claimOwner: string;
  }): Promise<PreparedMdCapability> {
    const operationId = IdSchema.parse(inputValue.operationId);
    const claimOwner = IdSchema.parse(inputValue.claimOwner);
    const grant = this.grant();
    const existing = await this.effects.readMdSubmissionDelivery(operationId, grant.principal);
    if (existing) return this.signObservation(existing);
    const input = { operationId, claimOwner, currentPolicyDigest: grant.currentPolicyDigest };
    const prepared = await this.effects.prepareMdSubmissionDelivery(
      input,
      grant.principal,
      (authority): MdDeliveryDraft =>
        createAmberSlurmDeliveryDraft(
          authority,
          grant.principal,
          this.buildBody(structuredClone(authority), structuredClone(grant)),
        ),
    );
    if (!prepared.created) return this.signObservation(prepared.delivery);
    // Revalidate BOTH scientific authority and project access after durable commit.
    const fresh = await this.effects.readMdDeliverySigningAuthority(input, grant.principal);
    if (canonicalJson(fresh.delivery) !== canonicalJson(prepared.delivery))
      throw new Error("Committed MD delivery changed before signing");
    const current = this.grant();
    if (canonicalJson(current) !== canonicalJson(grant))
      throw new Error("Site authority changed before first MD signature");
    return this.sign(
      "submit",
      fresh.delivery,
      current,
      Date.parse(fresh.authority.checkedAt),
      Date.parse(fresh.authority.expiresAt),
    );
  }

  async observe(operationIdValue: string): Promise<PreparedMdCapability> {
    const operationId = IdSchema.parse(operationIdValue);
    const grant = this.grant();
    const delivery = await this.effects.readMdSubmissionDelivery(operationId, grant.principal);
    if (!delivery) throw new Error("No committed MD delivery exists to observe");
    return this.signObservation(delivery);
  }

  /** Read authority for historical effects, with current DB and site access.
   * No new delivery, admission, claim, or scientific lease is acquired. */
  async accounting(operationIdValue: string): Promise<PreparedMdAccountingCapability> {
    const operationId = IdSchema.parse(operationIdValue);
    const checkedAt = this.clock();
    const grant = this.grant();
    const delivery = await this.effects.readMdSubmissionDelivery(operationId, grant.principal);
    if (!delivery) throw new Error("No committed MD delivery exists for accounting");
    parseAmberSlurmDelivery(delivery);
    const latest = this.grant();
    if (
      canonicalJson(latest) !== canonicalJson(grant) ||
      canonicalJson(delivery.principal) !== canonicalJson(grant.principal)
    )
      throw new Error("MD accounting principal or site authority changed");
    const notBeforeMs = this.clock();
    if (notBeforeMs < Math.max(checkedAt, Date.parse(delivery.notBefore)))
      throw new Error("MD accounting clock regressed");
    const { capability, wire } = signSubmitterAccountingCapability(
      {
        action: "accounting",
        requestId: randomUUID(),
        ...grant.principal,
        recoveryEpoch: grant.recoveryEpoch,
        membershipGeneration: grant.membershipGeneration,
        operationId: delivery.operationId,
        requestDigest: delivery.requestDigest,
        admissionDigest: delivery.admissionDigest,
        bindingDigest: delivery.bindingDigest,
        fencingGeneration: delivery.fencingGeneration,
        notBeforeMs,
        expiresAtMs: notBeforeMs + 60_000,
      },
      effectDeliveryBody(delivery),
      this.#privateKeyPem,
    );
    const signedAt = this.clock();
    if (
      signedAt < notBeforeMs ||
      signedAt >= capability.expiresAtMs ||
      capability.bodyDigest !== delivery.bodyDigest
    )
      throw new Error("MD accounting authority expired or changed while signing");
    return { action: "accounting", delivery, capability, wire };
  }

  private async signObservation(delivery: MdEffectDelivery): Promise<PreparedMdCapability> {
    const startedAt = this.clock();
    const grant = this.grant();
    // A replay might have waited behind the creator; read current access again.
    const current = await this.effects.readMdSubmissionDelivery(
      delivery.operationId,
      grant.principal,
    );
    if (!current || canonicalJson(current) !== canonicalJson(delivery))
      throw new Error("MD observation is outside its current project authority");
    const latest = this.grant();
    if (canonicalJson(latest.principal) !== canonicalJson(grant.principal))
      throw new Error("MD observation principal changed");
    return this.sign("observe", current, latest, startedAt);
  }

  private sign(
    action: "submit" | "observe",
    delivery: MdEffectDelivery,
    grant: HeadMdSubmitterGrant,
    checkedAt: number,
    authorityExpiry?: number,
  ): PreparedMdCapability {
    parseAmberSlurmDelivery(delivery);
    if (canonicalJson(delivery.principal) !== canonicalJson(grant.principal))
      throw new Error("MD signature principal differs from frozen delivery");
    const notBeforeMs = this.clock();
    const expiresAtMs =
      action === "submit"
        ? Math.min(Date.parse(delivery.expiresAt), authorityExpiry ?? 0, notBeforeMs + 60_000)
        : notBeforeMs + 60_000;
    if (
      notBeforeMs < Math.max(checkedAt, Date.parse(delivery.notBefore)) ||
      expiresAtMs <= notBeforeMs
    )
      throw new Error("MD capability window expired or clock regressed");
    const { capability, wire } = signSubmitterCapability(
      {
        action,
        requestId: randomUUID(),
        ...grant.principal,
        recoveryEpoch: grant.recoveryEpoch,
        membershipGeneration: grant.membershipGeneration,
        operationId: delivery.operationId,
        requestDigest: delivery.requestDigest,
        admissionDigest: delivery.admissionDigest,
        bindingDigest: delivery.bindingDigest,
        fencingGeneration: delivery.fencingGeneration,
        notBeforeMs,
        expiresAtMs,
      },
      effectDeliveryBody(delivery),
      this.#privateKeyPem,
    );
    const signedAt = this.clock();
    if (
      signedAt < notBeforeMs ||
      signedAt >= expiresAtMs ||
      capability.bodyDigest !== delivery.bodyDigest
    )
      throw new Error("MD authority expired or changed while signing");
    return { action, delivery, capability, wire };
  }
}
