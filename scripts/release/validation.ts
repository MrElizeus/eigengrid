import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import {
  POSTGRES_MIGRATIONS,
  postgresMigrationChecksum,
} from "../../packages/db/src/postgres/migrations";

const directory = "dist/packages";
const release = JSON.parse(readFileSync(`${directory}/release.json`, "utf8"));
const tag = process.env.GITHUB_REF_NAME;
const commit = process.env.GITHUB_SHA;
const runId = process.env.GITHUB_RUN_ID;
const repositoryId = process.env.GITHUB_REPOSITORY_ID;
if (
  !/^v1\.0\.0-rc\.[1-9]\d*$/.test(tag ?? "") ||
  tag !== `v${release.version}` ||
  commit !== release.sourceCommit ||
  !/^\d+$/.test(runId ?? "") ||
  !/^\d+$/.test(repositoryId ?? "") ||
  process.env.GITHUB_EVENT_NAME !== "push"
) {
  throw new Error("Release tag, source commit and CI identity must match");
}
execFileSync("git", ["merge-base", "--is-ancestor", commit!, "origin/main"]);
const archive = `eigengrid-${release.version}-linux-x64.tar.gz`;
const hash = (name: string) =>
  createHash("sha256")
    .update(readFileSync(`${directory}/${name}`))
    .digest("hex");
writeFileSync(
  `${directory}/validation.json`,
  JSON.stringify(
    {
      schemaVersion: "eigengrid.release-validation/v1",
      repositoryId: Number(repositoryId),
      runId: Number(runId),
      sourceCommit: commit,
      tag,
      archive,
      archiveSha256: hash(archive),
      manifestSha256: hash("release.json"),
      migrations: POSTGRES_MIGRATIONS.map((migration) => ({
        version: migration.version,
        name: migration.name,
        checksum: postgresMigrationChecksum(migration),
      })),
    },
    null,
    2,
  ) + "\n",
  { flag: "wx" },
);
