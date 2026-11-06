import { z } from "zod";
import type { MissionApplication } from "../../mission-application";
import type { HttpSession } from "../auth";
import { MissionHttpError, json } from "./mission-routes";

const pageSchema = z
  .object({
    after: z.string().min(1).max(160).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();
const projectIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u);
type DiscoveryApplication = Pick<MissionApplication, "listProjects" | "listMissions">;

/** Exact GET routes; all other mission operations keep their existing transport. */
export async function handleDiscoveryRoute(
  request: Request,
  session: HttpSession,
  open: () => Promise<DiscoveryApplication>,
): Promise<Response | null> {
  const url = new URL(request.url);
  const projects = url.pathname === "/api/v1/projects";
  const match = /^\/api\/v1\/projects\/([^/]+)\/missions$/u.exec(url.pathname);
  if (!projects && (!match || request.method === "POST")) return null;
  if (request.method !== "GET") throw new MissionHttpError("METHOD_NOT_ALLOWED");
  const params: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (!["after", "limit"].includes(key) || Object.hasOwn(params, key))
      throw new MissionHttpError("INVALID_REQUEST");
    params[key] = value;
  }
  const page = pageSchema.parse(params);
  const projectIds = session.context.httpProjectIds ?? [];
  await session.assertCurrent();
  const app = await open();
  let result: unknown;
  if (projects) result = await app.listProjects(projectIds, page);
  else {
    let projectId: string;
    try {
      projectId = projectIdSchema.parse(decodeURIComponent(match![1]!));
    } catch {
      throw new MissionHttpError("INVALID_REQUEST");
    }
    if (!projectIds.includes(projectId)) throw new MissionHttpError("FORBIDDEN");
    result = await app.listMissions({ projectId, ...page });
  }
  await session.assertCurrent();
  return json({ result });
}
