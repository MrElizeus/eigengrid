import { z } from "zod";
import { currentMissionContext } from "./authority";
import type { MissionApplicationContext, MissionApplicationState } from "./contracts";

const Page = z
  .object({
    after: z.string().min(1).max(160).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();
const ProjectPage = Page.extend({ projectId: z.string().min(1).max(160) }).strict();

export async function listApplicationProjects<C extends MissionApplicationContext>(
  application: MissionApplicationState<C>,
  projectIds: readonly string[],
  page: z.input<typeof Page> = {},
) {
  const context = await currentMissionContext(application);
  await application.options.authority.assertCurrent(context);
  const result = await application.options.store.listProductionProjects({
    ...Page.parse(page),
    projectIds: [...projectIds],
    ownerUserId: context.authenticatedActor.id,
  });
  await application.options.authority.assertCurrent(context);
  return result;
}

export async function listApplicationMissions<C extends MissionApplicationContext>(
  application: MissionApplicationState<C>,
  value: z.input<typeof ProjectPage>,
) {
  const context = await currentMissionContext(application);
  await application.options.authority.assertCurrent(context);
  const result = await application.options.store.listProductionMissions({
    ...ProjectPage.parse(value),
    ownerUserId: context.authenticatedActor.id,
  });
  await application.options.authority.assertCurrent(context);
  return result;
}
