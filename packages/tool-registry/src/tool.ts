import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Tool, ToolContext, ToolResult, Settlement, Content } from "./types";

// ────────────────────────────────────────────────────────────
// Opaque Tool Definition
// ────────────────────────────────────────────────────────────

declare const TypeId: unique symbol;

/**
 * Opaque branded type returned by `Tool.make()`. Consumers
 * receive an immutable reference; runtime internals are stored
 * in a WeakMap keyed on this object, preventing prototype
 * pollution and surface tampering.
 */
export interface Definition<
  Input extends z.ZodTypeAny = z.ZodTypeAny,
  Output extends z.ZodTypeAny = z.ZodTypeAny,
> {
  readonly [TypeId]: {
    readonly _Input: Input;
    readonly _Output: Output;
  };
}

export type AnyTool = Definition<any, any>;

// ────────────────────────────────────────────────────────────
// WeakMap Runtime Store
// ────────────────────────────────────────────────────────────

interface Runtime {
  readonly description: string;
  readonly input: z.ZodTypeAny;
  readonly output: z.ZodTypeAny;
  readonly execute: (input: unknown, ctx: ToolContext) => Promise<ToolResult>;
  readonly toModelOutput?: (output: SettlementIO) => Content[];
  readonly permission?: string;
}

interface SettlementIO {
  input: unknown;
  output: unknown;
}

const runtimes = new WeakMap<AnyTool, Runtime>();

function runtimeOf(tool: AnyTool): Runtime {
  const r = runtimes.get(tool);
  if (!r)
    throw new TypeError("Tool is not a valid EigenGrid Definition — did you use Tool.make()?");
  return r;
}

// ────────────────────────────────────────────────────────────
// Configuration & Factory
// ────────────────────────────────────────────────────────────

export interface ToolConfig<Input extends z.ZodTypeAny, Output extends z.ZodTypeAny> {
  /** Human-readable description of what the tool does. */
  description: string;
  /** Zod schema for the tool's expected input. */
  input: Input;
  /** Zod schema for the tool's guaranteed output shape. */
  output: Output;
  /**
   * Pure async execution function. Receives validated input and
   * the system ToolContext. Must return a ToolResult.
   */
  execute: (input: z.infer<Input>, ctx: ToolContext) => Promise<ToolResult<z.infer<Output>>>;
  /**
   * Optional formatter that converts raw execution output into
   * model-facing content chunks (text + file attachments).
   * Defaults to a single text chunk with the JSON-stringified output.
   */
  toModelOutput?: (io: { input: z.infer<Input>; output: z.infer<Output> }) => Content[];
}

/**
 * Create a new opaque tool Definition.
 *
 * The returned object is an immutable branded symbol. Runtime
 * behaviour (schemas, execute, permission) is stored in an
 * internal WeakMap and is inaccessible from the consumer side.
 *
 * @example
 * const greetTool = Tool.make({
 *   description: "Greet a user by name",
 *   input: z.object({ name: z.string() }),
 *   output: z.object({ greeting: z.string() }),
 *   async execute(input, ctx) {
 *     return { ok: true, data: { greeting: `Hello, ${input.name}!` } };
 *   },
 * });
 */
export function make<Input extends z.ZodTypeAny, Output extends z.ZodTypeAny>(
  config: ToolConfig<Input, Output>,
): Definition<Input, Output> {
  const tool = Object.freeze({}) as Definition<Input, Output>;

  runtimes.set(tool, {
    description: config.description,
    input: config.input,
    output: config.output,
    execute: config.execute as (input: unknown, ctx: ToolContext) => Promise<ToolResult>,
    toModelOutput: config.toModelOutput,
  });

  return tool;
}

/**
 * Wrap a legacy `Tool` interface object into a runtime-compatible
 * `AnyTool` so it can be used through `materialize()` and
 * `definition()`.  The returned object carries the same
 * `.inputSchema` / `.outputSchema` / `.execute` properties so
 * the existing `reg.execute()` code path also works.
 */
export function registerLegacy(tool: Tool): AnyTool {
  const wrapper = {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    execute: tool.execute,
  } as unknown as AnyTool;

  runtimes.set(wrapper, {
    description: tool.description,
    input: tool.inputSchema,
    output: tool.outputSchema,
    execute: (input: unknown, ctx: ToolContext) => tool.execute(ctx, input),
  });

  return wrapper;
}

// ────────────────────────────────────────────────────────────
// Permission Decorator
// ────────────────────────────────────────────────────────────

/**
 * Attach an immutable permission requirement to a tool.
 * Returns a NEW opaque Definition — the original is unchanged.
 *
 * The permission string is evaluated at materialization time
 * against the active PermissionRuleset. If the permission is
 * wholly denied, the tool is excluded from the materialized set.
 *
 * @example
 * const restrictedTool = Tool.withPermission(greetTool, "greet.execute");
 */
export function withPermission<Input extends z.ZodTypeAny, Output extends z.ZodTypeAny>(
  tool: Definition<Input, Output>,
  permission: string,
): Definition<Input, Output> {
  const base = runtimeOf(tool);
  const decorated = Object.freeze({}) as Definition<Input, Output>;

  runtimes.set(decorated, { ...base, permission });

  return decorated;
}

/**
 * Read the permission action attached to a tool, falling back
 * to the canonical action used by legacy tools.
 */
export function permissionOf(tool: AnyTool, _fallbackName: string): string {
  return runtimeOf(tool).permission ?? "tool:execute";
}

// ────────────────────────────────────────────────────────────
// Settlement Pipeline (Two-Phase)
// ────────────────────────────────────────────────────────────

/**
 * Internal call shape produced by the agent loop or the Tool
 * Registry's materialized settle function.
 */
export interface Call {
  name: string;
  input: unknown;
  id: string;
  /** Injected by the host adapter; never decoded from model arguments. */
  sessionId?: string;
}

/**
 * Execute the two-phase settlement pipeline against a tool:
 *
 *   Phase 1 — DECODE: validate `call.input` against the tool's
 *              input schema. Fail fast with ExecutionError on
 *              schema mismatch.
 *
 *   Phase 2 — EXECUTE: run the tool's `execute()` with the
 *              decoded input. Catch runtime errors and wrap them
 *              in ExecutionError.
 *
 *   Phase 3 — ENCODE: validate the raw output against the tool's
 *              output schema.
 *
 *   Phase 4 — FORMAT: convert the encoded output into model-
 *              facing Content[] chunks.
 *
 * Returns a Settlement with `ok: true` on success, or
 * `ok: false` with an ExecutionError-compatible payload.
 */
export async function settle(
  tool: AnyTool,
  call: Call,
  ctx: ToolContext,
  guard?: import("./registry").InvocationGuard,
): Promise<Settlement> {
  const rt = runtimeOf(tool);

  // ── Phase 1: Decode Input ──────────────────────────────
  const inputResult = rt.input.safeParse(call.input);
  if (!inputResult.success) {
    return {
      ok: false,
      content: [{ type: "text", text: `Invalid tool input: ${inputResult.error.message}` }],
      error: {
        code: "INVALID_INPUT",
        message: inputResult.error.message,
        hint: "Check the input fields against the tool schema.",
      },
    };
  }

  // ── Phase 2: Execute ───────────────────────────────────
  let rawOutput: ToolResult;
  try {
    if (guard) {
      const authorized = await guard(call, ctx);
      if (!authorized.allow)
        return {
          ok: false,
          content: [
            { type: "text", text: authorized.reason ?? "Operator policy denied this action" },
          ],
          error: {
            code: "PERMISSION_DENIED",
            message: authorized.reason ?? "Operator policy denied this action",
          },
        };
    }
    rawOutput = await rt.execute(inputResult.data, ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      content: [{ type: "text", text: `Tool execution failed: ${message}` }],
      error: {
        code: "EXECUTION_ERROR",
        message,
        hint: "Check the tool implementation or runtime dependencies.",
      },
    };
  }

  if (!rawOutput.ok || rawOutput.error) {
    return {
      ok: false,
      content: [{ type: "text", text: rawOutput.error?.message ?? "Tool returned ok: false" }],
      error: rawOutput.error ?? { code: "TOOL_REJECTED", message: "Tool returned ok: false" },
    };
  }

  // ── Phase 3: Encode Output ─────────────────────────────
  const outputResult = rt.output.safeParse(rawOutput.data);
  if (!outputResult.success) {
    return {
      ok: false,
      content: [
        {
          type: "text",
          text: `Tool returned output that does not match its schema: ${outputResult.error.message}`,
        },
      ],
      error: {
        code: "INVALID_OUTPUT",
        message: outputResult.error.message,
        hint: "The tool's execute() returned data that violates its outputSchema.",
      },
    };
  }

  const encodedOutput = outputResult.data;

  // ── Phase 4: Format for Consumption ────────────────────
  const content: Content[] = rt.toModelOutput
    ? rt.toModelOutput({ input: inputResult.data, output: encodedOutput })
    : defaultFormatter(encodedOutput);

  return {
    ok: true,
    output: encodedOutput,
    content,
  };
}

function defaultFormatter(output: unknown): Content[] {
  if (typeof output === "string") {
    return [{ type: "text", text: output }];
  }
  return [{ type: "text", text: JSON.stringify(output, null, 2) }];
}

// ────────────────────────────────────────────────────────────
// JSON Schema Definition (LLM-facing)
// ────────────────────────────────────────────────────────────

/**
 * Produce a JSON Schema representation of the tool's input
 * and output schemas, suitable for LLM tool-use APIs (OpenAI,
 * Anthropic, etc.).
 */
export function definition(name: string, tool: AnyTool): ToolJSONDefinition {
  const rt = runtimeOf(tool);
  return {
    name,
    description: rt.description,
    inputSchema: toJSONSchema(rt.input),
    outputSchema: toJSONSchema(rt.output),
  };
}

function toJSONSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const result: unknown = zodToJsonSchema(schema, {
    target: "jsonSchema7",
    $refStrategy: "none",
  });
  if (!isPlainRecord(result)) {
    throw new TypeError("zod-to-json-schema returned a non-object schema");
  }
  return result;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export interface ToolJSONDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

// ────────────────────────────────────────────────────────────
// Name Validation
// ────────────────────────────────────────────────────────────

const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export function validateName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new TypeError(
      `Invalid tool name "${name}". Tool names must start with a letter and contain only letters, digits, hyphens, and underscores (max 64 characters).`,
    );
  }
}

// ────────────────────────────────────────────────────────────
// Re-export for convenience
// ────────────────────────────────────────────────────────────

export { Content };
