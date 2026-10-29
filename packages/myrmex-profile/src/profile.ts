import {
  MyrmexOperationReceiptSchema,
  PublicCompatibilitySchema,
  PublicSubjectSchema,
  canonicalPublicJson,
  computeMyrmexReceiptDigest,
  createMyrmexOperationRequest,
  publicDigest,
  verifyMyrmexOperationRequest,
  type MyrmexOperationBroker,
  type MyrmexOperationReceipt,
  type MyrmexOperationRequest,
  type PublicCompatibility,
  type PublicDigest,
  type PublicSubject,
} from "@eigengrid/protocol";
import type { ZodType } from "zod";

import { MyrmexProfileIdempotencyError, type MyrmexProfileLedger } from "./ledger";
import {
  BackupCreatePayloadSchema,
  EvidenceExportPayloadSchema,
  MYRMEX_PROFILE_FEATURES,
  MYRMEX_PROFILE_OPERATIONS,
  MYRMEX_PROFILE_VERSION,
  MaintenancePayloadSchema,
  MyrmexCompatibilityStatusResultSchema,
  MyrmexStatusResultSchema,
  MissionApprovalDecisionPayloadSchema,
  MissionCreatePayloadSchema,
  MissionInputPayloadSchema,
  MissionLifecyclePayloadSchema,
  RedactedIncidentBundlePayloadSchema,
  RedactedIncidentBundleResultSchema,
  UpgradeTargetSchema,
  type BackupCreatePayload,
  type EvidenceExportPayload,
  type MaintenancePayload,
  type MissionApprovalDecisionPayload,
  type MissionCreatePayload,
  type MissionInputPayload,
  type MissionLifecyclePayload,
  type MyrmexCompatibilityStatusResult,
  type MyrmexProfileOperation,
  type MyrmexStatusResult,
  type RedactedIncidentBundlePayload,
  type RedactedIncidentBundleResult,
  type UpgradeTarget,
} from "./operations";

export type MyrmexAuthorityEvidence = MyrmexOperationRequest["authorityEvidence"][number];
export type ApprovedAuthorityEvidence = readonly [
  MyrmexAuthorityEvidence,
  ...MyrmexAuthorityEvidence[],
];
export type MyrmexPublicV1Broker = Pick<MyrmexOperationBroker, "handle" | "reconcile">;
type MyrmexUnconfirmedReceiptState = Exclude<MyrmexOperationReceipt["state"], "confirmed">;
export type MyrmexResultReceipt<T> =
  | (Omit<MyrmexOperationReceipt, "result" | "state"> & {
      readonly state: "confirmed";
      readonly result: T;
    })
  | (Omit<MyrmexOperationReceipt, "result" | "state"> & {
      readonly state: MyrmexUnconfirmedReceiptState;
      readonly result: null;
    });

function deepFreezeProfileReplay<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreezeProfileReplay(child);
  }
  return Object.freeze(value);
}

export interface MyrmexProfileCallOptions {
  readonly idempotencyKey: string;
  readonly runId: string;
  readonly expiresAt?: string;
  readonly signal?: AbortSignal;
}

export interface ApprovedMyrmexProfileCallOptions extends MyrmexProfileCallOptions {
  readonly authorityEvidence: ApprovedAuthorityEvidence;
}

export interface MyrmexProfileConfig {
  readonly installationId: string;
  readonly principalId: string;
  readonly compatibility: PublicCompatibility;
  readonly broker: MyrmexPublicV1Broker;
  readonly ledger: MyrmexProfileLedger;
  readonly now?: () => Date;
  readonly requestId?: () => string;
  readonly defaultTtlMs?: number;
}

export class MyrmexProfileCompatibilityError extends Error {
  readonly name = "MyrmexProfileCompatibilityError";

  constructor(
    readonly code:
      | "INVALID_PROFILE_COMPATIBILITY"
      | "MISSING_PROFILE_FEATURE"
      | "RECEIPT_COMPATIBILITY_MISMATCH",
    readonly field: string,
    readonly receipt?: MyrmexOperationReceipt,
  ) {
    super(`Myrmex profile compatibility check failed at ${field}`);
  }
}

export class MyrmexProfileAuthorizationError extends Error {
  readonly name = "MyrmexProfileAuthorizationError";
  readonly code = "AUTHORITY_EVIDENCE_REQUIRED";

  constructor(readonly operation: MyrmexProfileOperation) {
    super(`Myrmex operation requires explicit authority evidence: ${operation}`);
  }
}

export class MyrmexProfileReceiptError extends Error {
  readonly name = "MyrmexProfileReceiptError";
  readonly code = "INVALID_PUBLIC_RECEIPT";

  constructor(readonly field: string) {
    super(`Invalid eigengrid.public.v1 receipt at ${field}`);
  }
}

interface OperationInvocation {
  readonly operation: MyrmexProfileOperation;
  readonly subject: PublicSubject;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly authorityEvidence: readonly MyrmexAuthorityEvidence[];
  readonly options: MyrmexProfileCallOptions;
  readonly requiredFeatures: readonly string[];
}

interface InFlightInvocation {
  readonly intentDigest: PublicDigest;
  promise: Promise<MyrmexOperationReceipt>;
}

export class MyrmexProfile {
  readonly compatibility: PublicCompatibility;
  private readonly installationId: string;
  private readonly principalId: string;
  private readonly broker: MyrmexPublicV1Broker;
  private readonly ledger: MyrmexProfileLedger;
  private readonly now: () => Date;
  private readonly requestId: () => string;
  private readonly defaultTtlMs: number;
  private readonly inFlight = new Map<string, InFlightInvocation>();

  constructor(config: MyrmexProfileConfig) {
    const compatibility = PublicCompatibilitySchema.parse(config.compatibility);
    if (compatibility.profileVersion !== MYRMEX_PROFILE_VERSION) {
      throw new MyrmexProfileCompatibilityError("INVALID_PROFILE_COMPATIBILITY", "profileVersion");
    }
    if (!config.installationId || !config.principalId) {
      throw new TypeError("Myrmex profile installationId and principalId are required");
    }
    if (
      !config.broker ||
      typeof config.broker.handle !== "function" ||
      typeof config.broker.reconcile !== "function"
    ) {
      throw new TypeError(
        "Myrmex profile requires an eigengrid.public.v1 broker with explicit reconciliation",
      );
    }
    if (
      !config.ledger ||
      typeof config.ledger.get !== "function" ||
      typeof config.ledger.putRequest !== "function" ||
      typeof config.ledger.putReceipt !== "function"
    ) {
      throw new TypeError("Myrmex profile requires an atomic request/receipt ledger");
    }

    const ttl = config.defaultTtlMs ?? 5 * 60_000;
    if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > 60 * 60_000) {
      throw new RangeError("Myrmex profile defaultTtlMs must be between 1 ms and 1 hour");
    }

    this.compatibility = deepFreezeProfileReplay({
      ...compatibility,
      featureFlags: [...compatibility.featureFlags],
    });
    this.installationId = config.installationId;
    this.principalId = config.principalId;
    this.broker = config.broker;
    this.ledger = config.ledger;
    this.now = config.now ?? (() => new Date());
    this.requestId = config.requestId ?? (() => globalThis.crypto.randomUUID());
    this.defaultTtlMs = ttl;
  }

  readCompatibilityStatus(
    subject: PublicSubject,
    options: MyrmexProfileCallOptions,
  ): Promise<MyrmexResultReceipt<MyrmexCompatibilityStatusResult>> {
    return this.withTypedResult(
      this.readOnly(MYRMEX_PROFILE_OPERATIONS.compatibilityStatus, subject, {}, options),
      MyrmexCompatibilityStatusResultSchema,
    );
  }

  readMissionStatus(
    subject: PublicSubject,
    options: MyrmexProfileCallOptions,
  ): Promise<MyrmexResultReceipt<MyrmexStatusResult>> {
    return this.withTypedResult(
      this.readOnly(MYRMEX_PROFILE_OPERATIONS.missionStatus, subject, {}, options),
      MyrmexStatusResultSchema,
    );
  }

  readJobStatus(
    subject: PublicSubject,
    options: MyrmexProfileCallOptions,
  ): Promise<MyrmexResultReceipt<MyrmexStatusResult>> {
    return this.withTypedResult(
      this.readOnly(MYRMEX_PROFILE_OPERATIONS.jobStatus, subject, {}, options),
      MyrmexStatusResultSchema,
    );
  }

  readApprovalStatus(
    subject: PublicSubject,
    options: MyrmexProfileCallOptions,
  ): Promise<MyrmexResultReceipt<MyrmexStatusResult>> {
    return this.withTypedResult(
      this.readOnly(MYRMEX_PROFILE_OPERATIONS.approvalStatus, subject, {}, options),
      MyrmexStatusResultSchema,
    );
  }

  exportEvidence(
    subject: PublicSubject,
    payload: EvidenceExportPayload,
    options: MyrmexProfileCallOptions,
  ): Promise<MyrmexOperationReceipt> {
    return this.readOnly(
      MYRMEX_PROFILE_OPERATIONS.evidenceExport,
      subject,
      EvidenceExportPayloadSchema.parse(payload),
      options,
    );
  }

  requestRedactedIncidentBundle(
    subject: PublicSubject,
    payload: RedactedIncidentBundlePayload,
    options: MyrmexProfileCallOptions,
  ): Promise<MyrmexResultReceipt<RedactedIncidentBundleResult>> {
    return this.withTypedResult(
      this.invoke({
        operation: MYRMEX_PROFILE_OPERATIONS.incidentBundle,
        subject: PublicSubjectSchema.parse(subject),
        payload: RedactedIncidentBundlePayloadSchema.parse(payload),
        authorityEvidence: [],
        options,
        requiredFeatures: [MYRMEX_PROFILE_FEATURES.read, MYRMEX_PROFILE_FEATURES.incidentRedaction],
      }),
      RedactedIncidentBundleResultSchema,
    );
  }

  createMission(
    subject: PublicSubject,
    payload: MissionCreatePayload,
    options: ApprovedMyrmexProfileCallOptions,
  ): Promise<MyrmexOperationReceipt> {
    return this.approvedMission(
      MYRMEX_PROFILE_OPERATIONS.missionCreate,
      subject,
      MissionCreatePayloadSchema.parse(payload),
      options,
    );
  }

  submitMissionInput(
    subject: PublicSubject,
    payload: MissionInputPayload,
    options: ApprovedMyrmexProfileCallOptions,
  ): Promise<MyrmexOperationReceipt> {
    return this.approvedMission(
      MYRMEX_PROFILE_OPERATIONS.missionInputSubmit,
      subject,
      MissionInputPayloadSchema.parse(payload),
      options,
    );
  }

  decideMissionApproval(
    subject: PublicSubject,
    payload: MissionApprovalDecisionPayload,
    options: ApprovedMyrmexProfileCallOptions,
  ): Promise<MyrmexOperationReceipt> {
    return this.approvedMission(
      MYRMEX_PROFILE_OPERATIONS.missionApprovalDecide,
      subject,
      MissionApprovalDecisionPayloadSchema.parse(payload),
      options,
    );
  }

  startMission(
    subject: PublicSubject,
    payload: MissionLifecyclePayload,
    options: ApprovedMyrmexProfileCallOptions,
  ): Promise<MyrmexOperationReceipt> {
    return this.approvedMission(
      MYRMEX_PROFILE_OPERATIONS.missionStart,
      subject,
      MissionLifecyclePayloadSchema.parse(payload),
      options,
    );
  }

  pauseMission(
    subject: PublicSubject,
    payload: MissionLifecyclePayload,
    options: ApprovedMyrmexProfileCallOptions,
  ): Promise<MyrmexOperationReceipt> {
    return this.approvedMission(
      MYRMEX_PROFILE_OPERATIONS.missionPause,
      subject,
      MissionLifecyclePayloadSchema.parse(payload),
      options,
    );
  }

  resumeMission(
    subject: PublicSubject,
    payload: MissionLifecyclePayload,
    options: ApprovedMyrmexProfileCallOptions,
  ): Promise<MyrmexOperationReceipt> {
    return this.approvedMission(
      MYRMEX_PROFILE_OPERATIONS.missionResume,
      subject,
      MissionLifecyclePayloadSchema.parse(payload),
      options,
    );
  }

  cancelMission(
    subject: PublicSubject,
    payload: MissionLifecyclePayload,
    options: ApprovedMyrmexProfileCallOptions,
  ): Promise<MyrmexOperationReceipt> {
    return this.approvedMission(
      MYRMEX_PROFILE_OPERATIONS.missionCancel,
      subject,
      MissionLifecyclePayloadSchema.parse(payload),
      options,
    );
  }

  createBackup(
    subject: PublicSubject,
    payload: BackupCreatePayload,
    options: ApprovedMyrmexProfileCallOptions,
  ): Promise<MyrmexOperationReceipt> {
    return this.approvedAdmin(
      MYRMEX_PROFILE_OPERATIONS.backupCreate,
      subject,
      BackupCreatePayloadSchema.parse(payload),
      options,
    );
  }

  setMaintenanceMode(
    subject: PublicSubject,
    payload: MaintenancePayload,
    options: ApprovedMyrmexProfileCallOptions,
  ): Promise<MyrmexOperationReceipt> {
    return this.approvedAdmin(
      MYRMEX_PROFILE_OPERATIONS.maintenanceSet,
      subject,
      MaintenancePayloadSchema.parse(payload),
      options,
    );
  }

  validateUpgrade(
    subject: PublicSubject,
    payload: UpgradeTarget,
    options: ApprovedMyrmexProfileCallOptions,
  ): Promise<MyrmexOperationReceipt> {
    return this.approvedUpgrade(
      MYRMEX_PROFILE_OPERATIONS.upgradeValidate,
      subject,
      payload,
      options,
    );
  }

  applyUpgrade(
    subject: PublicSubject,
    payload: UpgradeTarget,
    options: ApprovedMyrmexProfileCallOptions,
  ): Promise<MyrmexOperationReceipt> {
    return this.approvedUpgrade(MYRMEX_PROFILE_OPERATIONS.upgradeApply, subject, payload, options);
  }

  verifyUpgrade(
    subject: PublicSubject,
    payload: UpgradeTarget,
    options: ApprovedMyrmexProfileCallOptions,
  ): Promise<MyrmexOperationReceipt> {
    return this.approvedUpgrade(MYRMEX_PROFILE_OPERATIONS.upgradeVerify, subject, payload, options);
  }

  promoteUpgrade(
    subject: PublicSubject,
    payload: UpgradeTarget,
    options: ApprovedMyrmexProfileCallOptions,
  ): Promise<MyrmexOperationReceipt> {
    return this.approvedUpgrade(
      MYRMEX_PROFILE_OPERATIONS.upgradePromote,
      subject,
      payload,
      options,
    );
  }

  rollbackUpgrade(
    subject: PublicSubject,
    payload: UpgradeTarget,
    options: ApprovedMyrmexProfileCallOptions,
  ): Promise<MyrmexOperationReceipt> {
    return this.approvedUpgrade(
      MYRMEX_PROFILE_OPERATIONS.upgradeRollback,
      subject,
      payload,
      options,
    );
  }

  private readOnly(
    operation: MyrmexProfileOperation,
    subject: PublicSubject,
    payload: Readonly<Record<string, unknown>>,
    options: MyrmexProfileCallOptions,
  ): Promise<MyrmexOperationReceipt> {
    return this.invoke({
      operation,
      subject: PublicSubjectSchema.parse(subject),
      payload,
      authorityEvidence: [],
      options,
      requiredFeatures: [MYRMEX_PROFILE_FEATURES.read],
    });
  }

  private approvedMission(
    operation: MyrmexProfileOperation,
    subject: PublicSubject,
    payload: Readonly<Record<string, unknown>>,
    options: ApprovedMyrmexProfileCallOptions,
  ): Promise<MyrmexOperationReceipt> {
    return this.approved(operation, subject, payload, options, [MYRMEX_PROFILE_FEATURES.mission]);
  }

  private approvedAdmin(
    operation: MyrmexProfileOperation,
    subject: PublicSubject,
    payload: Readonly<Record<string, unknown>>,
    options: ApprovedMyrmexProfileCallOptions,
  ): Promise<MyrmexOperationReceipt> {
    return this.approved(operation, subject, payload, options, [MYRMEX_PROFILE_FEATURES.admin]);
  }

  private approvedUpgrade(
    operation: MyrmexProfileOperation,
    subject: PublicSubject,
    payload: UpgradeTarget,
    options: ApprovedMyrmexProfileCallOptions,
  ): Promise<MyrmexOperationReceipt> {
    return this.approved(operation, subject, UpgradeTargetSchema.parse(payload), options, [
      MYRMEX_PROFILE_FEATURES.admin,
      MYRMEX_PROFILE_FEATURES.upgrade,
    ]);
  }

  private approved(
    operation: MyrmexProfileOperation,
    subject: PublicSubject,
    payload: Readonly<Record<string, unknown>>,
    options: ApprovedMyrmexProfileCallOptions,
    requiredFeatures: readonly string[],
  ): Promise<MyrmexOperationReceipt> {
    if (options.authorityEvidence.length === 0) {
      return Promise.reject(new MyrmexProfileAuthorizationError(operation));
    }
    return this.invoke({
      operation,
      subject: PublicSubjectSchema.parse(subject),
      payload,
      authorityEvidence: [...options.authorityEvidence],
      options,
      requiredFeatures,
    });
  }

  private invoke(invocation: OperationInvocation): Promise<MyrmexOperationReceipt> {
    this.assertFeatures(invocation.operation, invocation.requiredFeatures);
    const key = `${this.installationId}:${invocation.options.idempotencyKey}`;
    const intentDigest = this.computeIntentDigest({
      installationId: this.installationId,
      principalId: this.principalId,
      runId: invocation.options.runId,
      operation: invocation.operation,
      compatibility: this.compatibility,
      subject: invocation.subject,
      payload: invocation.payload,
      authorityEvidence: invocation.authorityEvidence,
    });

    const active = this.inFlight.get(key);
    if (active) {
      if (active.intentDigest !== intentDigest) {
        return Promise.reject(new MyrmexProfileIdempotencyError(key));
      }
      return active.promise;
    }

    const entry: InFlightInvocation = {
      intentDigest,
      promise: this.invokeOnce(key, intentDigest, invocation),
    };
    entry.promise = entry.promise.finally(() => {
      if (this.inFlight.get(key) === entry) this.inFlight.delete(key);
    });
    this.inFlight.set(key, entry);
    return entry.promise;
  }

  private async invokeOnce(
    key: string,
    intentDigest: PublicDigest,
    invocation: OperationInvocation,
  ): Promise<MyrmexOperationReceipt> {
    let stored = await this.ledger.get(key);
    let requiresReconciliation = false;
    if (stored && stored.intentDigest !== intentDigest) {
      throw new MyrmexProfileIdempotencyError(key);
    }

    let request: MyrmexOperationRequest;
    if (stored) {
      request = this.verifyStoredRequest(key, intentDigest, stored.request);
    } else {
      const candidate = createMyrmexOperationRequest({
        requestId: this.requestId(),
        idempotencyKey: invocation.options.idempotencyKey,
        installationId: this.installationId,
        runId: invocation.options.runId,
        principalId: this.principalId,
        operation: invocation.operation,
        compatibility: this.compatibility,
        subject: invocation.subject,
        payload: invocation.payload,
        authorityEvidence: [...invocation.authorityEvidence],
        expiresAt:
          invocation.options.expiresAt ??
          new Date(this.now().getTime() + this.defaultTtlMs).toISOString(),
      });
      try {
        await this.ledger.putRequest({ key, intentDigest, request: candidate });
      } catch (error) {
        // A concurrent profile process may have won the same logical intent
        // with a different generated requestId. Re-read the atomic ledger and
        // use its exact request; a different intent still fails below.
        if (!(error instanceof MyrmexProfileIdempotencyError)) throw error;
      }
      stored = await this.ledger.get(key);
      if (!stored || stored.intentDigest !== intentDigest) {
        throw new MyrmexProfileIdempotencyError(key);
      }
      request = this.verifyStoredRequest(key, intentDigest, stored.request);
    }

    if (stored?.receipt) {
      const receipt = this.parseReceipt(request, stored.receipt);
      this.assertReceiptCompatibility(receipt);
      if (
        receipt.state !== "accepted" &&
        receipt.state !== "pending" &&
        receipt.state !== "ambiguous"
      ) {
        return receipt;
      }
      requiresReconciliation = true;
    }

    // Persisting a profile request does not prove that it reached the Head. A
    // request with no receipt therefore uses `handle`, whose public journal
    // reservation makes retries idempotent. Only an actual accepted, pending,
    // or ambiguous public receipt proves there is an operation to observe and
    // enters the reconciliation-only path.
    const rawReceipt = requiresReconciliation
      ? await this.broker.reconcile(request, invocation.options.signal)
      : await this.broker.handle(request, invocation.options.signal);
    const receipt = this.parseReceipt(request, rawReceipt);
    await this.ledger.putReceipt(key, receipt);
    const persisted = await this.ledger.get(key);
    const authoritative = persisted?.receipt
      ? this.parseReceipt(request, persisted.receipt)
      : receipt;
    this.assertReceiptCompatibility(authoritative);
    return authoritative;
  }

  private async withTypedResult<T extends Record<string, unknown>>(
    pending: Promise<MyrmexOperationReceipt>,
    schema: ZodType<T>,
  ): Promise<MyrmexResultReceipt<T>> {
    const receipt = await pending;
    if (receipt.state === "confirmed" && !schema.safeParse(receipt.result).success) {
      throw new MyrmexProfileReceiptError("result");
    }
    return receipt as MyrmexResultReceipt<T>;
  }

  private parseReceipt(
    request: MyrmexOperationRequest,
    rawReceipt: unknown,
  ): MyrmexOperationReceipt {
    const parsed = MyrmexOperationReceiptSchema.safeParse(rawReceipt);
    if (!parsed.success) throw new MyrmexProfileReceiptError("schema");
    const receipt = parsed.data;
    if (computeMyrmexReceiptDigest(receipt) !== receipt.receiptDigest) {
      throw new MyrmexProfileReceiptError("receiptDigest");
    }
    if (receipt.requestId !== request.requestId) {
      throw new MyrmexProfileReceiptError("requestId");
    }
    if (receipt.idempotencyKey !== request.idempotencyKey) {
      throw new MyrmexProfileReceiptError("idempotencyKey");
    }
    if (receipt.correlationId !== request.runId || receipt.causationId !== request.requestId) {
      throw new MyrmexProfileReceiptError("correlation");
    }
    if (canonicalPublicJson(receipt.subject) !== canonicalPublicJson(request.subject)) {
      throw new MyrmexProfileReceiptError("subject");
    }
    return deepFreezeProfileReplay(receipt);
  }

  private verifyStoredRequest(
    key: string,
    intentDigest: PublicDigest,
    rawRequest: unknown,
  ): MyrmexOperationRequest {
    const verified = verifyMyrmexOperationRequest(rawRequest);
    if (!verified.ok) throw new MyrmexProfileReceiptError("ledger.request");
    const request = verified.value;
    const storedKey = `${request.installationId}:${request.idempotencyKey}`;
    const storedIntentDigest = this.computeIntentDigest({
      installationId: request.installationId,
      principalId: request.principalId,
      runId: request.runId,
      operation: request.operation,
      compatibility: request.compatibility,
      subject: request.subject,
      payload: request.payload,
      authorityEvidence: request.authorityEvidence,
    });
    if (storedKey !== key || storedIntentDigest !== intentDigest) {
      throw new MyrmexProfileIdempotencyError(key);
    }
    return request;
  }

  private computeIntentDigest(input: {
    readonly installationId: string;
    readonly principalId: string;
    readonly runId: string;
    readonly operation: string;
    readonly compatibility: PublicCompatibility;
    readonly subject: PublicSubject;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly authorityEvidence: readonly MyrmexAuthorityEvidence[];
  }): PublicDigest {
    return publicDigest({ protocol: input.compatibility.publicProtocol, ...input });
  }

  private assertReceiptCompatibility(receipt: MyrmexOperationReceipt): void {
    if (canonicalPublicJson(receipt.compatibility) !== canonicalPublicJson(this.compatibility)) {
      throw new MyrmexProfileCompatibilityError(
        "RECEIPT_COMPATIBILITY_MISMATCH",
        "receipt.compatibility",
        receipt,
      );
    }
  }

  private assertFeatures(operation: MyrmexProfileOperation, features: readonly string[]): void {
    const available = new Set(this.compatibility.featureFlags);
    for (const feature of features) {
      if (!available.has(feature)) {
        throw new MyrmexProfileCompatibilityError(
          "MISSING_PROFILE_FEATURE",
          `${operation}:${feature}`,
        );
      }
    }
  }
}
