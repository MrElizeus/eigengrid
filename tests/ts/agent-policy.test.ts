import { describe, it, expect } from "bun:test";
import {
  getDefaultPolicies,
  getDefaultPermissionRules,
  getToolPolicy,
  isToolDenied,
  requiresApproval,
} from "@eigengrid/agent";
import { checkPermission } from "@eigengrid/core";
import type { PermissionRuleset } from "@eigengrid/core";

// ────────────────────────────────────────────────────────────
// Default Policies
// ────────────────────────────────────────────────────────────

describe("getDefaultPolicies", () => {
  it("returns allow/deny arrays", () => {
    const policies = getDefaultPolicies();
    expect(policies).toHaveProperty("allow");
    expect(policies).toHaveProperty("deny");
    expect(Array.isArray(policies.allow)).toBe(true);
    expect(Array.isArray(policies.deny)).toBe(true);
  });

  it("allows doctor", () => {
    const policies = getDefaultPolicies();
    expect(policies.allow).toContain("doctor");
  });
});

// ────────────────────────────────────────────────────────────
// Permission Rules
// ────────────────────────────────────────────────────────────

describe("getDefaultPermissionRules", () => {
  it("returns a valid PermissionRuleset", () => {
    const rules = getDefaultPermissionRules();
    expect(Array.isArray(rules)).toBe(true);
    expect(rules.length).toBeGreaterThan(0);

    for (const rule of rules) {
      expect(rule).toHaveProperty("action");
      expect(rule).toHaveProperty("resource");
      expect(rule).toHaveProperty("effect");
      expect(["allow", "deny", "ask"]).toContain(rule.effect);
    }
  });
});

// ────────────────────────────────────────────────────────────
// Read-only tools pass (allow)
// ────────────────────────────────────────────────────────────

describe("Read-only tools are allowed", () => {
  const rules = getDefaultPermissionRules();

  const readOnlyTools = [
    "doctor",
    "list-jobs",
    "get-job-status",
    "read-log",
    "list-nodes",
    "inspect-node",
  ];

  for (const tool of readOnlyTools) {
    it(`${tool} is allowed`, () => {
      const result = checkPermission("tool:execute", tool, rules);
      expect(result.effect).toBe("allow");
    });
  }
});

// ────────────────────────────────────────────────────────────
// Mutating tools require approval (ask) in default policy
// ────────────────────────────────────────────────────────────

describe("Mutating tools require approval", () => {
  const defaultRules = getDefaultPermissionRules();

  it("submit-job requires ask approval", () => {
    const result = checkPermission("tool:execute", "submit-job", defaultRules);
    // submit-job has "ask" in the default rules, not "allow"
    expect(result.effect).toBe("ask");
  });

  it("cancel-job requires ask approval", () => {
    const result = checkPermission("tool:execute", "cancel-job", defaultRules);
    // cancel-job has "ask" in the default rules, not "allow"
    expect(result.effect).toBe("ask");
  });

  it("parse-job-output requires ask approval", () => {
    expect(checkPermission("tool:execute", "parse-job-output", defaultRules).effect).toBe("ask");
  });
});

describe("Default rules fail closed", () => {
  it("denies unknown tools", () => {
    expect(
      checkPermission("tool:execute", "unknown-tool", getDefaultPermissionRules()).effect,
    ).toBe("deny");
  });

  it("keeps approval helpers aligned with the permission evaluator", () => {
    for (const tool of ["submit-job", "cancel-job", "parse-job-output", "unknown-tool"]) {
      const effect = checkPermission("tool:execute", tool, getDefaultPermissionRules()).effect;
      expect(getToolPolicy(tool).effect).toBe(effect);
      expect(requiresApproval(tool)).toBe(effect === "ask");
      expect(isToolDenied(tool)).toBe(effect === "deny");
    }
  });
});

describe("Permission evaluator", () => {
  it("matches both action and resource wildcards with deterministic last-match-wins", () => {
    const wildcardRules: PermissionRuleset = [
      { action: "agent.*", resource: "job.*", effect: "ask" },
    ];
    expect(checkPermission("agent.execute", "job.7", wildcardRules).effect).toBe("ask");

    const rules: PermissionRuleset = [
      { action: "*", resource: "*", effect: "deny" },
      { action: "tool:execute", resource: "job-42", effect: "allow" },
      { action: "tool:execute", resource: "job-42", effect: "deny" },
    ];

    expect(checkPermission("tool:execute", "job-7", rules).effect).toBe("deny");
    expect(checkPermission("tool:execute", "job-42", rules).matchedRule).toBe(rules[2]);
    expect(checkPermission("tool:execute", "other", rules).effect).toBe("deny");
  });

  it("allows a later matching allow rule to override an earlier deny", () => {
    const rules: PermissionRuleset = [
      { action: "*", resource: "*", effect: "deny" },
      { action: "tool:execute", resource: "doctor", effect: "allow" },
    ];
    expect(checkPermission("tool:execute", "doctor", rules).effect).toBe("allow");
  });
});

// ────────────────────────────────────────────────────────────
// No tool slips through implicitly — all state-changing tools
// have explicit permission rules in the default set
// ────────────────────────────────────────────────────────────

describe("All state-changing tools have explicit permission rules", () => {
  const rules = getDefaultPermissionRules();
  const ruleResources = new Set(rules.map((r) => r.resource));

  const stateChangingTools = ["submit-job", "cancel-job", "parse-job-output"];

  for (const tool of stateChangingTools) {
    it(`${tool} has an explicit permission rule (not implicit)`, () => {
      expect(ruleResources.has(tool)).toBe(true);
    });
  }
});

// ────────────────────────────────────────────────────────────
// Dry-run mode: ALL mutating tools blocked
// ────────────────────────────────────────────────────────────

describe("Dry-run mode blocks mutations", () => {
  it("blocks submit-job in dry-run ruleset", () => {
    const dryRunRules: PermissionRuleset = [
      { action: "tool:execute", resource: "submit-job", effect: "deny" },
      { action: "tool:execute", resource: "cancel-job", effect: "deny" },
      { action: "tool:execute", resource: "parse-job-output", effect: "deny" },
    ];

    expect(checkPermission("tool:execute", "submit-job", dryRunRules).effect).toBe("deny");
    expect(checkPermission("tool:execute", "cancel-job", dryRunRules).effect).toBe("deny");
    expect(checkPermission("tool:execute", "parse-job-output", dryRunRules).effect).toBe("deny");
  });

  it("allows read-only tools even with dry-run rules", () => {
    const dryRunRules: PermissionRuleset = [
      { action: "tool:execute", resource: "submit-job", effect: "deny" },
      { action: "tool:execute", resource: "cancel-job", effect: "deny" },
    ];

    // Without explicit deny rules for read tools, they default to allow
    expect(checkPermission("tool:execute", "doctor", dryRunRules).effect).toBe("allow");
    expect(checkPermission("tool:execute", "list-jobs", dryRunRules).effect).toBe("allow");
    expect(checkPermission("tool:execute", "get-job-status", dryRunRules).effect).toBe("allow");
    expect(checkPermission("tool:execute", "read-log", dryRunRules).effect).toBe("allow");
  });

  it("allows DB/log reads in dry-run but blocks submits", () => {
    const dryRunRules: PermissionRuleset = [
      { action: "tool:execute", resource: "submit-job", effect: "deny" },
      { action: "tool:execute", resource: "cancel-job", effect: "deny" },
    ];

    // Reading DB/logs/artifacts is OK (no deny rule)
    expect(checkPermission("tool:execute", "get-job-status", dryRunRules).effect).toBe("allow");
    expect(checkPermission("tool:execute", "read-log", dryRunRules).effect).toBe("allow");

    // Submitting/canceling is BLOCKED
    expect(checkPermission("tool:execute", "submit-job", dryRunRules).effect).toBe("deny");
    expect(checkPermission("tool:execute", "cancel-job", dryRunRules).effect).toBe("deny");
  });
});
