import type { HttpSql } from "./auth";
import { MissionHttpError } from "./routes/mission-routes";

/** Transport ownership only. This is not a scientific evidence or approval store. */
export class PostgresHttpArtifactGrants {
  constructor(readonly sql: HttpSql) {}
  async grant(actorId: string, projectId: string, digest: string) {
    await this.sql.query(
      "INSERT INTO eigengrid_a5_http_artifact_grants(actor_id,project_id,content_digest) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
      [actorId, projectId, digest],
    );
  }
  async assertInputs(
    actorId: string,
    projectId: string,
    digests: readonly string[],
    associated: ReadonlySet<string>,
  ) {
    const result = await this.sql.query(
      "SELECT content_digest FROM eigengrid_a5_http_artifact_grants WHERE actor_id=$1 AND project_id=$2 AND content_digest::text=ANY($3::text[])",
      [actorId, projectId, digests],
    );
    const granted = new Set(result.rows.map((row) => String(row.content_digest)));
    if (digests.some((digest) => !granted.has(digest) && !associated.has(digest)))
      throw new MissionHttpError("NOT_FOUND");
  }
}
