import { AgentSubstratePreflightReceipt } from "./compatibility";
import {
  authorizeCodexClientNotification,
  authorizeCodexClientRequest,
  authorizeCodexServerRequest,
  type AllowedCodexClientNotificationMethod,
  type AllowedCodexClientRequestMethod,
  type AllowedCodexServerRequestMethod,
} from "./rpc-policy";

export interface CodexAppServerTransport {
  request(method: AllowedCodexClientRequestMethod, params: unknown): Promise<unknown>;
  notify(method: AllowedCodexClientNotificationMethod, params: unknown): void;
}

export type CodexServerRequestDispatcher = (
  method: AllowedCodexServerRequestMethod,
  params: unknown,
) => Promise<unknown>;

/**
 * A narrow, transport-injected boundary. This package neither starts Codex nor
 * installs this adapter in an application runtime; supervision is a later gate.
 */
export class AgentSubstrateAdapter {
  constructor(
    readonly preflight: AgentSubstratePreflightReceipt,
    private readonly transport: CodexAppServerTransport,
  ) {
    if (!(preflight instanceof AgentSubstratePreflightReceipt)) {
      throw new TypeError("A verified agent substrate preflight receipt is required");
    }
  }

  async request(method: string, params: unknown): Promise<unknown> {
    const allowedMethod = authorizeCodexClientRequest(method);
    return this.transport.request(allowedMethod, params);
  }

  notify(method: string, params: unknown): void {
    const allowedMethod = authorizeCodexClientNotification(method);
    this.transport.notify(allowedMethod, params);
  }

  async dispatchServerRequest(
    method: string,
    params: unknown,
    dispatch: CodexServerRequestDispatcher,
  ): Promise<unknown> {
    const allowedMethod = authorizeCodexServerRequest(method);
    return dispatch(allowedMethod, params);
  }
}
