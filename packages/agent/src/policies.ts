import type { PermissionRuleset } from "@eigengrid/core";

export type Policy = { allow: string[]; deny: string[] };

export function getDefaultPolicies(): Policy {
  return {
    allow: getDefaultPermissionRules()
      .filter((rule) => rule.action === "tool:execute" && rule.effect === "allow")
      .map((rule) => rule.resource),
    deny: [],
  };
}

export function getDefaultPermissionRules(): PermissionRuleset {
  return [
    { action: "*", resource: "*", effect: "deny" },
    { action: "tool:execute", resource: "doctor", effect: "allow" },
    { action: "tool:execute", resource: "list-jobs", effect: "allow" },
    { action: "tool:execute", resource: "get-job-status", effect: "allow" },
    { action: "tool:execute", resource: "read-log", effect: "allow" },
    { action: "tool:execute", resource: "list-nodes", effect: "allow" },
    { action: "tool:execute", resource: "inspect-node", effect: "allow" },
    { action: "tool:execute", resource: "list-artifacts", effect: "allow" },
    { action: "tool:execute", resource: "list-results", effect: "allow" },
    { action: "tool:execute", resource: "list-events", effect: "allow" },
    { action: "tool:execute", resource: "list-recipes", effect: "allow" },
    { action: "tool:execute", resource: "list-protocols", effect: "allow" },
    { action: "tool:execute", resource: "inspect-protocol", effect: "allow" },
    { action: "tool:execute", resource: "validate-md-protocol", effect: "allow" },
    { action: "tool:execute", resource: "operator-info", effect: "allow" },
    { action: "tool:execute", resource: "parse-output", effect: "ask" },
    { action: "tool:execute", resource: "parse-job-output", effect: "ask" },
    { action: "tool:execute", resource: "submit-job", effect: "ask" },
    { action: "tool:execute", resource: "cancel-job", effect: "ask" },
  ];
}
