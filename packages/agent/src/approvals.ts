import { checkPermission } from "@eigengrid/core";
import { getDefaultPermissionRules } from "./policies";

export type ToolPolicy = {
  toolName: string;
  effect: "allow" | "deny" | "ask";
};

export function getToolPolicy(toolName: string): ToolPolicy {
  return {
    toolName,
    effect: checkPermission("tool:execute", toolName, getDefaultPermissionRules()).effect,
  };
}

export function requiresApproval(toolName: string): boolean {
  const policy = getToolPolicy(toolName);
  return policy?.effect === "ask";
}

export function isToolDenied(toolName: string): boolean {
  return getToolPolicy(toolName)?.effect === "deny";
}
