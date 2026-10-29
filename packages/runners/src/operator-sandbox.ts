import { existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { runCommand } from "./process-utils";

export const OPERATOR_SANDBOX_LIMITS = Object.freeze({
  cpuPercent: 200,
  memoryBytes: 4 * 1024 ** 3,
  processes: 256,
  wallTimeSeconds: 3600,
  maximumFileBytes: 64 * 1024 ** 2,
});
export interface IsolatedCommand {
  command: string;
  args: string[];
}

export function assertOperatorSandboxWorkspace(workspace: string): void {
  workspace = realpathSync(workspace);
  const home = realpathSync(homedir());
  const rel = relative(workspace, home);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)))
    throw new Error(
      "Use a dedicated project directory, not your home directory or one of its parents",
    );
}

/** Fixed host-owned invocation; no shell interpolation and no inherited child environment. */
export function operatorSandboxCommand(
  command: string,
  args: readonly string[],
  workspace: string,
  writableDirectory: string,
): IsolatedCommand {
  if (process.platform !== "linux")
    throw new Error("The operator sandbox requires Linux namespaces and cgroups");
  workspace = realpathSync(workspace);
  assertOperatorSandboxWorkspace(workspace);
  writableDirectory = realpathSync(writableDirectory);
  const rel = relative(workspace, writableDirectory);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel))
    throw new Error("The sandbox job directory must be strictly inside this workspace");
  const limits = OPERATOR_SANDBOX_LIMITS;
  const bubble = [
    "/usr/bin/bwrap",
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    "--cap-drop",
    "ALL",
    "--ro-bind",
    "/usr",
    "/usr",
    "--symlink",
    "usr/bin",
    "/bin",
    "--symlink",
    "usr/lib",
    "/lib",
    "--symlink",
    "usr/lib64",
    "/lib64",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
  ];
  if (existsSync("/etc/ld.so.cache"))
    bubble.push("--ro-bind", "/etc/ld.so.cache", "/etc/ld.so.cache");
  bubble.push("--ro-bind", workspace, workspace);
  for (const name of [".eigengrid", ".git", ".ssh", ".codex", ".aws"])
    if (existsSync(`${workspace}/${name}`)) bubble.push("--tmpfs", `${workspace}/${name}`);
  for (const name of readdirSync(workspace).filter((name) => /^\.env(?:\.|$)/.test(name)))
    bubble.push("--ro-bind", "/dev/null", `${workspace}/${name}`);
  const dataRoot = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  for (const root of [
    process.env.EIGENGRID_AUTH_DIR ?? join(dataRoot, "eigengrid", "auth"),
    process.env.EIGENGRID_PERMISSIONS_DIR ?? join(dataRoot, "eigengrid", "permissions"),
  ]) {
    if (!existsSync(root)) continue;
    const canonical = realpathSync(root);
    const location = relative(workspace, canonical);
    if (location === "")
      throw new Error(
        "The sandbox workspace cannot itself be a credentials or permissions directory",
      );
    if (location !== "" && !location.startsWith("..") && !isAbsolute(location))
      bubble.push("--tmpfs", canonical);
  }
  bubble.push(
    "--bind",
    writableDirectory,
    writableDirectory,
    "--chdir",
    writableDirectory,
    "--clearenv",
    "--setenv",
    "PATH",
    "/usr/bin:/bin",
    "--setenv",
    "HOME",
    "/tmp",
    "--setenv",
    "TMPDIR",
    "/tmp",
    "--setenv",
    "OMP_NUM_THREADS",
    "2",
    "--",
    "/usr/bin/prlimit",
    `--fsize=${limits.maximumFileBytes}`,
    "--",
    command,
    ...args,
  );
  return {
    command: "/usr/bin/systemd-run",
    args: [
      "--user",
      "--scope",
      "--quiet",
      "--collect",
      `--property=MemoryMax=${limits.memoryBytes}`,
      `--property=CPUQuota=${limits.cpuPercent}%`,
      `--property=TasksMax=${limits.processes}`,
      `--property=RuntimeMaxSec=${limits.wallTimeSeconds}`,
      ...bubble,
    ],
  };
}

let cached: Promise<{ available: boolean; reason: string }> | undefined;
export function inspectOperatorSandbox(): Promise<{ available: boolean; reason: string }> {
  return (cached ??= (async () => {
    if (
      process.platform !== "linux" ||
      !existsSync("/usr/bin/bwrap") ||
      !existsSync("/usr/bin/systemd-run")
    )
      return {
        available: false,
        reason: "Linux, bubblewrap and a working user systemd manager are required.",
      };
    try {
      const result = await runCommand(
        "/usr/bin/systemd-run",
        [
          "--user",
          "--scope",
          "--quiet",
          "--collect",
          "--property=MemoryMax=268435456",
          "--property=CPUQuota=100%",
          "--property=TasksMax=32",
          "--property=RuntimeMaxSec=10",
          "/usr/bin/bwrap",
          "--unshare-all",
          "--die-with-parent",
          "--new-session",
          "--ro-bind",
          "/usr",
          "/usr",
          "--symlink",
          "usr/bin",
          "/bin",
          "--symlink",
          "usr/lib",
          "/lib",
          "--symlink",
          "usr/lib64",
          "/lib64",
          "--proc",
          "/proc",
          "--dev",
          "/dev",
          "--tmpfs",
          "/tmp",
          "--clearenv",
          "--",
          "/bin/sh",
          "-c",
          "test ! -e /home && test ! -e /run/user && printf sandbox-ready",
        ],
        { timeout: 5000, maxOutputBytes: 256, maxErrorBytes: 256 },
      );
      if (result.exitCode === 0 && result.stdout === "sandbox-ready")
        return {
          available: true,
          reason: "Verified Linux namespaces, network isolation and systemd resource controls.",
        };
    } catch {
      /* unavailable must never become host execution */
    }
    return {
      available: false,
      reason:
        "The host could not enforce the sandbox. Choose another preset or configure bubblewrap and user systemd.",
    };
  })());
}
