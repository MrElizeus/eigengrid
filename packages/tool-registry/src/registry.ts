import type {
  Tool,
  ToolContext,
  ToolResult,
  Settlement,
  PermissionEffect,
  PermissionRuleset,
} from "./types";
import {
  settle as settleTool,
  definition as toolDefinition,
  validateName,
  permissionOf,
  registerLegacy,
} from "./tool";
import type { AnyTool, Call, ToolJSONDefinition } from "./tool";
import { checkPermission } from "@eigengrid/core";

// ────────────────────────────────────────────────────────────
// Registration Entry
// ────────────────────────────────────────────────────────────

type Registration = {
  /** Opaque identity object for stale-call detection. */
  readonly identity: object;
  /** Wrapped tool — either the legacy Tool interface or an
   *  opaque AnyTool (Definition from Tool.make()). */
  readonly tool: AnyTool;
};

/**
 * Stacked registration stores registrations per name. When
 * multiple registrations exist for the same name, the latest
 * (last pushed) wins. This allows session-scoped overlays on
 * top of application-level builtins.
 */
type StackEntry = {
  readonly token: object;
  readonly registration: Registration;
};

// ────────────────────────────────────────────────────────────
// Materialization
// ────────────────────────────────────────────────────────────

/**
 * A frozen snapshot of available tools at a point in time.
 * Produced by `ToolRegistry.materialize()`.
 */
export interface Materialization {
  /** LLM-facing JSON Schema definitions. */
  definitions: ToolJSONDefinition[];
  /** Tools that require approval and cannot be settled from this snapshot. */
  approvalRequiredDefinitions: ToolJSONDefinition[];
  /**
   * Settle a tool call against this materialization snapshot.
   * Returns an error result for unknown or stale tool names.
   */
  settle(input: Call, ctx: ToolContext): Promise<Settlement>;
}

/** Host-owned final execution barrier. This is never populated from tool input. */
export type InvocationGuard = (
  call: Readonly<Call>,
  ctx: ToolContext,
) => Promise<{ allow: boolean; reason?: string }>;

// ────────────────────────────────────────────────────────────
// ToolRegistry
// ────────────────────────────────────────────────────────────

export class ToolRegistry {
  /** Application-level tools (always present, never scoped). */
  private applications = new Map<string, Registration>();

  /** Session-scoped stacked registrations. */
  private local = new Map<string, StackEntry[]>();

  /** Default rules enforced by all public lookup and execution paths. */
  private defaultPermissions?: PermissionRuleset;

  constructor(
    permissions?: PermissionRuleset,
    private readonly invocationGuard?: InvocationGuard,
  ) {
    this.defaultPermissions = permissions?.map((rule) => ({ ...rule }));
  }

  /** Host-only policy replacement. Materialized snapshots revalidate at settle-time. */
  replacePermissions(permissions: PermissionRuleset): void {
    this.defaultPermissions = permissions.map((rule) => ({ ...rule }));
  }

  /** Unknown policy or missing rule is DENY irrespective of core's legacy default. */
  private decision(
    name: string,
    registration: Registration,
    rules?: PermissionRuleset,
  ): PermissionEffect {
    if (!rules) return "deny";
    const decision = checkPermission(permissionOf(registration.tool, name), name, rules);
    return decision.matchedRule ? decision.effect : "deny";
  }

  // ── Legacy Tool Interface Registration ─────────────────

  /**
   * Register a tool using the legacy `Tool` interface.
   * The tool is stored as an application-level registration.
   * For session-scoped overlays, use `registerDefinition()`.
   */
  register(tool: Tool): void {
    const identity = {};
    this.applications.set(tool.name, { identity, tool: registerLegacy(tool) });
  }

  /**
   * Register a `Tool.make()` Definition in the application
   * (always-present) layer. The tool's permission string is
   * derived from the optional permission decorator.
   */
  registerDefinition(name: string, tool: AnyTool): void {
    validateName(name);
    const identity = {};
    this.applications.set(name, { identity, tool });
  }

  /**
   * Register a tool for the current session scope. Multiple
   * registrations per name stack; the latest wins on
   * materialization. When the scope is released (e.g., session
   * ends), the registration is removed and the previous one
   * becomes active again.
   *
   * Returns a deregistration function.
   */
  registerScoped(name: string, tool: AnyTool): () => void {
    validateName(name);
    const token = {};
    const registration: Registration = { identity: {}, tool };

    const entries = this.local.get(name) ?? [];
    entries.push({ token, registration });
    this.local.set(name, entries);

    return () => {
      const current = this.local.get(name);
      if (!current) return;
      const filtered = current.filter((e) => e.token !== token);
      if (filtered.length > 0) {
        this.local.set(name, filtered);
      } else {
        this.local.delete(name);
      }
    };
  }

  /** Authoritative current effect for one registered tool. Unmatched => deny. */
  decisionFor(name: string, permissions?: PermissionRuleset): PermissionEffect {
    const registration = this.visibleRegistration(name);
    if (!registration) return "deny";
    return this.materializationPermissionEffect(name, registration, permissions);
  }

  /** A host-controlled approval authority verifies exact session/call/input/expiry.
   * The model cannot supply this callback or an approval bit.
   */
  async settleAuthorized(
    call: Call,
    ctx: ToolContext,
    permissions?: PermissionRuleset,
    verifyApproval?: () => Promise<boolean>,
  ): Promise<Settlement> {
    const current = this.visibleRegistration(call.name);
    const effect = this.decisionFor(call.name, permissions);
    if (!current || effect === "deny") {
      return {
        ok: false,
        content: [{ type: "text", text: "Tool not authorized" }],
        error: { code: "PERMISSION_DENIED", message: "Current policy denies this tool" },
      };
    }
    if (effect === "ask" && (!verifyApproval || !(await verifyApproval()))) {
      return {
        ok: false,
        content: [{ type: "text", text: "Approval required" }],
        error: { code: "APPROVAL_REQUIRED", message: "Host approval missing or expired" },
      };
    }
    if (effect === "ask" && (!verifyApproval || !(await verifyApproval()))) {
      return {
        ok: false,
        content: [{ type: "text", text: "Approval revoked" }],
        error: { code: "APPROVAL_REQUIRED", message: "Host approval expired before effect" },
      };
    }
    if (
      this.visibleRegistration(call.name)?.identity !== current.identity ||
      this.decisionFor(call.name, permissions) !== effect
    ) {
      return {
        ok: false,
        content: [{ type: "text", text: "Authority changed" }],
        error: { code: "PERMISSION_DENIED", message: "Authorization changed before execution" },
      };
    }
    return this.settleGuarded(
      current.tool,
      call,
      ctx,
      () =>
        this.visibleRegistration(call.name)?.identity === current.identity &&
        this.decisionFor(call.name, permissions) === effect,
    );
  }

  private settleGuarded(
    tool: AnyTool,
    call: Call,
    ctx: ToolContext,
    stillAuthorized?: () => boolean,
  ): Promise<Settlement> {
    if (!this.invocationGuard) return settleTool(tool, call, ctx);
    return settleTool(tool, call, ctx, async (invocation, context) => {
      const result = await this.invocationGuard!(invocation, context);
      if (result.allow && stillAuthorized && !stillAuthorized())
        return { allow: false, reason: "Tool authority changed before execution" };
      return result;
    });
  }

  private publicTool(name: string, registration: Registration): Tool {
    const tool = registration.tool as unknown as Tool;
    if (!this.invocationGuard) return tool;
    return { ...tool, execute: (ctx, input) => this.execute(name, ctx, input) };
  }

  // ── Lookup ─────────────────────────────────────────────

  /**
   * Resolve a tool by name. Checks session-scoped registrations
   * first (latest wins), then falls back to application-level.
   */
  get(name: string): Tool | undefined {
    const registration = this.visibleRegistration(name);
    if (!registration || this.permissionEffect(name, registration) !== "allow") return undefined;
    return this.publicTool(name, registration);
  }

  /**
   * List all currently visible tools (session-scoped overlays
   * replace application-level entries).
   */
  list(): Tool[] {
    const merged = new Map<string, Registration>(this.applications);

    for (const [name, entries] of this.local) {
      const latest = entries.at(-1)?.registration;
      if (latest) {
        merged.set(name, latest);
      } else {
        merged.delete(name);
      }
    }

    return Array.from(merged.entries())
      .filter(([name, registration]) => this.permissionEffect(name, registration) === "allow")
      .map(([name, registration]) => this.publicTool(name, registration));
  }

  // ── Execution (Legacy) ─────────────────────────────────

  /**
   * Legacy synchronous execution path. Validates input against
   * the tool's Zod schema, executes, and returns a ToolResult.
   *
   * Prefer `materialize().settle()` for agentic execution.
   */
  async execute(name: string, ctx: ToolContext, input: unknown): Promise<ToolResult> {
    const registration = this.visibleRegistration(name);
    if (!registration) {
      return { ok: false, error: { code: "TOOL_NOT_FOUND", message: `Tool '${name}' not found` } };
    }

    const effect = this.permissionEffect(name, registration);
    if (effect === "deny") {
      return {
        ok: false,
        error: {
          code: "PERMISSION_DENIED",
          message: `Tool '${name}' is denied by permission rules`,
        },
      };
    }
    if (effect === "ask") {
      return {
        ok: false,
        error: {
          code: "APPROVAL_REQUIRED",
          message: `Tool '${name}' requires approval before execution`,
        },
      };
    }

    const tool = registration.tool as unknown as Tool;

    const parsed = tool.inputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: "INVALID_INPUT",
          message: parsed.error.message,
          hint: "Check the input schema",
        },
      };
    }

    try {
      if (this.invocationGuard) {
        const settled = await this.settleGuarded(
          registration.tool,
          { name, input, id: crypto.randomUUID() },
          ctx,
          () =>
            this.visibleRegistration(name)?.identity === registration.identity &&
            this.permissionEffect(name, registration) === "allow",
        );
        return settled.ok
          ? { ok: true, data: settled.output }
          : { ok: false, error: settled.error };
      }
      return await tool.execute(ctx, parsed.data);
    } catch (err) {
      return {
        ok: false,
        error: { code: "TOOL_ERROR", message: String(err), hint: "Check tool implementation" },
      };
    }
  }

  // ── Materialization ────────────────────────────────────

  /**
   * Produce a frozen snapshot of all visible tools, filtered by
   * the optional permission ruleset.
   *
   * The returned `Materialization` contains:
   *  - `definitions`: LLM-facing JSON Schema descriptions.
   *  - `settle`: a bound settle function scoped to this snapshot.
   *
   * Stale tool calls (where the registration identity changed
   * after materialization) are detected and rejected.
   */
  materialize(permissions?: PermissionRuleset): Materialization {
    // ── 1. Merge registrations ────────────────────────────
    const registrations = new Map<string, Registration>(this.applications);

    for (const [name, entries] of this.local) {
      const latest = entries.at(-1)?.registration;
      if (latest) {
        registrations.set(name, latest);
      }
    }

    // ── 2. Classify by permissions ───────────────────────
    const approvalRequired = new Map<string, Registration>();
    for (const [name, reg] of registrations) {
      const effect = this.materializationPermissionEffect(name, reg, permissions);
      if (effect === "deny") {
        registrations.delete(name);
      } else if (effect === "ask") {
        registrations.delete(name);
        approvalRequired.set(name, reg);
      }
    }

    // ── 3. Build snapshot ────────────────────────────────
    const snapshot = new Map(registrations);

    const definitions = Array.from(snapshot.entries()).map(([name, reg]) =>
      toolDefinition(name, reg.tool),
    );
    const approvalRequiredDefinitions = Array.from(approvalRequired.entries()).map(([name, reg]) =>
      toolDefinition(name, reg.tool),
    );

    const settle = async (call: Call, ctx: ToolContext) => {
      const reg = snapshot.get(call.name);
      if (!reg) {
        return {
          ok: false,
          content: [{ type: "text" as const, text: `Unknown tool: ${call.name}` }],
          error: {
            code: "TOOL_NOT_FOUND",
            message: `Tool '${call.name}' not found in this materialization snapshot.`,
          },
        };
      }
      if (this.visibleRegistration(call.name)?.identity !== reg.identity) {
        return {
          ok: false,
          content: [{ type: "text" as const, text: "Stale tool registration" }],
          error: { code: "STALE_TOOL", message: "Tool registration changed after materialization" },
        };
      }
      if (this.materializationPermissionEffect(call.name, reg, permissions) !== "allow") {
        return {
          ok: false,
          content: [{ type: "text" as const, text: "Tool authorization changed" }],
          error: {
            code: "PERMISSION_DENIED",
            message: "Current tool policy does not permit effect",
          },
        };
      }
      return this.settleGuarded(
        reg.tool,
        call,
        ctx,
        () =>
          this.visibleRegistration(call.name)?.identity === reg.identity &&
          this.materializationPermissionEffect(call.name, reg, permissions) === "allow",
      );
    };

    return { definitions, approvalRequiredDefinitions, settle };
  }

  private visibleRegistration(name: string): Registration | undefined {
    return this.local.get(name)?.at(-1)?.registration ?? this.applications.get(name);
  }

  private permissionEffect(name: string, registration: Registration) {
    return this.decision(name, registration, this.defaultPermissions);
  }

  private materializationPermissionEffect(
    name: string,
    registration: Registration,
    permissions?: PermissionRuleset,
  ): PermissionEffect {
    const boundEffect = this.decision(name, registration, this.defaultPermissions);
    const suppliedEffect =
      permissions === undefined ? "allow" : this.decision(name, registration, permissions);

    return moreRestrictiveEffect(boundEffect, suppliedEffect);
  }
}

function moreRestrictiveEffect(left: PermissionEffect, right: PermissionEffect): PermissionEffect {
  const precedence: Record<PermissionEffect, number> = { allow: 0, ask: 1, deny: 2 };
  return precedence[left] >= precedence[right] ? left : right;
}
