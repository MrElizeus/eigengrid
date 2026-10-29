import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { agentDigest, type AgentToolCall } from "@eigengrid/agent-runtime";
import {
  operatorToolKind,
  permissionDecision,
  permissionPreset,
  type OperationKind,
} from "@eigengrid/agent/execution-permissions";
import {
  inspectOperatorSandbox,
  assertOperatorSandboxWorkspace,
} from "@eigengrid/runners/operator-sandbox";
import { loadOperatorPermissions, operatorPermissionPath } from "./operator-permission-store";
import { reviewOperatorAction, type OperatorReviewFacts } from "./operator-auto-review";

export interface OperatorApprovalRequest {
  readonly name: string;
  readonly kind: OperationKind;
  readonly summary: string;
  readonly inputDigest: string;
  readonly reason: string;
  readonly expiresAt: number;
}
interface BoundApproval {
  key: string;
  expiresAt: number;
  source: string;
}
type ApprovalPrompt = (request: OperatorApprovalRequest) => Promise<boolean>;

export function pathWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function resolveOperatorFile(path: string, workspace: string): string {
  const target = resolve(workspace, path);
  try {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new Error("Operator file access requires a regular file, not a symlink");
    return realpathSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return resolve(realpathSync(dirname(target)), target.slice(target.lastIndexOf("/") + 1));
  }
}

export function slashOperationKind(command: string, args: readonly string[]): OperationKind {
  if (
    [
      "status",
      "logs",
      "artifacts",
      "results",
      "events",
      "timeline",
      "recipes",
      "show",
      "usage",
      "doctor",
    ].includes(command)
  )
    return "read";
  if (command === "node" && ["list", "show", "status", "inspect"].includes(args[0] ?? "list"))
    return "read";
  if (command === "worker" && ["list", "status", "show"].includes(args[0] ?? "")) return "read";
  if (command === "session" && ["observe", "events"].includes(args[0] ?? "")) return "read";
  if (command === "submit")
    return args.some((a) => /(?:slurm|ssh|worker)/i.test(a)) ? "remote" : "compute";
  if (["cancel", "backup", "db"].includes(command)) return "destructive";
  if (["mission", "session", "node", "worker", "scheduler", "serve"].includes(command))
    return "remote";
  if (["init", "parse", "collect", "plan", "export", "project", "user", "quota"].includes(command))
    return "write";
  return "unknown";
}

/** Operator-owned policy and exact-call receipts; tool arguments cannot grant authority. */
export class OperatorPermissions {
  readonly workspace: string;
  private readonly receipts = new Map<string, BoundApproval>();
  private inspectJob?: (
    id: string,
  ) => Promise<{ backend: string | null; workdir: string | null; state: unknown }>;
  constructor(
    workspace = process.cwd(),
    private readonly prompt?: ApprovalPrompt,
    private readonly now = Date.now,
  ) {
    this.workspace = realpathSync(workspace);
  }
  bindJobInspector(inspector: NonNullable<OperatorPermissions["inspectJob"]>): void {
    this.inspectJob = inspector;
  }
  private async binding(call: AgentToolCall, sessionId: string) {
    const settings = loadOperatorPermissions(this.workspace);
    const preset = permissionPreset(settings.preset);
    const input = call.input as Record<string, unknown>;
    let kind = call.name.startsWith("/")
      ? slashOperationKind(
          call.name.slice(1),
          Array.isArray(input.args) ? (input.args as string[]) : [],
        )
      : operatorToolKind(call.name);
    let file: string | undefined;
    let fileState: unknown = null;
    const rawPath =
      input &&
      (call.name === "submit-job"
        ? input.inputPath
        : ["write-file", "read-file"].includes(call.name)
          ? input.path
          : undefined);
    if (typeof rawPath === "string") {
      file = resolveOperatorFile(rawPath, this.workspace);
      try {
        const stat = statSync(file);
        if (stat.size > 64 * 1024 ** 2)
          throw new Error("Operator file access is limited to 64 MiB");
        fileState = {
          path: file,
          inode: stat.ino,
          digest: createHash("sha256").update(readFileSync(file)).digest("hex"),
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const withinWorkspace = file ? pathWithin(this.workspace, file) : true;
    const authRoot =
      process.env.EIGENGRID_AUTH_DIR ??
      resolve(
        process.env.XDG_DATA_HOME || resolve(homedir(), ".local", "share"),
        "eigengrid",
        "auth",
      );
    const protectedPath = file
      ? file
          .split(/[\\/]/)
          .some(
            (p) =>
              p === ".eigengrid" ||
              p === ".git" ||
              p === ".ssh" ||
              p === ".codex" ||
              /^\.env(?:\.|$)/.test(p),
          ) ||
        pathWithin(dirname(operatorPermissionPath(this.workspace)), file) ||
        pathWithin(resolve(authRoot), file)
      : false;
    if (protectedPath && (kind === "write" || (kind === "read" && preset.id !== "full-access")))
      throw new Error(
        "Operator file tools cannot modify credentials, repository metadata or permission settings; reading these files requires Full Access",
      );
    if (
      file &&
      kind === "read" &&
      preset.id !== "full-access" &&
      ["/proc", "/sys", "/dev"].some((root) => pathWithin(root, file))
    )
      throw new Error("Kernel and device files require Full Access");
    if (
      file &&
      ["read-only", "sandbox"].includes(preset.executionScope) &&
      (!withinWorkspace || protectedPath)
    )
      throw new Error("This file is outside the selected execution scope");
    if (preset.executionScope === "sandbox" && kind !== "read") {
      assertOperatorSandboxWorkspace(this.workspace);
      const sandbox = await inspectOperatorSandbox();
      if (!sandbox.available) throw new Error(sandbox.reason);
      if (kind === "compute") {
        const { loadConfig } = await import("@eigengrid/config");
        let root = resolve((await loadConfig(this.workspace)).jobsDir);
        while (true) {
          try {
            root = realpathSync(root);
            break;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(root) === root)
              throw error;
            root = dirname(root);
          }
        }
        if (!pathWithin(this.workspace, root))
          throw new Error("Sandbox job storage must be inside the current workspace");
      }
    }
    let jobState: unknown = null;
    if (
      (call.name === "cancel-job" || call.name === "parse-job-output") &&
      typeof input.jobId === "string"
    ) {
      if (!this.inspectJob && preset.executionScope === "sandbox")
        throw new Error("Sandboxed job actions require an exact job owner");
      if (this.inspectJob) {
        const job = await this.inspectJob(input.jobId);
        jobState = job.state;
        if (
          preset.executionScope === "sandbox" &&
          (!job.workdir || !pathWithin(this.workspace, resolve(job.workdir)))
        )
          throw new Error("This job is outside the sandbox workspace");
        if (preset.executionScope === "sandbox" && job.backend && job.backend !== "local")
          kind = "remote";
      }
    }
    const facts: OperatorReviewFacts = {
      name: call.name,
      kind,
      withinWorkspace,
      path: file,
      bytes: typeof input?.content === "string" ? Buffer.byteLength(input.content) : undefined,
      protectedPath,
    };
    // Only host-derived facts reach the reviewer. An input field named "approved" has no effect.
    let review = { approved: false, reason: "Human approval is required before this action." };
    if (preset.approvalPolicy === "auto-review") {
      try {
        review = reviewOperatorAction(facts);
      } catch {
        review = {
          approved: false,
          reason: "Automatic review failed; human approval is required.",
        };
      }
    }
    const decision = permissionDecision(preset, kind, review.approved);
    const referencedFiles: unknown[] = [];
    if (call.name.startsWith("/") && Array.isArray(input.args)) {
      for (const arg of input.args) {
        if (typeof arg !== "string" || arg.startsWith("-")) continue;
        const target = resolve(this.workspace, arg);
        let stat;
        try {
          stat = statSync(target);
        } catch {
          continue;
        }
        if (!stat.isFile()) continue;
        if (stat.size > 64 * 1024 ** 2)
          throw new Error("Reviewed command input files are limited to 64 MiB");
        const canonical = realpathSync(target);
        if (preset.executionScope === "sandbox" && !pathWithin(this.workspace, canonical))
          throw new Error("Sandbox command inputs must be inside this workspace");
        referencedFiles.push({
          path: canonical,
          digest: createHash("sha256").update(readFileSync(target)).digest("hex"),
        });
      }
    }
    const key = agentDigest({
      sessionId,
      call: { id: call.id, name: call.name, input: call.input },
      settings,
      fileState,
      referencedFiles,
      jobState,
    });
    return { key, decision, settings, kind, reason: review.reason };
  }
  async verify(call: AgentToolCall, sessionId: string): Promise<boolean> {
    for (const [id, receipt] of this.receipts)
      if (receipt.expiresAt <= this.now()) this.receipts.delete(id);
    const binding = await this.binding(call, sessionId);
    if (binding.decision === "deny") return false;
    if (binding.kind === "read") return true;
    const receiptId = `${sessionId}:${call.id}`;
    const existing = this.receipts.get(receiptId);
    if (existing?.key === binding.key && existing.expiresAt > this.now()) return true;
    const expiresAt = this.now() + 120_000;
    let source = binding.settings.preset === "auto-review" ? "independent-review" : "preset";
    if (binding.decision === "ask") {
      if (!this.prompt) return false;
      const approved = await this.prompt({
        name: call.name,
        kind: binding.kind,
        summary: JSON.stringify(call.input, null, 2),
        inputDigest: agentDigest(call.input),
        reason: binding.reason,
        expiresAt,
      });
      if (!approved || this.now() >= expiresAt) return false;
      source = "human";
    }
    // A changed file or preset invalidates approval rather than approving the new action.
    if ((await this.binding(call, sessionId)).key !== binding.key) return false;
    this.receipts.set(receiptId, { key: binding.key, expiresAt, source });
    return true;
  }
  async decide(call: AgentToolCall, sessionId: string): Promise<"allow" | "ask" | "deny"> {
    try {
      return (await this.binding(call, sessionId)).decision;
    } catch {
      return "deny";
    }
  }
  async authorize(
    call: AgentToolCall,
    sessionId?: string,
  ): Promise<{ allow: boolean; reason?: string }> {
    try {
      const binding = await this.binding(call, sessionId ?? "direct");
      if (binding.decision === "deny")
        return {
          allow: false,
          reason:
            "The selected permissions preset denies this operation. Use /permissions to review it.",
        };
      if (binding.kind === "read") return { allow: true };
      const receiptId = `${sessionId ?? "direct"}:${call.id}`;
      const receipt = this.receipts.get(receiptId);
      this.receipts.delete(receiptId);
      if (!receipt || receipt.key !== binding.key || receipt.expiresAt <= this.now())
        return {
          allow: false,
          reason: "An exact, current operator authorization is required before execution.",
        };
      this.audit(call, binding.settings.revision, receipt.source, binding.key);
      return { allow: true };
    } catch (error) {
      return {
        allow: false,
        reason: error instanceof Error ? error.message : "Operator permission verification failed",
      };
    }
  }
  /** Registry calls carry a unique call ID. The engine verifier binds it to its session. */
  async authorizeTool(
    call: AgentToolCall & { sessionId?: string },
  ): Promise<{ allow: boolean; reason?: string }> {
    return this.authorize(call, call.sessionId);
  }
  async run<T>(call: AgentToolCall, execute: () => Promise<T>): Promise<T> {
    const sessionId = "console";
    if (!(await this.verify(call, sessionId)))
      throw new Error("Operation declined or blocked by the selected permissions preset.");
    const result = await this.authorize(call, sessionId);
    if (!result.allow) throw new Error(result.reason);
    return execute();
  }
  private audit(call: AgentToolCall, revision: string, source: string, binding: string): void {
    const path = `${operatorPermissionPath(this.workspace)}.audit.jsonl`;
    const root = dirname(path);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const directory = lstatSync(root);
    if (
      !directory.isDirectory() ||
      directory.mode & 0o077 ||
      (process.getuid && directory.uid !== process.getuid())
    )
      throw new Error("Operator audit directory is not private");
    const fd = openSync(
      path,
      constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid()))
        throw new Error("Operator audit file is not private");
      appendFileSync(
        fd,
        JSON.stringify({ at: this.now(), operation: call.name, revision, source, binding }) + "\n",
      );
    } finally {
      closeSync(fd);
    }
  }
}
