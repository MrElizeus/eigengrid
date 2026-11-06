import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebPermissions } from "./permissions";
import { saveOperatorPermissions } from "../services/operator-permission-store";

test("web file authority cannot inherit host-wide CLI Full Access or follow a parent symlink out", async () => {
  const root = mkdtempSync(join(tmpdir(), "eigengrid-web-scope-"));
  const workspace = join(root, "project");
  mkdirSync(join(workspace, ".eigengrid"), { recursive: true, mode: 0o700 });
  writeFileSync(join(workspace, "water.inp"), "! HF STO-3G");
  writeFileSync(join(workspace, ".eigengrid/llm.json"), "private");
  writeFileSync(join(workspace, "history.sqlite"), "private");
  writeFileSync(join(root, "outside.txt"), "private");
  symlinkSync(root, join(workspace, "external"));
  try {
    saveOperatorPermissions("full-access", workspace);
    const permissions = new WebPermissions(workspace);
    const read = (path: string) =>
      permissions.authorizeTool({ id: crypto.randomUUID(), name: "read-file", input: { path } });
    expect((await read("water.inp")).allow).toBe(true);
    for (const path of [
      ".eigengrid/llm.json",
      "history.sqlite",
      "../outside.txt",
      "external/outside.txt",
    ])
      expect((await read(path)).allow).toBe(false);
    for (const name of ["run-command", "write-file", "submit-job", "future-unknown-tool"])
      expect(
        (await permissions.authorizeTool({ id: crypto.randomUUID(), name, input: {} })).allow,
      ).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
