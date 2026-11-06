import { relative, resolve } from "node:path";
import type { AgentToolCall } from "@eigengrid/agent-runtime";
import {
  OperatorPermissions,
  pathWithin,
  resolveOperatorFile,
} from "../services/operator-permissions";

const reads = new Set([
  "doctor",
  "list-jobs",
  "get-job-status",
  "read-log",
  "list-nodes",
  "inspect-node",
  "list-artifacts",
  "list-results",
  "list-events",
  "list-recipes",
  "list-protocols",
  "inspect-protocol",
  "validate-md-protocol",
  "read-file",
  "operator-info",
]);

/** Never inherit a CLI user's host-wide Full Access in a network-facing session. */
export class WebPermissions extends OperatorPermissions {
  override async authorizeTool(call: AgentToolCall & { sessionId?: string }) {
    if (!reads.has(call.name))
      return { allow: false, reason: "Web chat only permits project inspection." };
    if (call.name === "read-file") {
      try {
        const input = call.input as { path?: unknown };
        if (typeof input.path !== "string") throw new Error("Invalid path");
        const file = resolveOperatorFile(input.path, this.workspace);
        const parts = relative(this.workspace, file).split(/[\\/]/);
        if (
          !pathWithin(this.workspace, file) ||
          parts.some((part) => part.startsWith(".")) ||
          /\.(?:pem|key|sqlite(?:3)?|db)(?:-(?:wal|shm))?$/i.test(file) ||
          pathWithin(resolve(this.workspace, "node_modules"), file)
        )
          throw new Error("Private or external path");
      } catch {
        return {
          allow: false,
          reason:
            "Web chat can only read project files; credentials, hidden files and databases are excluded.",
        };
      }
    }
    return super.authorizeTool(call);
  }
}
