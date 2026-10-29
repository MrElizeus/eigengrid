import type { PermissionEffect, PermissionRule, PermissionRuleset } from "../types";

// ────────────────────────────────────────────────────────────
// Runtime Permission Assertion
// ────────────────────────────────────────────────────────────

/**
 * Result of evaluating an action+resource against a ruleset.
 */
export interface PermissionResult {
  /** The resolved effect: allow, deny, or ask. */
  effect: PermissionEffect;
  /** The specific rule that matched (last-match-wins). */
  matchedRule?: PermissionRule;
}

/**
 * Evaluate whether an action on a resource is permitted by the
 * given ruleset. Uses last-match-wins semantics over wildcard
 * patterns.
 *
 * The ruleset is evaluated in order. The LAST matching rule's
 * effect is the final verdict. If no rule matches, the default
 * effect is "allow" (open by default, restrict by exception).
 *
 * @example
 * const ruleset: PermissionRuleset = [
 *   { action: "submit.*", resource: "*", effect: "allow" },
 *   { action: "submit.gaussian", resource: "*", effect: "deny" },
 * ];
 *
 * const result = checkPermission("submit.gaussian", "input.gjf", ruleset);
 * // → { effect: "deny", matchedRule: { action: "submit.gaussian", resource: "*", effect: "deny" } }
 */
export function checkPermission(
  action: string,
  resource: string,
  rules: PermissionRuleset,
): PermissionResult {
  let lastMatch: { effect: PermissionEffect; rule: PermissionRule } | undefined;

  for (const rule of rules) {
    if (wildcardMatch(action, rule.action) && wildcardMatch(resource, rule.resource)) {
      lastMatch = { effect: rule.effect, rule };
    }
  }

  if (lastMatch) {
    return { effect: lastMatch.effect, matchedRule: lastMatch.rule };
  }

  // Default: allow (open-by-default, restrict-by-exception)
  return { effect: "allow" };
}

/**
 * Assert that an action on a resource is allowed. Throws
 * PermissionDeniedError if denied.
 *
 * If the effect is "ask", the caller should request human
 * approval before proceeding.
 *
 * @throws {import("../errors").PermissionDeniedError}
 */
export function assertPermission(action: string, resource: string, rules: PermissionRuleset): void {
  const result = checkPermission(action, resource, rules);

  if (result.effect === "deny") {
    const { PermissionDeniedError } = require("../errors");
    throw new PermissionDeniedError(action, resource);
  }

  if (result.effect === "ask") {
    // "ask" is not a denial — it means the caller should prompt
    // the user. We return without throwing, and the caller checks
    // `result.effect === "ask"` to decide whether to prompt.
    return;
  }
}

/**
 * Determine if a tool action is wholly disabled by a ruleset.
 * A tool is wholly disabled when the last matching rule has
 * effect "deny" AND resource is "*" (meaning deny all resources
 * for that action).
 */
export function isWhollyDisabled(action: string, rules: PermissionRuleset): boolean {
  const result = checkPermission(action, "*", rules);
  return result.effect === "deny" && result.matchedRule?.resource === "*";
}

// ────────────────────────────────────────────────────────────
// Wildcard Matching
// ────────────────────────────────────────────────────────────

/**
 * Simple wildcard matcher. Supports:
 * - `*` — matches everything
 * - `prefix.*` — matches any string starting with `prefix.`
 * - exact string — matches only that string
 */
export function wildcardMatch(value: string, pattern: string): boolean {
  if (pattern === "*") return true;

  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2);
    return value === prefix || value.startsWith(`${prefix}.`);
  }

  return value === pattern;
}

// ────────────────────────────────────────────────────────────
// Permission Builder Utilities
// ────────────────────────────────────────────────────────────

/**
 * Create a permission rule that allows an action.
 */
export function allow(action: string, resource: string = "*"): PermissionRule {
  return { action, resource, effect: "allow" };
}

/**
 * Create a permission rule that denies an action.
 */
export function deny(action: string, resource: string = "*"): PermissionRule {
  return { action, resource, effect: "deny" };
}

/**
 * Create a permission rule that requires human approval.
 */
export function ask(action: string, resource: string = "*"): PermissionRule {
  return { action, resource, effect: "ask" };
}
