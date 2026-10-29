import { describe, expect, test } from "bun:test";
import { SqliteDatabase } from "@eigengrid/db";
import { ToolRegistry, type ToolContext } from "@eigengrid/tool-registry";
import { listEventsTool } from "./operational-read-tools";

describe("operational event tool", () => {
  test("filters the database before limiting so later event types remain observable", async () => {
    const db = new SqliteDatabase(":memory:");
    await db.init();
    try {
      await db.createJob({
        id: "campaign-job",
        name: "Event boundary fixture",
        software: "amber",
        inputPath: "/fixture/input",
        workdir: "/fixture/jobs",
      });
      for (let index = 0; index < 201; index++) {
        await db.appendEvent({
          id: `event-${index}`,
          type: index === 200 ? "process.failed" : "process.started",
          source: "system",
          at: index,
          jobId: "campaign-job",
        });
      }
      const ctx = { db } as unknown as ToolContext;
      const result = await listEventsTool.execute(ctx, {
        jobId: "campaign",
        type: "process.failed",
        limit: 1,
      });
      expect(result.ok).toBe(true);
      expect(result.data?.total).toBe(1);
      expect(result.data?.events).toHaveLength(1);
      expect(result.data?.events[0]).toMatchObject({
        type: "process.failed",
        eventId: "event-200",
      });
      const limited = await listEventsTool.execute(ctx, { jobId: "campaign-job", limit: 3 });
      expect(limited.data?.events).toHaveLength(3);
      expect(limited.data?.total).toBe(3);
    } finally {
      await db.close();
    }
  });

  test("validates event page limits before querying persistence", async () => {
    const registry = new ToolRegistry([{ action: "*", resource: "*", effect: "allow" }]);
    registry.register(listEventsTool);
    for (const limit of [0, -1, 0.5, 201]) {
      const result = await registry
        .materialize()
        .settle(
          { id: `invalid-${limit}`, name: "list-events", input: { limit } },
          {} as ToolContext,
        );
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("INVALID_INPUT");
    }
  });
});
