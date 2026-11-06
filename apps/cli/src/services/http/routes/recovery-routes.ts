import { z } from "zod";
import type { HttpSession } from "../auth";
import type { HttpOperationLookup } from "../idempotency";
import { json, MissionHttpError } from "./mission-routes";

/** Project authority permits lookup even if a create never reached mission persistence. */
export async function handleRecoveryRoute(
  request: Request,
  session: HttpSession,
  assertProject: (id: string) => Promise<void>,
  lookup?: (input: HttpOperationLookup) => Promise<unknown>,
): Promise<Response | null> {
  const url = new URL(request.url);
  const match = /^\/api\/v1\/projects\/([^/]+)\/requests\/([^/]+)\/([^/]+)$/u.exec(url.pathname);
  if (!match) return null;
  if (request.method !== "GET") throw new MissionHttpError("METHOD_NOT_ALLOWED");
  if ([...url.searchParams.keys()].join(",") !== "missionId")
    throw new MissionHttpError("INVALID_REQUEST");
  const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,159}$/u);
  const projectId = identity.parse(decodeURIComponent(match[1]!));
  if (!session.context.httpProjectIds?.includes(projectId)) throw new MissionHttpError("FORBIDDEN");
  await session.assertCurrent();
  await assertProject(projectId);
  if (!lookup) throw new MissionHttpError("DEPENDENCY_UNAVAILABLE");
  const result = await lookup({
    actorId: session.context.authenticatedActor.id,
    projectId,
    missionId: identity.parse(url.searchParams.get("missionId")),
    operation: decodeURIComponent(match[2]!),
    key: decodeURIComponent(match[3]!),
  });
  await session.assertCurrent();
  await assertProject(projectId);
  return json({ result });
}
