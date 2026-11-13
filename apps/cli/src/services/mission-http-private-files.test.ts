import { test, expect } from "bun:test";
import { mkdtemp, mkdir, chmod, writeFile, symlink, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readPrivateClientJson,
  writePrivateClientJson,
  lockPrivateClient,
} from "./mission-http-private-files";

test("private JSON roundtrip, mode and exclusive descriptor-bound lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "eg-http-private-"));
  try {
    const path = join(root, "state.json");
    await writePrivateClientJson(path, { pending: true });
    expect(await readPrivateClientJson(path)).toEqual({ pending: true });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const release = await lockPrivateClient(join(root, "state.lock"));
    await expect(lockPrivateClient(join(root, "state.lock"))).rejects.toThrow("busy");
    await release();
    await (
      await lockPrivateClient(join(root, "state.lock"))
    )();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed private JSON errors never include credential contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "eg-http-private-"));
  try {
    const path = join(root, "state.json");
    await writeFile(path, '{"credential":"TOP_SECRET_MARKER",invalid}', { mode: 0o600 });
    let message = "";
    try {
      await readPrivateClientJson(path);
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("JSON is invalid");
    expect(message).not.toContain("TOP_SECRET_MARKER");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reject symlink ancestors, peer-writable ancestors, public directories and files", async () => {
  const root = await mkdtemp(join(tmpdir(), "eg-http-private-"));
  try {
    await mkdir(join(root, "real"), { mode: 0o700 });
    await symlink(join(root, "real"), join(root, "alias"));
    await expect(writePrivateClientJson(join(root, "alias", "state.json"), {})).rejects.toThrow();
    await chmod(join(root, "real"), 0o755);
    await expect(writePrivateClientJson(join(root, "real", "state.json"), {})).rejects.toThrow();
    await chmod(join(root, "real"), 0o777);
    await mkdir(join(root, "real", "child"), { mode: 0o700 });
    await expect(
      writePrivateClientJson(join(root, "real", "child", "state.json"), {}),
    ).rejects.toThrow();
    const path = join(root, "public.json");
    await writeFile(path, "{}", { mode: 0o644 });
    await expect(readPrivateClientJson(path)).rejects.toThrow("0600");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
