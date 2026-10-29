import { describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseJobOutputTool, parseOutputTool } from "@eigengrid/tool-registry";
import { resolveParsePath } from "@eigengrid/tool-registry/builtin/parse-path";

function createWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "eigengrid-parse-path-"));
  const jobsDir = join(root, "jobs");
  const outputsDir = join(root, "outputs");
  mkdirSync(jobsDir);
  mkdirSync(outputsDir);
  return { root, jobsDir, outputsDir };
}

function createContext(
  jobsDir: string,
  outputsDir: string,
  parse = mock(async () => ({
    ok: true,
    parser: "gaussian",
    status: "completed" as const,
    data: {},
  })),
) {
  return {
    config: { jobsDir, outputsDir },
    python: { parse },
    db: {},
  } as any;
}

describe("parse path boundary", () => {
  test("canonicalizes a valid artifact filename containing spaces, Unicode, and shell metacharacters", () => {
    const { root, outputsDir } = createWorkspace();
    const outputPath = join(outputsDir, "water ü;$(safe)`name`.out");
    writeFileSync(outputPath, "output");

    try {
      const result = resolveParsePath(outputPath, [join(root, "jobs"), outputsDir]);
      expect(result).toEqual({ ok: true, path: outputPath });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects malformed, traversing, unavailable, directory, outside-root, and symlink-escape paths", () => {
    const { root, jobsDir, outputsDir } = createWorkspace();
    const outsidePath = join(root, "outside.out");
    const directoryPath = join(outputsDir, "directory");
    const escapePath = join(outputsDir, "escape.out");
    writeFileSync(outsidePath, "outside");
    mkdirSync(directoryPath);
    symlinkSync(outsidePath, escapePath);

    try {
      for (const candidate of [
        "",
        "bad\0path",
        "bad\npath",
        "bad\rpath",
        join(outputsDir, "..", "outside.out"),
        `${outputsDir}\\..\\outside.out`,
        join(outputsDir, "missing.out"),
        directoryPath,
        outsidePath,
        escapePath,
      ]) {
        expect(resolveParsePath(candidate, [jobsDir, outputsDir]).ok).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("accepts an output under an available root when an earlier configured root is missing", async () => {
    const { root, outputsDir } = createWorkspace();
    const missingJobsDir = join(root, "missing-jobs");
    const outputPath = join(outputsDir, "safe output.out");
    const parse = mock(async () => ({
      ok: true,
      parser: "gaussian",
      status: "completed" as const,
      data: {},
    }));
    writeFileSync(outputPath, "output");

    try {
      expect(resolveParsePath(outputPath, [missingJobsDir, outputsDir])).toEqual({
        ok: true,
        path: outputPath,
      });

      const result = await parseOutputTool.execute(
        createContext(missingJobsDir, outputsDir, parse),
        {
          software: "gaussian",
          outputPath,
        },
      );
      expect(result.ok).toBe(true);
      expect(parse).toHaveBeenCalledWith("gaussian", outputPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("parse-output invokes Python only with a canonical safe artifact path", async () => {
    const { root, jobsDir, outputsDir } = createWorkspace();
    const outputPath = join(outputsDir, "safe output.out");
    const parse = mock(async () => ({
      ok: true,
      parser: "gaussian",
      status: "completed" as const,
      data: {},
    }));
    writeFileSync(outputPath, "output");

    try {
      const accepted = await parseOutputTool.execute(createContext(jobsDir, outputsDir, parse), {
        software: "gaussian",
        outputPath,
      });
      expect(accepted.ok).toBe(true);
      expect(parse).toHaveBeenCalledWith("gaussian", outputPath);

      const rejected = await parseOutputTool.execute(createContext(jobsDir, outputsDir, parse), {
        software: "gaussian",
        outputPath: join(root, "outside.out"),
      });
      expect(rejected).toMatchObject({ ok: false, error: { code: "INVALID_PATH" } });
      expect(parse).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("parse-job-output rejects unsafe persisted and fallback artifact paths before Python", async () => {
    const { root, jobsDir, outputsDir } = createWorkspace();
    const outsidePath = join(root, "outside.out");
    writeFileSync(outsidePath, "outside");
    const parse = mock(async () => ({
      ok: true,
      parser: "gaussian",
      status: "completed" as const,
      data: {},
    }));
    const context = createContext(jobsDir, outputsDir, parse);
    context.db = {
      getJob: async () => ({ id: "job-1", software: "gaussian", outputPath: outsidePath }),
      listJobAttempts: async () => [{ id: "attempt-1", jobId: "job-1" }],
      listArtifacts: async () => [{ kind: "output", path: outsidePath, attemptId: "attempt-1" }],
    };

    try {
      const result = await parseJobOutputTool.execute(context, {
        jobId: "job-1",
        attemptId: "attempt-1",
      });
      expect(result).toMatchObject({ ok: false, error: { code: "INVALID_PATH" } });
      expect(parse).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
