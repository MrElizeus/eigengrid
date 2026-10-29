import { z } from "zod";

export const EventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("job:created"), jobId: z.string(), at: z.number() }),
  z.object({
    type: z.literal("job:status:changed"),
    jobId: z.string(),
    from: z.string(),
    to: z.string(),
    at: z.number(),
  }),
  z.object({
    type: z.literal("job:log:line"),
    jobId: z.string(),
    line: z.string(),
    at: z.number(),
  }),
  z.object({
    type: z.literal("node:status:changed"),
    nodeId: z.string(),
    status: z.string(),
    at: z.number(),
  }),
  z.object({ type: z.literal("system:notice"), message: z.string(), at: z.number() }),
]);
