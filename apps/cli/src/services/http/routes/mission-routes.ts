import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { ScientificStoreError, ScientificStoreErrorCode } from "@eigengrid/mission-runtime";
import {
  MissionApplicationError,
  MissionAddressSchema,
  MissionApproveRequestSchema,
  MissionCompileRequestSchema,
  MissionCreateRequestSchema,
  MissionImportRequestSchema,
  MissionReviewRequestSchema,
  MissionStartRequestSchema,
  MissionCancelRequestSchema,
  type MissionApplication,
} from "../../mission-application";

export const MissionHttpMaximumBodyBytes = 4 * 1024 * 1024;
export type MissionHttpMutation = "create" | "import" | "approve" | "compile" | "start" | "cancel";
export type MissionHttpOperation = "read" | "status" | "review" | MissionHttpMutation;
type ApplicationMethod =
  | "read"
  | "status"
  | "review"
  | "create"
  | "importCandidate"
  | "approve"
  | "compile"
  | "start"
  | "requestCancel";

/** Structurally implemented by MissionApplication. There are no execution handles here. */
export type MissionHttpApplicationPort = {
  [Method in ApplicationMethod]: (
    input: Parameters<MissionApplication[Method]>[0],
  ) => Promise<unknown>;
};

export interface TrustedMissionHttpSession {
  /** This identity and application's authority must refer to the same authenticated human. */
  readonly actorId: string;
  readonly application: MissionHttpApplicationPort;
  readonly scopes: readonly {
    readonly projectId: string;
    readonly operations: readonly MissionHttpOperation[];
  }[];
  /** Revalidate expiry, revocation, user status, memberships and the bound authority snapshot.
   * Throw MissionHttpError("UNAUTHENTICATED"/"FORBIDDEN") on lost authority. */
  assertCurrent(): Promise<void>;
  /** Verify the session-bound X-CSRF-Token without consuming the body. */
  verifyCsrf(request: Request): Promise<boolean>;
}

export interface MissionHttpIdempotencyRequest {
  readonly actorId: string;
  readonly projectId: string;
  readonly operation:
    | MissionHttpMutation
    | `agent.${"open" | "approve" | "resume" | "cancel" | "reconcile"}`;
  readonly key: string;
  /** SHA-256 of the exact bounded UTF-8 body bytes, including expectedRevision. */
  readonly requestDigest: string;
  readonly expectedRevision: number;
  readonly request: unknown;
}

/** Required trusted server adapter for mutations. No process-local replay fallback exists.
 * Persist the actor/project/operation/key binding and request digest before invocation.
 * Enforce expectedRevision at the durable mutation boundary (0 means absent for create),
 * serialize concurrent use of the key, and retain a stable operationId/result for replay.
 * Changed bytes conflict. An interrupted/ambiguous invocation must be reconciled, never
 * blindly re-invoked. Throw typed conflicts/dependency/effect-uncertainty errors when the
 * backend cannot establish those guarantees. This contract is NOT a persistence implementation.
 */
export interface MissionHttpIdempotencyService {
  run(
    request: MissionHttpIdempotencyRequest,
    execute: () => Promise<unknown>,
  ): Promise<{
    operationId: string;
    result: unknown;
    replayed: boolean;
  }>;
}

const errors = {
  UNAUTHENTICATED: [401, "A current authenticated session is required."],
  FORBIDDEN: [403, "This operation is not permitted."],
  NOT_FOUND: [404, "The requested resource is not available."],
  METHOD_NOT_ALLOWED: [405, "This route does not support the request method."],
  INVALID_REQUEST: [400, "The request does not match the required contract."],
  REQUEST_ABORTED: [400, "The request was aborted."],
  REQUEST_TIMEOUT: [408, "The request body was not received before its deadline."],
  REQUEST_TOO_LARGE: [413, "The request body exceeds the permitted size."],
  UNSUPPORTED_MEDIA_TYPE: [415, "Use uncompressed application/json with UTF-8 encoding."],
  REVISION_CONFLICT: [409, "The requested revision is no longer current."],
  IDEMPOTENCY_CONFLICT: [409, "The idempotency key is bound to a different request."],
  CONFLICT: [409, "The request conflicts with current durable state."],
  APPROVAL_EXPIRED: [409, "The required approval has expired."],
  POLICY_CHANGED: [409, "The current policy differs from the reviewed policy."],
  ENVIRONMENT_CHANGED: [409, "The current environment differs from the reviewed environment."],
  QUOTA_EXCEEDED: [429, "The requested operation exceeds its permitted quota."],
  DEPENDENCY_UNAVAILABLE: [503, "A required service is unavailable."],
  EFFECT_UNCERTAIN: [409, "The previous operation requires reconciliation before retry."],
  INTERNAL_ERROR: [500, "The request could not be completed."],
} as const;
export type MissionHttpErrorCode = keyof typeof errors;

/** Safe codes are selected by trusted adapters; exception messages/details never reach HTTP. */
export class MissionHttpError extends Error {
  constructor(readonly code: MissionHttpErrorCode) {
    super(errors[code][1]);
    this.name = "MissionHttpError";
  }
}

export interface MissionRouteOptions {
  readonly preflightMutation?: (operation: MissionHttpMutation, input: unknown) => Promise<void>;
  /** Canonical public HTTPS origin from server configuration, never a Host/Forwarded header. */
  readonly origin: string;
  readonly resolveSession: (request: Request) => Promise<TrustedMissionHttpSession | null>;
  readonly idempotency?: MissionHttpIdempotencyService;
  /** Trusted body-read deadline, 1–30,000 ms; defaults to 10,000 ms. */
  readonly bodyReadTimeoutMs?: number;
  /** Receives only safe diagnostic identifiers, never cookies, bodies, SQL or exception text. */
  readonly reportIncident?: (incident: { incidentId: string; code: MissionHttpErrorCode }) => void;
}

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/u);
const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u);
const envelope = z
  .object({
    expectedRevision: z.number().int().nonnegative().safe(),
    request: z.unknown(),
  })
  .strict();

type Route = {
  projectId: string;
  missionId?: string;
  planId?: string;
  operation: MissionHttpOperation;
  method: "GET" | "POST";
};

function routeFor(url: URL): Route {
  if (url.search || url.hash) throw new MissionHttpError("INVALID_REQUEST");
  const segments = url.pathname.split("/");
  if (
    segments[0] !== "" ||
    segments[1] !== "api" ||
    segments[2] !== "v1" ||
    segments[3] !== "projects" ||
    segments[5] !== "missions"
  )
    throw new MissionHttpError("NOT_FOUND");
  const decodeId = (value: string | undefined) => {
    if (value === undefined) throw new MissionHttpError("NOT_FOUND");
    try {
      return id.parse(decodeURIComponent(value));
    } catch {
      throw new MissionHttpError("NOT_FOUND");
    }
  };
  const projectId = decodeId(segments[4]);
  if (segments.length === 6) return { projectId, operation: "create", method: "POST" };
  const missionId = decodeId(segments[6]);
  if (segments.length === 7) return { projectId, missionId, operation: "read", method: "GET" };
  if (segments.length === 8 && segments[7] === "status")
    return { projectId, missionId, operation: "status", method: "GET" };
  if (segments.length === 10 && segments[7] === "plans" && segments[9] === "review")
    return {
      projectId,
      missionId,
      planId: decodeId(segments[8]),
      operation: "review",
      method: "GET",
    };
  if (
    segments.length === 8 &&
    ["import", "approve", "compile", "start", "cancel"].includes(segments[7]!)
  )
    return { projectId, missionId, operation: segments[7] as MissionHttpMutation, method: "POST" };
  throw new MissionHttpError("NOT_FOUND");
}

export function assertOrigin(request: Request, url: URL, origin: string, mutation: boolean): void {
  if (url.origin !== origin || url.username || url.password)
    throw new MissionHttpError("FORBIDDEN");
  const supplied = request.headers.get("origin");
  if ((mutation && supplied !== origin) || (supplied !== null && supplied !== origin))
    throw new MissionHttpError("FORBIDDEN");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite !== null && fetchSite !== "same-origin" && fetchSite !== "none")
    throw new MissionHttpError("FORBIDDEN");
}

async function currentScope(session: TrustedMissionHttpSession, route: Route): Promise<void> {
  await session.assertCurrent();
  if (
    !id.safeParse(session.actorId).success ||
    !session.scopes.some(
      (scope) => scope.projectId === route.projectId && scope.operations.includes(route.operation),
    )
  )
    throw new MissionHttpError("FORBIDDEN");
}

export async function readJson(
  request: Request,
  timeoutMs: number,
  maximumBytes = MissionHttpMaximumBodyBytes,
): Promise<{ value: unknown; digest: string }> {
  const contentType = request.headers.get("content-type") ?? "";
  const encoding = request.headers.get("content-encoding");
  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType) ||
    (encoding !== null && encoding !== "identity")
  )
    throw new MissionHttpError("UNSUPPORTED_MEDIA_TYPE");
  const length = request.headers.get("content-length");
  if (
    length !== null &&
    (!/^(?:0|[1-9][0-9]*)$/u.test(length) || !Number.isSafeInteger(Number(length)))
  )
    throw new MissionHttpError("INVALID_REQUEST");
  if (length !== null && Number(length) > maximumBytes)
    throw new MissionHttpError("REQUEST_TOO_LARGE");
  if (request.signal.aborted) throw new MissionHttpError("REQUEST_ABORTED");
  if (!request.body) throw new MissionHttpError("INVALID_REQUEST");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let complete = false;
  let interrupted: MissionHttpError | undefined;
  let rejectInterruption!: (reason: MissionHttpError) => void;
  const interruption = new Promise<never>((_resolve, reject) => {
    rejectInterruption = reject;
  });
  const interrupt = (error: MissionHttpError) => {
    if (interrupted) return;
    interrupted = error;
    rejectInterruption(error);
    // Do not await a source's cancellation promise: a stalled source may never settle it.
    void reader.cancel().catch(() => {});
  };
  const abort = () => interrupt(new MissionHttpError("REQUEST_ABORTED"));
  request.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => interrupt(new MissionHttpError("REQUEST_TIMEOUT")), timeoutMs);
  try {
    while (true) {
      const chunk = await Promise.race([reader.read(), interruption]);
      if (interrupted) throw interrupted;
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maximumBytes) throw new MissionHttpError("REQUEST_TOO_LARGE");
      chunks.push(chunk.value);
    }
    complete = true;
    if (total === 0 || (length !== null && Number(length) !== total))
      throw new MissionHttpError("INVALID_REQUEST");
    const bytes = Buffer.concat(chunks, total);
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new MissionHttpError("INVALID_REQUEST");
    }
    return { value, digest: createHash("sha256").update(bytes).digest("hex") };
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Shared schemas may supply defaults, but no unknown input field may be silently discarded. */
function assertNoDiscardedFields(input: unknown, parsed: unknown): void {
  if (!input || typeof input !== "object") return;
  if (!parsed || typeof parsed !== "object") throw new MissionHttpError("INVALID_REQUEST");
  for (const field of Object.keys(input)) {
    if (!Object.hasOwn(parsed, field)) throw new MissionHttpError("INVALID_REQUEST");
    assertNoDiscardedFields(
      (input as Record<string, unknown>)[field],
      (parsed as Record<string, unknown>)[field],
    );
  }
}

function parseMutation(operation: MissionHttpMutation, value: unknown) {
  const schemas = {
    create: MissionCreateRequestSchema,
    import: MissionImportRequestSchema,
    approve: MissionApproveRequestSchema,
    compile: MissionCompileRequestSchema,
    start: MissionStartRequestSchema,
    cancel: MissionCancelRequestSchema,
  };
  const parsed = schemas[operation].parse(value);
  assertNoDiscardedFields(value, parsed);
  return parsed;
}

function dispatchMutation(
  application: MissionHttpApplicationPort,
  operation: MissionHttpMutation,
  input: unknown,
) {
  switch (operation) {
    case "create":
      return application.create(MissionCreateRequestSchema.parse(input));
    case "import":
      return application.importCandidate(MissionImportRequestSchema.parse(input));
    case "approve":
      return application.approve(MissionApproveRequestSchema.parse(input));
    case "compile":
      return application.compile(MissionCompileRequestSchema.parse(input));
    case "start":
      return application.start(MissionStartRequestSchema.parse(input));
    case "cancel":
      return application.requestCancel(MissionCancelRequestSchema.parse(input));
  }
}

function safeCode(error: unknown): MissionHttpErrorCode {
  if (error instanceof MissionHttpError) return error.code;
  if (error instanceof z.ZodError) return "INVALID_REQUEST";
  if (error instanceof MissionApplicationError) {
    switch (error.code) {
      case "NOT_FOUND":
        return "NOT_FOUND";
      case "FORBIDDEN":
        return "FORBIDDEN";
      case "INVALID_CANDIDATE":
        return "INVALID_REQUEST";
      case "ENVIRONMENT_CHANGED":
        return "ENVIRONMENT_CHANGED";
      default:
        return "CONFLICT";
    }
  }
  if (error instanceof ScientificStoreError) {
    switch (error.code) {
      case ScientificStoreErrorCode.NOT_FOUND:
        return "NOT_FOUND";
      case ScientificStoreErrorCode.APPROVAL_UNAUTHORIZED:
        return "FORBIDDEN";
      case ScientificStoreErrorCode.REVISION_CONFLICT:
      case ScientificStoreErrorCode.APPROVAL_STALE:
        return "REVISION_CONFLICT";
      case ScientificStoreErrorCode.IDEMPOTENCY_CONFLICT:
        return "IDEMPOTENCY_CONFLICT";
      case ScientificStoreErrorCode.APPROVAL_EXPIRED:
        return "APPROVAL_EXPIRED";
      case ScientificStoreErrorCode.APPROVAL_POLICY_MISMATCH:
        return "POLICY_CHANGED";
      case ScientificStoreErrorCode.BUDGET_EXCEEDED:
        return "QUOTA_EXCEEDED";
      case ScientificStoreErrorCode.RECONCILIATION_REQUIRED:
        return "EFFECT_UNCERTAIN";
      case ScientificStoreErrorCode.UNSUPPORTED_DATABASE:
        return "DEPENDENCY_UNAVAILABLE";
      default:
        return "CONFLICT";
    }
  }
  return "INTERNAL_ERROR";
}

export function json(value: unknown, status = 200, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extra,
    },
  });
}

export function httpFailure(
  error: unknown,
  report?: MissionRouteOptions["reportIncident"],
): Response {
  const code = safeCode(error);
  const incidentId = randomUUID();
  try {
    report?.({ incidentId, code });
  } catch {
    /* Diagnostics never change authority. */
  }
  return json({ error: { code, message: errors[code][1], incidentId } }, errors[code][0], {
    "X-Incident-Id": incidentId,
  });
}

/** Reusable Fetch handler, not a listener or a session/idempotency implementation.
 * Exact surface:
 * GET  /api/v1/projects/:projectId/missions/:missionId
 * GET  /api/v1/projects/:projectId/missions/:missionId/status
 * GET  /api/v1/projects/:projectId/missions/:missionId/plans/:planId/review
 * POST /api/v1/projects/:projectId/missions                         (create)
 * POST /api/v1/projects/:projectId/missions/:missionId/import
 * POST /api/v1/projects/:projectId/missions/:missionId/approve
 * POST /api/v1/projects/:projectId/missions/:missionId/compile
 * POST /api/v1/projects/:projectId/missions/:missionId/start
 * POST JSON: { expectedRevision, request: <complete corresponding MissionApplication DTO> }.
 * Header Idempotency-Key is required, alongside Origin and session-bound X-CSRF-Token.
 * The body project/mission must exactly match the path. Query parameters are unsupported.
 * Responses expose facade results; a start result means durable intent, never job completion.
 */
export function createMissionRouteHandler(
  options: MissionRouteOptions,
): (request: Request) => Promise<Response> {
  const timeoutMs = options.bodyReadTimeoutMs ?? 10_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
    throw new TypeError("Mission HTTP body deadline must be an integer from 1 to 30000 ms");
  const origin = new URL(options.origin);
  if (
    origin.protocol !== "https:" ||
    origin.origin !== options.origin ||
    origin.username ||
    origin.password
  )
    throw new TypeError("Mission HTTP composition requires a canonical HTTPS origin");
  return async (request) => {
    try {
      const url = new URL(request.url);
      const route = routeFor(url);
      if (request.method !== route.method) throw new MissionHttpError("METHOD_NOT_ALLOWED");
      const mutation = route.method === "POST";
      assertOrigin(request, url, options.origin, mutation);
      const session = await options.resolveSession(request);
      if (!session) throw new MissionHttpError("UNAUTHENTICATED");
      await currentScope(session, route);
      if (!mutation) {
        let result: unknown;
        if (route.operation === "review")
          result = await session.application.review(
            MissionReviewRequestSchema.parse({
              projectId: route.projectId,
              missionId: route.missionId,
              planId: route.planId,
            }),
          );
        else {
          const input = MissionAddressSchema.parse({
            projectId: route.projectId,
            missionId: route.missionId,
          });
          result =
            await session.application[route.operation === "status" ? "status" : "read"](input);
        }
        await currentScope(session, route);
        return json({ result });
      }
      const csrf = request.headers.get("x-csrf-token");
      if (!csrf || csrf.length > 512 || !(await session.verifyCsrf(request)))
        throw new MissionHttpError("FORBIDDEN");
      const idempotencyKey = key.parse(request.headers.get("idempotency-key"));
      if (!options.idempotency) throw new MissionHttpError("DEPENDENCY_UNAVAILABLE");
      const body = await readJson(request, timeoutMs);
      const parsed = envelope.parse(body.value);
      const operation = route.operation as MissionHttpMutation;
      const input = parseMutation(operation, parsed.request);
      if (
        input.projectId !== route.projectId ||
        ("missionId" in input && input.missionId !== route.missionId) ||
        (operation === "create" ? parsed.expectedRevision !== 0 : parsed.expectedRevision < 1)
      )
        throw new MissionHttpError("INVALID_REQUEST");
      await currentScope(session, route);
      let invoked = false;
      await options.preflightMutation?.(operation, input);
      const outcome = await options.idempotency.run(
        {
          actorId: session.actorId,
          projectId: route.projectId,
          operation,
          key: idempotencyKey,
          requestDigest: body.digest,
          expectedRevision: parsed.expectedRevision,
          request: input,
        },
        async () => {
          if (invoked) throw new MissionHttpError("EFFECT_UNCERTAIN");
          invoked = true;
          await currentScope(session, route);
          return dispatchMutation(session.application, operation, input);
        },
      );
      await currentScope(session, route);
      if (!id.safeParse(outcome.operationId).success || typeof outcome.replayed !== "boolean")
        throw new MissionHttpError("INTERNAL_ERROR");
      return json(
        { operationId: outcome.operationId, result: outcome.result },
        operation === "create" ? 201 : 200,
        { "Idempotency-Replayed": String(outcome.replayed) },
      );
    } catch (error) {
      const code = safeCode(error);
      const incidentId = randomUUID();
      try {
        options.reportIncident?.({ incidentId, code });
      } catch {
        /* Logging never changes the safe response. */
      }
      return json({ error: { code, message: errors[code][1], incidentId } }, errors[code][0], {
        "X-Incident-Id": incidentId,
      });
    }
  };
}
