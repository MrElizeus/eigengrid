import { z } from "zod";

export const EFFECT_JOURNAL_SCHEMA_VERSION = 1 as const;

export const EFFECT_INTENT_STATES = [
  "pending",
  "submitted",
  "ambiguous",
  "confirmed",
  "failed",
  "cancel_requested",
  "cancelled",
] as const;
export const EffectIntentStateSchema = z.enum(EFFECT_INTENT_STATES);
export type EffectIntentState = z.infer<typeof EffectIntentStateSchema>;

export const RECONCILABLE_EFFECT_INTENT_STATES = [
  "submitted",
  "ambiguous",
  "confirmed",
  "failed",
  "cancel_requested",
  "cancelled",
] as const;
export const ReconciledEffectIntentStateSchema = z.enum(RECONCILABLE_EFFECT_INTENT_STATES);

export const StableIdentifierSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+|=-]*$/u, "Expected a stable technical identifier");

export const RequestDigestSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/u, "Expected a sha256-prefixed lower-case digest");
export type RequestDigest = z.infer<typeof RequestDigestSchema>;

export const EffectTimestampSchema = z.string().datetime({ offset: true });

export type JsonPrimitive = null | boolean | string | number;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.string(),
    z.number().finite(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ]),
);
export const JsonObjectSchema: z.ZodType<JsonObject> = z.record(JsonValueSchema);

export const EffectAggregateIdentitySchema = z
  .object({
    type: StableIdentifierSchema,
    id: StableIdentifierSchema,
  })
  .strict();
export type EffectAggregateIdentity = z.infer<typeof EffectAggregateIdentitySchema>;

export const EffectIdempotencyIdentitySchema = z
  .object({
    scope: StableIdentifierSchema,
    key: z.string().min(1).max(512).regex(/^\S+$/u, "Idempotency keys cannot contain whitespace"),
  })
  .strict();
export type EffectIdempotencyIdentity = z.infer<typeof EffectIdempotencyIdentitySchema>;

export const EffectOperationIdentitySchema = z
  .object({
    schema: z.literal("eigengrid.effect-operation-identity.v1"),
    operationId: StableIdentifierSchema,
    operationKind: StableIdentifierSchema,
    aggregate: EffectAggregateIdentitySchema,
    idempotency: EffectIdempotencyIdentitySchema,
    requestDigest: RequestDigestSchema,
    correlationId: StableIdentifierSchema,
    causationId: StableIdentifierSchema.optional(),
  })
  .strict();
export type EffectOperationIdentity = z.infer<typeof EffectOperationIdentitySchema>;

export const EFFECT_EVIDENCE_KINDS = [
  "transmission",
  "receipt",
  "ambiguity",
  "failure",
  "cancel_request",
  "reconciliation",
] as const;
export const EffectEvidenceKindSchema = z.enum(EFFECT_EVIDENCE_KINDS);

export const EffectEvidenceSchema = z
  .object({
    kind: EffectEvidenceKindSchema,
    source: StableIdentifierSchema,
    evidenceDigest: RequestDigestSchema,
    externalIdentity: JsonObjectSchema.optional(),
    detail: z.string().min(1).max(8_192).optional(),
  })
  .strict();
export type EffectEvidence = z.infer<typeof EffectEvidenceSchema>;

const EVIDENCE_BY_STATE: Readonly<
  Record<Exclude<EffectIntentState, "pending">, readonly string[]>
> = {
  submitted: ["transmission", "reconciliation"],
  ambiguous: ["ambiguity", "reconciliation"],
  confirmed: ["receipt", "reconciliation"],
  failed: ["failure", "receipt", "reconciliation"],
  cancel_requested: ["cancel_request"],
  cancelled: ["receipt", "reconciliation"],
};

function validateStateEvidence(
  state: EffectIntentState,
  evidence: EffectEvidence | undefined,
  context: z.RefinementCtx,
): void {
  if (state === "pending") {
    if (evidence !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidence"],
        message: "A pending intent cannot contain post-effect evidence",
      });
    }
    return;
  }
  if (!evidence) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidence"],
      message: `${state} requires durable evidence`,
    });
    return;
  }
  if (!EVIDENCE_BY_STATE[state].includes(evidence.kind)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidence", "kind"],
      message: `${evidence.kind} evidence cannot establish ${state}`,
    });
  }
}

export const EffectIntentSchema = z
  .object({
    schema: z.literal("eigengrid.effect-intent.v1"),
    identity: EffectOperationIdentitySchema,
    state: EffectIntentStateSchema,
    revision: z.number().int().positive(),
    createdAt: EffectTimestampSchema,
    updatedAt: EffectTimestampSchema,
    lastMutationId: StableIdentifierSchema,
    evidence: EffectEvidenceSchema.optional(),
  })
  .strict()
  .superRefine((intent, context) => {
    validateStateEvidence(intent.state, intent.evidence, context);
    if ((intent.revision === 1) !== (intent.state === "pending")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["revision"],
        message: "Only revision 1 is pending, and revision 1 must be pending",
      });
    }
    if (Date.parse(intent.updatedAt) < Date.parse(intent.createdAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["updatedAt"],
        message: "updatedAt cannot precede createdAt",
      });
    }
  });
export type EffectIntent = z.infer<typeof EffectIntentSchema>;

export const EffectOutboxEventSchema = z
  .object({
    schema: z.literal("eigengrid.effect-outbox-event.v1"),
    eventId: StableIdentifierSchema,
    eventType: z.enum(["effect.intent.recorded", "effect.intent.state_changed"]),
    sequence: z.number().int().positive(),
    operationRevision: z.number().int().positive(),
    identity: EffectOperationIdentitySchema,
    previousState: EffectIntentStateSchema.nullable(),
    state: EffectIntentStateSchema,
    occurredAt: EffectTimestampSchema,
    mutationDigest: RequestDigestSchema,
    evidenceDigest: RequestDigestSchema.optional(),
  })
  .strict();
export type EffectOutboxEvent = z.infer<typeof EffectOutboxEventSchema>;

export const EffectOperationCommitFrameSchema = z
  .object({
    schema: z.literal("eigengrid.effect-journal-operation-commit.v1"),
    sequence: z.number().int().positive(),
    mutationId: StableIdentifierSchema,
    mutationDigest: RequestDigestSchema,
    committedAt: EffectTimestampSchema,
    operation: EffectIntentSchema,
    outboxEvent: EffectOutboxEventSchema,
    frameDigest: RequestDigestSchema,
  })
  .strict();
export type EffectOperationCommitFrame = z.infer<typeof EffectOperationCommitFrameSchema>;

export const EffectOutboxAcknowledgementFrameSchema = z
  .object({
    schema: z.literal("eigengrid.effect-journal-outbox-ack.v1"),
    sequence: z.number().int().positive(),
    acknowledgementId: StableIdentifierSchema,
    eventId: StableIdentifierSchema,
    consumerId: StableIdentifierSchema,
    deliveredAt: EffectTimestampSchema,
    frameDigest: RequestDigestSchema,
  })
  .strict();
export type EffectOutboxAcknowledgementFrame = z.infer<
  typeof EffectOutboxAcknowledgementFrameSchema
>;

export const EffectJournalFrameSchema = z.discriminatedUnion("schema", [
  EffectOperationCommitFrameSchema,
  EffectOutboxAcknowledgementFrameSchema,
]);
export type EffectJournalFrame = z.infer<typeof EffectJournalFrameSchema>;

export const AppendEffectIntentInputSchema = z
  .object({
    mutationId: StableIdentifierSchema,
    identity: EffectOperationIdentitySchema,
    at: EffectTimestampSchema,
  })
  .strict();
export type AppendEffectIntentInput = z.input<typeof AppendEffectIntentInputSchema>;

export const ReconcileEffectIntentInputSchema = z
  .object({
    mutationId: StableIdentifierSchema,
    operationId: StableIdentifierSchema,
    requestDigest: RequestDigestSchema,
    expectedRevision: z.number().int().positive(),
    state: ReconciledEffectIntentStateSchema,
    at: EffectTimestampSchema,
    evidence: EffectEvidenceSchema,
  })
  .strict()
  .superRefine((input, context) => validateStateEvidence(input.state, input.evidence, context));
export type ReconcileEffectIntentInput = z.input<typeof ReconcileEffectIntentInputSchema>;

export const AcknowledgeEffectOutboxInputSchema = z
  .object({
    acknowledgementId: StableIdentifierSchema,
    eventId: StableIdentifierSchema,
    consumerId: StableIdentifierSchema,
    deliveredAt: EffectTimestampSchema,
  })
  .strict();
export type AcknowledgeEffectOutboxInput = z.input<typeof AcknowledgeEffectOutboxInputSchema>;
