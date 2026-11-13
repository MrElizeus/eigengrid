import { z } from "zod";
import { AmberMaterialRequestSchema } from "../../amber-material-publication";
import { AmberMdPreparationRequestSchema } from "../../amber-md-preparation";
import type { HttpSession } from "../auth";
import type { openMissionApplication } from "../../mission-composition";
import {
  assertOrigin,
  json,
  readJson,
  MissionHttpError,
  type MissionHttpIdempotencyService,
} from "./mission-routes";

type ApplicationSession = Awaited<ReturnType<typeof openMissionApplication>>;
const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,159}$/u);
const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u);
const envelope = z
  .object({ expectedRevision: z.number().int().positive().safe(), request: z.unknown() })
  .strict();

/** Authenticated application commands, never direct file, submitter or scheduler access. */
export async function handleMaterialRoute(
  request: Request,
  options: {
    origin: string;
    session: HttpSession;
    open: () => Promise<ApplicationSession>;
    idempotency: MissionHttpIdempotencyService;
  },
): Promise<Response | undefined> {
  const url = new URL(request.url),
    parts = url.pathname.split("/");
  if (
    parts.length !== 8 ||
    parts[1] !== "api" ||
    parts[2] !== "v1" ||
    parts[3] !== "projects" ||
    parts[5] !== "missions" ||
    !["materials", "md-stage-publications"].includes(parts[7]!)
  )
    return undefined;
  if (url.search) throw new MissionHttpError("INVALID_REQUEST");
  if (request.method !== "POST") throw new MissionHttpError("METHOD_NOT_ALLOWED");
  assertOrigin(request, url, options.origin, true);
  let projectId: string, missionId: string;
  try {
    projectId = identity.parse(decodeURIComponent(parts[4]!));
    missionId = identity.parse(decodeURIComponent(parts[6]!));
  } catch {
    throw new MissionHttpError("INVALID_REQUEST");
  }
  const { session } = options;
  if (!session.context.httpProjectIds?.includes(projectId)) throw new MissionHttpError("FORBIDDEN");
  const access = async () => {
    await session.assertCurrent();
    await (await options.open()).application.status({ projectId, missionId });
  };
  await access();
  if (!(await session.verifyCsrf(request))) throw new MissionHttpError("FORBIDDEN");
  const idempotencyKey = key.parse(request.headers.get("idempotency-key"));
  const body = await readJson(request, 10000);
  const value = envelope.parse(body.value);
  const material = parts[7] === "materials";
  const input = material
    ? AmberMaterialRequestSchema.parse(value.request)
    : AmberMdPreparationRequestSchema.parse(value.request);
  if (input.projectId !== projectId || input.missionId !== missionId)
    throw new MissionHttpError("INVALID_REQUEST");
  let invoked = false;
  const result = await options.idempotency.run(
    {
      actorId: session.context.authenticatedActor.id,
      projectId,
      operation: material ? "material.apply" : "md.publish-stage",
      key: idempotencyKey,
      requestDigest: body.digest,
      expectedRevision: value.expectedRevision,
      request: input,
    },
    async () => {
      if (invoked) throw new MissionHttpError("EFFECT_UNCERTAIN");
      invoked = true;
      await access();
      const app = await options.open();
      return material ? app.applyAmberMaterial(input) : app.publishMdStage(input);
    },
  );
  await access();
  if (!identity.safeParse(result.operationId).success || typeof result.replayed !== "boolean")
    throw new MissionHttpError("INTERNAL_ERROR");
  return json({ operationId: result.operationId, result: result.result }, 200, {
    "Idempotency-Replayed": String(result.replayed),
  });
}
