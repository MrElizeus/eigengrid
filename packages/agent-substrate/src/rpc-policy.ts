export const ALLOWED_CODEX_CLIENT_REQUEST_METHODS = Object.freeze([
  "initialize",
  "thread/start",
  "thread/resume",
  "thread/read",
  "turn/start",
  "turn/interrupt",
] as const);

export const ALLOWED_CODEX_SERVER_REQUEST_METHODS = Object.freeze(["item/tool/call"] as const);

export const ALLOWED_CODEX_CLIENT_NOTIFICATION_METHODS = Object.freeze(["initialized"] as const);

export type AllowedCodexClientRequestMethod = (typeof ALLOWED_CODEX_CLIENT_REQUEST_METHODS)[number];
export type AllowedCodexServerRequestMethod = (typeof ALLOWED_CODEX_SERVER_REQUEST_METHODS)[number];
export type AllowedCodexClientNotificationMethod =
  (typeof ALLOWED_CODEX_CLIENT_NOTIFICATION_METHODS)[number];
export type CodexRpcRequestDirection = "client" | "server";

export type AgentSubstrateRpcPolicyErrorCode = "FORBIDDEN_RPC_METHOD" | "UNKNOWN_RPC_METHOD";

export class AgentSubstrateRpcPolicyError extends Error {
  readonly name = "AgentSubstrateRpcPolicyError";

  constructor(
    public readonly code: AgentSubstrateRpcPolicyErrorCode,
    public readonly direction: CodexRpcRequestDirection,
    public readonly method: string,
  ) {
    super(`Agent substrate ${direction} request denied: ${method}`);
  }
}

const ALLOWED_CLIENT_REQUESTS = new Set<string>(ALLOWED_CODEX_CLIENT_REQUEST_METHODS);
const ALLOWED_SERVER_REQUESTS = new Set<string>(ALLOWED_CODEX_SERVER_REQUEST_METHODS);
const ALLOWED_CLIENT_NOTIFICATIONS = new Set<string>(ALLOWED_CODEX_CLIENT_NOTIFICATION_METHODS);

const FORBIDDEN_EXACT_METHODS = new Set([
  "thread/shellCommand",
  "thread/archive",
  "thread/delete",
  "thread/rollback",
  "thread/revert",
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "applyPatchApproval",
  "execCommandApproval",
]);

const FORBIDDEN_METHOD_PREFIXES = Object.freeze([
  "command/exec",
  "process/",
  "fs/",
  "config/",
  "externalAgentConfig/",
  "account/login",
  "account/logout",
  "plugin/",
  "marketplace/",
  "mcpServer/",
  "skills/config/",
  "permissionProfile/",
  "remoteControl/",
  "environment/",
  "windowsSandbox/",
] as const);

export function authorizeCodexClientRequest(method: string): AllowedCodexClientRequestMethod {
  authorizeRequest("client", method, ALLOWED_CLIENT_REQUESTS);
  return method as AllowedCodexClientRequestMethod;
}

export function authorizeCodexServerRequest(method: string): AllowedCodexServerRequestMethod {
  authorizeRequest("server", method, ALLOWED_SERVER_REQUESTS);
  return method as AllowedCodexServerRequestMethod;
}

export function authorizeCodexClientNotification(
  method: string,
): AllowedCodexClientNotificationMethod {
  authorizeRequest("client", method, ALLOWED_CLIENT_NOTIFICATIONS);
  return method as AllowedCodexClientNotificationMethod;
}

function authorizeRequest(
  direction: CodexRpcRequestDirection,
  method: string,
  allowedMethods: ReadonlySet<string>,
): void {
  if (allowedMethods.has(method)) return;

  if (
    FORBIDDEN_EXACT_METHODS.has(method) ||
    FORBIDDEN_METHOD_PREFIXES.some((prefix) => method === prefix || method.startsWith(prefix))
  ) {
    throw new AgentSubstrateRpcPolicyError("FORBIDDEN_RPC_METHOD", direction, method);
  }

  throw new AgentSubstrateRpcPolicyError("UNKNOWN_RPC_METHOD", direction, method);
}
