import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ToolRegistry, type ToolContext } from "@eigengrid/tool-registry";
import {
  PERMISSION_PRESETS,
  permissionDecision,
  permissionPreset,
  type OperationKind,
} from "@eigengrid/agent/execution-permissions";
import { OperatorPermissions, slashOperationKind } from "./operator-permissions";
import {
  loadOperatorPermissions,
  operatorPermissionPath,
  saveOperatorPermissions,
} from "./operator-permission-store";
import { reviewOperatorAction } from "./operator-auto-review";

let root: string, workspace: string;
const originalDirectory = process.env.EIGENGRID_PERMISSIONS_DIR;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "eigengrid-permission-tests-"));
  workspace = join(root, "workspace");
  mkdirSync(workspace);
  process.env.EIGENGRID_PERMISSIONS_DIR = join(root, "private-policy");
});
afterEach(() => {
  if (originalDirectory === undefined) delete process.env.EIGENGRID_PERMISSIONS_DIR;
  else process.env.EIGENGRID_PERMISSIONS_DIR = originalDirectory;
  rmSync(root, { recursive: true, force: true });
});
const call = (input: unknown = { path: "calculation.in", content: "ecutwfc = 40" }) => ({
  id: "call-one",
  name: "write-file",
  input,
});

describe("orthogonal permission presets", () => {
  test("applies the operation matrix without granting scope through automatic review", () => {
    const kinds: OperationKind[] = [
      "read",
      "write",
      "compute",
      "remote",
      "shell",
      "destructive",
      "unknown",
    ];
    const expected: ("allow" | "ask" | "deny")[][] = [
      ["allow", "deny", "deny", "deny", "deny", "deny", "deny"],
      ["allow", "ask", "ask", "ask", "ask", "ask", "deny"],
      ["allow", "ask", "ask", "ask", "ask", "ask", "deny"],
      ["allow", "allow", "allow", "deny", "deny", "ask", "deny"],
      ["allow", "allow", "allow", "allow", "allow", "allow", "deny"],
    ];
    PERMISSION_PRESETS.forEach((preset, index) =>
      expect(kinds.map((kind) => permissionDecision(preset, kind))).toEqual(expected[index]),
    );
    expect(permissionDecision(permissionPreset("auto-review"), "write", true)).toBe("allow");
    expect(permissionDecision(permissionPreset("auto-review"), "shell", true)).toBe("ask");
    expect(permissionPreset("ask").executionScope).toBe(
      permissionPreset("auto-review").executionScope,
    );
  });
  test("defaults to Ask and stores a workspace-specific private user policy", () => {
    expect(loadOperatorPermissions(workspace).preset).toBe("ask");
    saveOperatorPermissions("read-only", workspace);
    expect(loadOperatorPermissions(workspace).preset).toBe("read-only");
    expect(operatorPermissionPath(workspace)).not.toContain(workspace);
    expect(existsSync(join(workspace, ".eigengrid", "permissions.json"))).toBe(false);
    const second = join(root, "other-workspace");
    mkdirSync(second);
    expect(loadOperatorPermissions(second).preset).toBe("ask");
  });
  test("rejects malformed, permissive and symlinked policy files", () => {
    saveOperatorPermissions("ask", workspace);
    const path = operatorPermissionPath(workspace);
    chmodSync(path, 0o644);
    expect(() => loadOperatorPermissions(workspace)).toThrow("private");
    chmodSync(path, 0o600);
    writeFileSync(path, '{"preset":"full-access"}');
    expect(() => loadOperatorPermissions(workspace)).toThrow("Invalid");
    rmSync(path);
    symlinkSync(join(root, "elsewhere"), path);
    expect(() => loadOperatorPermissions(workspace)).toThrow("Could not read");
  });
});

describe("host approval and independent review", () => {
  test("the complete action remains reviewable beyond the first screen", async () => {
    const content = "x".repeat(3000) + "visible-at-the-end";
    const policy = new OperatorPermissions(workspace, async (request) => {
      expect(request.summary).toContain("visible-at-the-end");
      expect(JSON.parse(request.summary).content).toBe(content);
      return false;
    });
    expect(await policy.verify(call({ path: "calculation.in", content }), "session")).toBe(false);
  });
  test("asks exactly once and consumes an approval bound to session, input and policy revision", async () => {
    let prompts = 0;
    const policy = new OperatorPermissions(workspace, async () => {
      prompts++;
      return true;
    });
    const action = call();
    expect(await policy.verify(action, "session-one")).toBe(true);
    expect(await policy.verify(action, "session-one")).toBe(true);
    expect(prompts).toBe(1);
    expect((await policy.authorize(action, "different-session")).allow).toBe(false);
    expect((await policy.authorize(action, "session-one")).allow).toBe(true);
    expect((await policy.authorize(action, "session-one")).allow).toBe(false);
    const audit = readFileSync(`${operatorPermissionPath(workspace)}.audit.jsonl`, "utf8");
    expect(audit).toContain('"source":"human"');
    expect(audit).not.toContain("ecutwfc");
  });
  test("rejects changed files and settings after the approval prompt", async () => {
    const path = join(workspace, "calculation.in");
    writeFileSync(path, "original");
    const policy = new OperatorPermissions(workspace, async () => true);
    expect(await policy.verify(call(), "session")).toBe(true);
    writeFileSync(path, "changed externally");
    expect((await policy.authorize(call(), "session")).allow).toBe(false);
    expect(await policy.verify(call(), "session")).toBe(true);
    saveOperatorPermissions("full-access", workspace);
    expect((await policy.authorize(call(), "session")).allow).toBe(false);
  });
  test("rejects changes made while the human is deciding and expired approval", async () => {
    let now = 0;
    const policy = new OperatorPermissions(
      workspace,
      async () => {
        now = 120001;
        return true;
      },
      () => now,
    );
    expect(await policy.verify(call(), "session")).toBe(false);
    const changed = new OperatorPermissions(workspace, async () => {
      saveOperatorPermissions("full-access", workspace);
      return true;
    });
    expect(await changed.verify(call(), "session")).toBe(false);
  });
  test("Auto Review approves bounded scientific inputs, escalates shell and unknown files", async () => {
    saveOperatorPermissions("auto-review", workspace);
    let prompts = 0;
    const policy = new OperatorPermissions(workspace, async () => {
      prompts++;
      return false;
    });
    expect(await policy.verify(call(), "session")).toBe(true);
    expect((await policy.authorize(call(), "session")).allow).toBe(true);
    expect(prompts).toBe(0);
    expect(
      await policy.verify(
        { id: "shell", name: "run-command", input: { command: "/bin/true", approved: true } },
        "session",
      ),
    ).toBe(false);
    expect(await policy.verify(call({ path: "startup.sh", content: "exit 0" }), "session")).toBe(
      false,
    );
    expect(prompts).toBe(2);
    expect(
      reviewOperatorAction({
        name: "write-file",
        kind: "write",
        withinWorkspace: false,
        path: "/tmp/input.in",
        bytes: 2,
        protectedPath: false,
      }).approved,
    ).toBe(false);
  });
  test("Read Only denies mutations even with a willing approval callback", async () => {
    saveOperatorPermissions("read-only", workspace);
    let prompts = 0,
      effects = 0;
    const policy = new OperatorPermissions(workspace, async () => {
      prompts++;
      return true;
    });
    await expect(
      policy.run(call(), async () => {
        effects++;
      }),
    ).rejects.toThrow("blocked");
    expect((await policy.authorize({ id: "read", name: "list-jobs", input: {} })).allow).toBe(true);
    expect(prompts).toBe(0);
    expect(effects).toBe(0);
  });
  test("Full Access needs no approval but still records the action", async () => {
    saveOperatorPermissions("full-access", workspace);
    let prompts = 0,
      effects = 0;
    const policy = new OperatorPermissions(workspace, async () => {
      prompts++;
      return false;
    });
    await policy.run(
      { id: "shell", name: "run-command", input: { command: "/bin/true" } },
      async () => {
        effects++;
      },
    );
    expect(effects).toBe(1);
    expect(prompts).toBe(0);
    expect(readFileSync(`${operatorPermissionPath(workspace)}.audit.jsonl`, "utf8")).toContain(
      '"source":"preset"',
    );
  });
  test("symlink and out-of-workspace paths cannot escape Read Only", async () => {
    saveOperatorPermissions("read-only", workspace);
    const outside = join(root, "private.in");
    writeFileSync(outside, "private");
    symlinkSync(outside, join(workspace, "linked.in"));
    const policy = new OperatorPermissions(workspace);
    expect(
      (await policy.authorize({ id: "one", name: "read-file", input: { path: "linked.in" } }))
        .allow,
    ).toBe(false);
    expect(
      (await policy.authorize({ id: "two", name: "read-file", input: { path: outside } })).allow,
    ).toBe(false);
    const protectedRoot = join(workspace, ".eigengrid");
    mkdirSync(protectedRoot);
    writeFileSync(join(protectedRoot, "llm.json"), "{}");
    saveOperatorPermissions("ask", workspace);
    expect(
      (
        await policy.authorize({
          id: "secret",
          name: "read-file",
          input: { path: ".eigengrid/llm.json" },
        })
      ).allow,
    ).toBe(false);
    saveOperatorPermissions("full-access", workspace);
    await expect(
      policy.verify(call({ path: ".eigengrid/llm.json", content: "{}" }), "session"),
    ).rejects.toThrow("cannot modify");
  });
  test("slash commands distinguish observation, Slurm, mutation and administration", () => {
    expect(slashOperationKind("status", [])).toBe("read");
    expect(slashOperationKind("node", ["add"])).toBe("remote");
    expect(slashOperationKind("submit", ["xtb", "molecule.xyz"])).toBe("compute");
    expect(slashOperationKind("submit", ["qe", "input.in", "--runner=slurm"])).toBe("remote");
    expect(slashOperationKind("cancel", ["job"])).toBe("destructive");
    expect(slashOperationKind("permission", [])).toBe("unknown");
  });
});

test("a host rule change during asynchronous final review prevents the effect", async () => {
  let effects = 0;
  const registry = new ToolRegistry([{ action: "*", resource: "*", effect: "allow" }], async () => {
    await Promise.resolve();
    registry.replacePermissions([{ action: "*", resource: "*", effect: "deny" }]);
    return { allow: true };
  });
  registry.register({
    name: "fixture",
    description: "Fixture",
    inputSchema: z.object({}),
    outputSchema: z.object({}),
    async execute() {
      effects++;
      return { ok: true, data: {} };
    },
  });
  const result = await registry
    .materialize()
    .settle({ name: "fixture", id: "race", input: {} }, {} as ToolContext);
  expect(result.ok).toBe(false);
  expect(effects).toBe(0);
});

test("all registry execution paths honor the final host guard and revalidate old snapshots", async () => {
  saveOperatorPermissions("full-access", workspace);
  const policy = new OperatorPermissions(workspace);
  let effects = 0;
  const registry = new ToolRegistry([{ action: "*", resource: "*", effect: "allow" }], (action) =>
    policy.authorizeTool(action),
  );
  registry.register({
    name: "write-file",
    description: "Fixture effect",
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    outputSchema: z.object({ count: z.number() }),
    async execute() {
      effects++;
      return { ok: true, data: { count: effects } };
    },
  });
  const ctx = {} as ToolContext;
  const snapshot = registry.materialize();
  expect((await snapshot.settle(call(), ctx)).ok).toBe(false);
  expect(await policy.verify(call(), "session")).toBe(true);
  expect((await registry.settleAuthorized({ ...call(), sessionId: "session" }, ctx)).ok).toBe(true);
  saveOperatorPermissions("read-only", workspace);
  expect((await snapshot.settle({ ...call(), sessionId: "session" }, ctx)).ok).toBe(false);
  expect((await registry.execute("write-file", ctx, call().input)).ok).toBe(false);
  expect((await registry.get("write-file")!.execute(ctx, call().input)).ok).toBe(false);
  expect((await registry.list()[0]!.execute(ctx, call().input)).ok).toBe(false);
  expect(effects).toBe(1);
});
