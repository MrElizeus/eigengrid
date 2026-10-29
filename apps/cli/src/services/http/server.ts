import { createHash } from "node:crypto";
import { z } from "zod";
import { ContentAddressedStoreError } from "@eigengrid/mission-runtime";
import { AgentSessionError, type AgentSessionService } from "../agent-sessions";
import type { openMissionApplication } from "../mission-composition";
import type { MissionLocalContext } from "../mission-local-authority";
import {
  runAgentSessionAction,
  agentSessionActions,
  approvalSchema,
  openSchema,
  type AgentSessionAction,
} from "../../commands/agent-session";
import { PostgresHttpAuth, SessionCookieName, type HttpSession } from "./auth";
import { PostgresHttpArtifactGrants } from "./artifact-grants";
import {
  assertOrigin,
  createMissionRouteHandler,
  httpFailure,
  json,
  MissionHttpError,
  readJson,
  type MissionHttpIdempotencyService,
  type MissionHttpApplicationPort,
  type MissionHttpOperation,
  type MissionRouteOptions,
} from "./routes/mission-routes";

type ApplicationSession = Awaited<ReturnType<typeof openMissionApplication>>;
export interface ApplicationHttpOptions {
  readonly grants: PostgresHttpArtifactGrants;
  readonly origin: string;
  readonly auth: PostgresHttpAuth;
  readonly idempotency: MissionHttpIdempotencyService;
  readonly open: (
    context: MissionLocalContext,
    current: () => Promise<void>,
  ) => Promise<ApplicationSession>;
  readonly agent: (
    context: MissionLocalContext,
    current: () => Promise<void>,
  ) => AgentSessionService;
  readonly reconcile?: (
    input: { actorId: string; projectId: string; missionId: string; operationId: string },
    context: MissionLocalContext,
    current: () => Promise<void>,
  ) => Promise<unknown>;
  readonly reportIncident?: MissionRouteOptions["reportIncident"];
}
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,159}$/u);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u);
const envelope = z
  .object({ expectedRevision: z.number().int().nonnegative().safe(), request: z.unknown() })
  .strict();
const allOperations: MissionHttpOperation[] = [
  "create",
  "read",
  "status",
  "review",
  "import",
  "approve",
  "compile",
  "start",
  "cancel",
];
const artifactLimit = 64 * 1024 * 1024;
const cookie = (token: string, age: number) =>
  `${SessionCookieName}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${age}`;

async function csrf(session: HttpSession, request: Request) {
  if (!(await session.verifyCsrf(request))) throw new MissionHttpError("FORBIDDEN");
}
function safeError(error: unknown): unknown {
  if (error instanceof AgentSessionError)
    return new MissionHttpError(
      error.code === "UNCERTAIN_EFFECT" ? "EFFECT_UNCERTAIN" : error.code,
    );
  if (error instanceof ContentAddressedStoreError)
    return new MissionHttpError(
      error.code === "OBJECT_TOO_LARGE"
        ? "REQUEST_TOO_LARGE"
        : ["NOT_FOUND", "UNSAFE_OBJECT", "DIGEST_MISMATCH"].includes(error.code)
          ? "NOT_FOUND"
          : "DEPENDENCY_UNAVAILABLE",
    );
  return error;
}

/** A genuine authenticated application surface. The listener is process-owned;
 * disconnecting a client never cancels mission runtime scientific WorkUnits or resumes an unknown effect. */
export function createApplicationHttpHandler(options: ApplicationHttpOptions) {
  const origin = new URL(options.origin);
  if (origin.origin !== options.origin || origin.protocol !== "https:")
    throw new Error("A canonical HTTPS public origin is required");
  return async (request: Request, remoteAddress = "local"): Promise<Response> => {
    let applicationSession: ApplicationSession | undefined;
    let streaming = false;
    const close = async () => {
      const session = applicationSession;
      applicationSession = undefined;
      await session?.close();
    };
    try {
      const url = new URL(request.url);
      assertOrigin(request, url, options.origin, !["GET", "HEAD"].includes(request.method));
      if (url.pathname === "/api/v1/auth/login") {
        if (request.method !== "POST" || url.search) throw new MissionHttpError("INVALID_REQUEST");
        const body = z
          .object({ credential: z.string().regex(/^[A-Za-z0-9_-]{43}$/u) })
          .strict()
          .parse((await readJson(request, 5000, 8192)).value);
        const login = await options.auth.login(body.credential, remoteAddress);
        return json({ csrfToken: login.csrf, expiresAt: login.expiresAt }, 200, {
          "Set-Cookie": cookie(login.token, login.maxAge),
        });
      }
      const session = await options.auth.resolve(request);
      if (!session) throw new MissionHttpError("UNAUTHENTICATED");
      if (url.pathname === "/api/v1/auth/logout") {
        if (request.method !== "POST" || url.search) throw new MissionHttpError("INVALID_REQUEST");
        await csrf(session, request);
        await session.revoke();
        return json({ revoked: true }, 200, { "Set-Cookie": cookie("", 0) });
      }
      const open = async () =>
        (applicationSession ??= await options.open(session.context, session.assertCurrent));
      const parts = url.pathname.split("/");
      const projectUpload =
        parts[5] === "artifacts" && parts.length === 7 && request.method === "PUT";
      if (
        parts[1] !== "api" ||
        parts[2] !== "v1" ||
        parts[3] !== "projects" ||
        (parts[5] !== "missions" && !projectUpload)
      )
        throw new MissionHttpError("NOT_FOUND");
      const projectId = id.parse(decodeURIComponent(parts[4] ?? ""));
      if (!session.context.httpProjectIds?.includes(projectId))
        throw new MissionHttpError("FORBIDDEN");
      if (parts[7] === "operations") {
        if (
          parts.length !== 10 ||
          parts[9] !== "reconcile" ||
          request.method !== "POST" ||
          url.search
        )
          throw new MissionHttpError("NOT_FOUND");
        await csrf(session, request);
        const missionId = id.parse(parts[6]);
        const operationId = z.string().uuid().parse(parts[8]);
        await (await open()).application.status({ projectId, missionId });
        if (!options.reconcile) throw new MissionHttpError("DEPENDENCY_UNAVAILABLE");
        const result = await options.reconcile(
          { actorId: session.context.authenticatedActor.id, projectId, missionId, operationId },
          session.context,
          session.assertCurrent,
        );
        await session.assertCurrent();
        return json(result);
      }
      if (projectUpload || parts[7] === "agent-sessions" || parts[7] === "artifacts") {
        const missionId = projectUpload ? undefined : id.parse(decodeURIComponent(parts[6] ?? ""));
        const access = async () => {
          await session.assertCurrent();
          const app = (await open()).application;
          if (projectUpload) await app.assertProjectAccess(projectId);
          else await app.status({ projectId, missionId: missionId! });
        };
        await access();
        if (projectUpload || parts[7] === "artifacts") {
          if (
            parts.length !== (projectUpload ? 7 : 9) ||
            url.search ||
            request.headers.has("range")
          )
            throw new MissionHttpError("INVALID_REQUEST");
          const digest = hash.parse(parts[projectUpload ? 6 : 8]);
          if (request.method === "PUT") {
            await csrf(session, request);
            if (
              request.headers.get("content-type") !== "application/octet-stream" ||
              request.headers.has("content-encoding")
            )
              throw new MissionHttpError("UNSUPPORTED_MEDIA_TYPE");
            const length = request.headers.get("content-length");
            if (
              length !== null &&
              (!/^[1-9][0-9]*$/u.test(length) || !Number.isSafeInteger(Number(length)))
            )
              throw new MissionHttpError("INVALID_REQUEST");
            if (Number(length) > artifactLimit) throw new MissionHttpError("REQUEST_TOO_LARGE");
            if (!request.body) throw new MissionHttpError("INVALID_REQUEST");
            const reader = request.body.getReader();
            let sourceFailure: unknown;
            let rejectDeadline!: (error: MissionHttpError) => void;
            const deadline = new Promise<never>((_resolve, reject) => {
              rejectDeadline = reject;
            });
            // A CAS failure before it starts consuming the generator must not
            // leave a deadline rejection unobserved or a reader locked.
            void deadline.catch(() => {});
            const timer = setTimeout(() => {
              rejectDeadline(new MissionHttpError("REQUEST_TIMEOUT"));
              void reader.cancel().catch(() => {});
            }, 30000);
            async function* chunks() {
              const hash = createHash("sha256");
              let total = 0;
              try {
                for (;;) {
                  const { value, done } = await Promise.race([reader.read(), deadline]);
                  if (done) break;
                  if (request.signal.aborted) throw new MissionHttpError("REQUEST_ABORTED");
                  total += value.byteLength;
                  if (total > artifactLimit) throw new MissionHttpError("REQUEST_TOO_LARGE");
                  hash.update(value);
                  await session!.assertCurrent();
                  yield value;
                }
                if (
                  !total ||
                  (length !== null && total !== Number(length)) ||
                  hash.digest("hex") !== digest
                )
                  throw new MissionHttpError("INVALID_REQUEST");
                await access();
              } catch (error) {
                sourceFailure = request.signal.aborted
                  ? new MissionHttpError("REQUEST_ABORTED")
                  : error;
                throw error;
              }
            }
            try {
              const stored = await (
                await open()
              ).artifacts.putStream(chunks(), { maxBytes: artifactLimit });
              await access();
              await options.grants.grant(
                session.context.authenticatedActor.id,
                projectId,
                stored.digest,
              );
              return json({ artifact: stored }, 201);
            } catch (error) {
              throw sourceFailure ?? error;
            } finally {
              clearTimeout(timer);
              void reader.cancel().catch(() => {});
              reader.releaseLock();
            }
          }
          if (request.method !== "GET") throw new MissionHttpError("METHOD_NOT_ALLOWED");
          const app = await open();
          const provenance = await app.application.read({ projectId, missionId: missionId! });
          if (!provenance.evidence.some((item) => item.immutable && item.contentDigest === digest))
            throw new MissionHttpError("NOT_FOUND");
          const verified = await app.artifacts.getStream(digest, { maxBytes: artifactLimit });
          const iterator = verified.bytes[Symbol.asyncIterator]();
          streaming = true;
          return new Response(
            new ReadableStream<Uint8Array>(
              {
                async pull(controller) {
                  try {
                    await access();
                    if (request.signal.aborted) throw new MissionHttpError("REQUEST_ABORTED");
                    const next = await iterator.next();
                    if (next.done) {
                      await close();
                      controller.close();
                    } else controller.enqueue(next.value);
                  } catch (error) {
                    await iterator.return?.();
                    await close();
                    controller.error(error);
                  }
                },
                async cancel() {
                  await iterator.return?.();
                  await close();
                },
              },
              { highWaterMark: 0 },
            ),
            {
              headers: {
                "Content-Type": "application/octet-stream",
                "Content-Length": String(verified.sizeBytes),
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
              },
            },
          );
        }
        const service = options.agent(session.context, session.assertCurrent);
        const sessionId = parts[8];
        const action =
          parts.length === 8
            ? "open"
            : parts.length === 9
              ? "observe"
              : parts.length === 10
                ? parts[9]
                : undefined;
        if (!agentSessionActions.includes(action as AgentSessionAction))
          throw new MissionHttpError("NOT_FOUND");
        if (sessionId) {
          const principal = await service.principal(z.string().uuid().parse(sessionId));
          if (principal.projectId !== projectId || principal.missionId !== missionId)
            throw new MissionHttpError("NOT_FOUND");
        }
        const typedAction = action as AgentSessionAction;
        if (typedAction === "events") {
          if (
            request.method !== "GET" ||
            [...url.searchParams.keys()].some((name) => !["after", "maximum"].includes(name))
          )
            throw new MissionHttpError("INVALID_REQUEST");
          let cursor = z.coerce
            .number()
            .int()
            .nonnegative()
            .safe()
            .parse(url.searchParams.get("after") ?? 0);
          let remaining = z.coerce
            .number()
            .int()
            .min(1)
            .max(256)
            .parse(url.searchParams.get("maximum") ?? 64);
          await service.events(sessionId!, cursor, 1);
          const encoder = new TextEncoder();
          return new Response(
            new ReadableStream<Uint8Array>(
              {
                async pull(controller) {
                  try {
                    await session.assertCurrent();
                    if (request.signal.aborted) {
                      controller.close();
                      return;
                    }
                    const page = await service.events(sessionId!, cursor, 1);
                    if (!remaining-- || page.events.length === 0) {
                      controller.close();
                      return;
                    }
                    cursor = page.cursor;
                    controller.enqueue(
                      encoder.encode(JSON.stringify({ cursor, record: page.events[0] }) + "\n"),
                    );
                  } catch (error) {
                    controller.error(error);
                  }
                },
              },
              { highWaterMark: 0 },
            ),
            {
              headers: {
                "Content-Type": "application/x-ndjson",
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
              },
            },
          );
        }
        if (url.search) throw new MissionHttpError("INVALID_REQUEST");
        if (typedAction === "observe") {
          if (request.method !== "GET") throw new MissionHttpError("METHOD_NOT_ALLOWED");
          return json({ result: await service.observe(sessionId!) });
        }
        if (request.method !== "POST") throw new MissionHttpError("METHOD_NOT_ALLOWED");
        await csrf(session, request);
        const body = await readJson(request, 10000, 256 * 1024);
        const input = envelope.parse(body.value);
        const requestKey = key.parse(request.headers.get("idempotency-key"));
        const value =
          typedAction === "open"
            ? openSchema.parse({
                ...z.object({ prompt: z.string() }).strict().parse(input.request),
                projectId,
                missionId: missionId!,
                requestId: requestKey,
              })
            : typedAction === "approve"
              ? { sessionId, approval: approvalSchema.parse(input.request) }
              : { sessionId, ...z.object({}).strict().parse(input.request) };
        const outcome = await options.idempotency.run(
          {
            actorId: session.context.authenticatedActor.id,
            projectId,
            operation: `agent.${typedAction as "open" | "approve" | "resume" | "cancel" | "reconcile"}`,
            key: requestKey,
            requestDigest: body.digest,
            expectedRevision: input.expectedRevision,
            request: { ...value, projectId, missionId },
          },
          async () => {
            await access();
            if (
              typedAction === "open"
                ? input.expectedRevision !== 0
                : (await service.observe(sessionId!)).cursor.sequence !== input.expectedRevision
            )
              throw new MissionHttpError("REVISION_CONFLICT");
            return runAgentSessionAction(typedAction, value, () => service);
          },
        );
        await session.assertCurrent();
        return json(
          { operationId: outcome.operationId, result: outcome.result },
          typedAction === "open" ? 201 : 200,
          { "Idempotency-Replayed": String(outcome.replayed) },
        );
      }
      const checkEvidence = async (method: string, input: unknown) => {
        if (method !== "create" && method !== "importCandidate") return;
        const app = (await open()).application;
        const value = input as {
          objectiveEvidence?: { contentDigest: string }[];
          candidate?: { evidence: { contentDigest: string }[] };
          missionId?: string;
        };
        const evidence = value.objectiveEvidence ?? value.candidate?.evidence ?? [];
        const associated = new Set<string>();
        if (value.missionId) {
          for (const item of (await app.read({ projectId, missionId: value.missionId })).evidence)
            associated.add(item.contentDigest);
        }
        await options.grants.assertInputs(
          session.context.authenticatedActor.id,
          projectId,
          evidence.map((item) => item.contentDigest),
          associated,
        );
      };
      const application: MissionHttpApplicationPort = Object.fromEntries(
        [
          "create",
          "read",
          "status",
          "review",
          "importCandidate",
          "approve",
          "compile",
          "start",
          "requestCancel",
        ].map((method) => [
          method,
          async (input: never) => {
            const app = (await open()).application;
            await checkEvidence(method, input);
            return app[method as keyof MissionHttpApplicationPort](input);
          },
        ]),
      ) as MissionHttpApplicationPort;
      return await createMissionRouteHandler({
        origin: options.origin,
        idempotency: options.idempotency,
        preflightMutation: (operation, input) =>
          checkEvidence(operation === "import" ? "importCandidate" : operation, input),
        reportIncident: options.reportIncident,
        resolveSession: async () => ({
          actorId: session.context.authenticatedActor.id,
          application,
          scopes: session.context.httpProjectIds!.map((projectId) => ({
            projectId,
            operations: allOperations,
          })),
          assertCurrent: session.assertCurrent,
          verifyCsrf: session.verifyCsrf,
        }),
      })(request);
    } catch (error) {
      return httpFailure(safeError(error), options.reportIncident);
    } finally {
      if (!streaming) await close();
    }
  };
}
