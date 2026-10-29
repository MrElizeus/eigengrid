import { deny, allow } from "@eigengrid/core";
import type { PermissionRuleset } from "./types";
import { ToolRegistry, type Materialization } from "./registry";

/** Builtin read-only names that may be exposed to the hard host-enforced /plan mode. */
export const PLAN_MODE_READ_ONLY_TOOL_NAMES = Object.freeze([
  "inspect-node",
  "read-log",
  "list-jobs",
  "get-job-status",
  "list-nodes",
  "doctor",
  "md-fetch-structure",
  "md-search-structure",
]);

/**
 * Materialize a deny-by-default tool snapshot for Plan Mode. Mutating tools
 * are absent from `definitions` and remain denied even if an upstream agent
 * asks for them by name. This is an application host invariant, not a prompt.
 */
export function materializePlanMode(
  registry: ToolRegistry,
  allowedNames: readonly string[] = PLAN_MODE_READ_ONLY_TOOL_NAMES,
): Materialization {
  const rules: PermissionRuleset = [
    deny("*", "*"),
    ...allowedNames.map((name) => allow("*", name)),
  ];
  const snapshot = registry.materialize(rules);
  const allowed = new Set(allowedNames);
  return {
    ...snapshot,
    definitions: snapshot.definitions.filter((definition) => allowed.has(definition.name)),
    approvalRequiredDefinitions: [],
    settle: async (call, ctx) => {
      if (!allowed.has(call.name)) {
        return {
          ok: false,
          content: [{ type: "text" as const, text: `Plan Mode denied tool: ${call.name}` }],
          error: {
            code: "PLAN_MODE_DENIED",
            message: `Tool '${call.name}' is not available in Plan Mode.`,
          },
        };
      }
      return snapshot.settle(call, ctx);
    },
  };
}
