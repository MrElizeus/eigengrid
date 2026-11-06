import {
  ScientificEntityNotFoundError,
  ScientificIntegrityError,
} from "@eigengrid/mission-runtime";
import { ActorIdentitySchema } from "@eigengrid/scientific-schema";
import { z } from "zod";
import {
  type MissionApplicationContext,
  MissionApplicationError,
  type MissionApplicationState,
  inaccessibleMissionMessages,
} from "./contracts";
import { Address } from "./requests";

export async function currentMissionContext<C extends MissionApplicationContext>(
  application: MissionApplicationState<C>,
): Promise<C> {
  const context = await application.options.authority.current();
  const actor = ActorIdentitySchema.parse(context.authenticatedActor);
  if (actor.kind !== "human" || !context.authorizedRoles.includes(actor.role))
    throw new MissionApplicationError(
      "FORBIDDEN",
      "Mission application requires an authenticated human with a current role",
    );
  return context;
}

export async function missionAccess<C extends MissionApplicationContext>(
  application: MissionApplicationState<C>,
  input: z.infer<typeof Address>,
  context: C,
): Promise<void> {
  await application.options.authority.assertCurrent(context);
  try {
    await application.options.store.assertProductionMissionPlanningAccess({
      ...input,
      ownerUserId: context.authenticatedActor.id,
    });
  } catch (error) {
    if (
      error instanceof ScientificEntityNotFoundError ||
      (error instanceof ScientificIntegrityError && inaccessibleMissionMessages.has(error.message))
    ) {
      throw new MissionApplicationError("NOT_FOUND", "Mission was not found or is not accessible");
    }
    throw error;
  }
}

export async function missionAssertProjectAccess<C extends MissionApplicationContext>(
  application: MissionApplicationState<C>,
  projectId: string,
): Promise<void> {
  const context = await currentMissionContext(application);
  await application.options.authority.assertCurrent(context);
  try {
    await application.options.store.assertProductionProjectPlanningAccess({
      projectId,
      ownerUserId: context.authenticatedActor.id,
    });
  } catch (error) {
    if (error instanceof ScientificIntegrityError)
      throw new MissionApplicationError("NOT_FOUND", "Project was not found or is not accessible");
    throw error;
  }
  await application.options.authority.assertCurrent(context);
}
