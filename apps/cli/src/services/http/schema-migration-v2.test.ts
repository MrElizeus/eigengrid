import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  canRunPostgres,
  startEphemeralPostgres,
  type EphemeralPostgresCluster,
} from "../../../../../tests/ts/helpers/postgres";
import {
  ApplicationHttpSchema,
  applyApplicationHttpSchema,
  validateApplicationHttpSchema,
} from "./composition";

describe.skipIf(!canRunPostgres)("HTTP schema v2 real PostgreSQL migration", () => {
  let cluster: EphemeralPostgresCluster;
  let pool: Pool;
  const insert = async (operation: string, key: string) =>
    pool.query(
      "INSERT INTO eigengrid_a5_http_operations(actor_id,project_id,operation,idempotency_key,operation_id,request_digest,expected_revision,request_json,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        "actor",
        "project",
        operation,
        key,
        randomUUID(),
        "a".repeat(64),
        1,
        JSON.stringify({ missionId: "mission" }),
        "pending",
      ],
    );
  beforeAll(async () => {
    cluster = await startEphemeralPostgres();
    pool = new Pool({ connectionString: cluster.url });
    await pool.query(ApplicationHttpSchema);
    await pool.query("INSERT INTO eigengrid_a5_http_schema(version,checksum) VALUES (1,$1)", [
      createHash("sha256").update(ApplicationHttpSchema).digest("hex"),
    ]);
    await insert("start", "old");
  });
  afterAll(async () => {
    await pool?.end();
    await cluster?.cleanup();
  });
  test("upgrades v1 with existing rows, permits both new operations and reapplies safely", async () => {
    await expect(insert("material.apply", "before")).rejects.toThrow();
    await applyApplicationHttpSchema(pool);
    await validateApplicationHttpSchema(pool);
    await insert("material.apply", "material");
    await insert("md.publish-stage", "stage");
    await applyApplicationHttpSchema(pool);
    await validateApplicationHttpSchema(pool);
    expect(
      (
        await pool.query("SELECT operation FROM eigengrid_a5_http_operations ORDER BY operation")
      ).rows.map((x) => x.operation),
    ).toEqual(["material.apply", "md.publish-stage", "start"]);
  });
  test("rejects modified v2 checksum instead of silently accepting altered schema", async () => {
    await pool.query("UPDATE eigengrid_a5_http_schema SET checksum=$1 WHERE version=2", [
      "0".repeat(64),
    ]);
    await expect(validateApplicationHttpSchema(pool)).rejects.toThrow();
    await expect(applyApplicationHttpSchema(pool)).rejects.toThrow();
  });
});
