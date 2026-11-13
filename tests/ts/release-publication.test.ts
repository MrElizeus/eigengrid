import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
const publication = workflow.split("          script: |\n")[1]?.replace(/^ {12}/gm, "");
if (!publication) throw new Error("Missing release publication script");

function fixture(version = "1.0.2") {
  const commit = "a".repeat(40),
    tag = `v${version}`,
    archive = `eigengrid-${version}-linux-x64.tar.gz`;
  const files = new Map<string, Buffer>();
  files.set(`release/${archive}`, Buffer.from("synthetic archive"));
  files.set("release/release.json", Buffer.from(JSON.stringify({ version, sourceCommit: commit })));
  const hash = (path: string) => createHash("sha256").update(files.get(path)!).digest("hex");
  files.set(
    "release/validation.json",
    Buffer.from(
      JSON.stringify({
        tag,
        sourceCommit: commit,
        runId: 123,
        archive,
        archiveSha256: hash(`release/${archive}`),
        manifestSha256: hash("release/release.json"),
      }),
    ),
  );
  files.set("release/SHA256SUMS", Buffer.from("synthetic checksums"));
  files.set(
    `docs/release-notes/${tag}.md`,
    Buffer.from("Detailed planning and command recovery notes.\n"),
  );
  const created: Record<string, unknown>[] = [],
    uploaded: string[] = [],
    published: Record<string, unknown>[] = [];
  let rejectUpload = false;
  const github = {
    rest: {
      repos: {
        async createRelease(input: Record<string, unknown>) {
          created.push(input);
          return { data: { id: 42 } };
        },
        async uploadReleaseAsset(input: { name: string }) {
          if (rejectUpload) throw new Error("Simulated upload failure");
          uploaded.push(input.name);
        },
        async updateRelease(input: Record<string, unknown>) {
          published.push(input);
        },
      },
    },
  };
  return {
    files,
    created,
    uploaded,
    published,
    rejectUpload: () => {
      rejectUpload = true;
    },
    execute: () =>
      runInNewContext(`(async () => {\n${publication}\n})()`, {
        require: (name: string) => {
          if (name === "node:crypto") return crypto;
          if (name === "node:fs")
            return {
              readFileSync: (path: string, encoding?: string) => {
                const bytes = files.get(path);
                if (!bytes) throw new Error(`Missing fixture file ${path}`);
                return encoding ? bytes.toString("utf8") : bytes;
              },
            };
          throw new Error(`Unexpected publication dependency ${name}`);
        },
        process: { env: { RELEASE_TAG: tag, RELEASE_COMMIT: commit } },
        context: { repo: { owner: "example", repo: "eigengrid" }, runId: 123 },
        github,
      }) as Promise<void>,
  };
}

describe("release publication workflow", () => {
  test.each(["1.0.0-rc.2", "1.0.0", "1.0.1", "1.0.2", "1.0.3", "1.0.4", "1.0.5", "1.0.6"])(
    "publishes supported version %s after verification",
    async (version) => {
      const f = fixture(version);
      await f.execute();
      expect(f.created[0]).toMatchObject({
        tag_name: `v${version}`,
        draft: true,
        prerelease: version.includes("-rc."),
      });
      expect(f.uploaded).toContain(`eigengrid-${version}-linux-x64.tar.gz`);
      expect(f.published).toHaveLength(1);
    },
  );
  test("publishes the reviewed notes and only activates after all assets upload", async () => {
    const f = fixture();
    await f.execute();
    expect(f.created).toHaveLength(1);
    expect(f.created[0]).toMatchObject({ tag_name: "v1.0.2", draft: true, prerelease: false });
    expect(f.created[0].body).toContain("Detailed planning and command recovery notes.");
    expect(f.created[0].body).toContain("/actions/runs/123");
    expect(f.uploaded).toEqual([
      "eigengrid-1.0.2-linux-x64.tar.gz",
      "release.json",
      "SHA256SUMS",
      "validation.json",
    ]);
    expect(f.published).toEqual([
      { owner: "example", repo: "eigengrid", release_id: 42, draft: false },
    ]);
  });
  test("missing or empty notes stop before creating a release", async () => {
    for (const missing of [true, false]) {
      const f = fixture();
      if (missing) f.files.delete("docs/release-notes/v1.0.2.md");
      else f.files.set("docs/release-notes/v1.0.2.md", Buffer.from(" \n"));
      await expect(f.execute()).rejects.toThrow();
      expect(f.created).toHaveLength(0);
      expect(f.published).toHaveLength(0);
    }
  });
  test("changed archive bytes cannot be published", async () => {
    const f = fixture();
    f.files.set("release/eigengrid-1.0.2-linux-x64.tar.gz", Buffer.from("changed"));
    await expect(f.execute()).rejects.toThrow("integrity mismatch");
    expect(f.created).toHaveLength(0);
  });
  test("an upload failure leaves the release in draft", async () => {
    const f = fixture();
    f.rejectUpload();
    await expect(f.execute()).rejects.toThrow("upload failure");
    expect(f.created[0].draft).toBe(true);
    expect(f.published).toHaveLength(0);
  });
});
