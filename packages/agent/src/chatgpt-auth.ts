import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { ChatGptStore, type ChatGptProfile } from "./chatgpt-store";
import {
  parseReasoningLevels,
  isReasoningEffort,
  type ReasoningLevel,
  type ReasoningEffort,
} from "@eigengrid/model-gateway";

export const CHATGPT_RESOURCE = "https://api.openai.com/v1";
export const CHATGPT_USAGE_URL = "https://chatgpt.com/#settings/Usage";
const ISSUER = "https://auth.openai.com";
const AUTHORIZE = `${ISSUER}/api/accounts/authorize`;
const TOKEN = `${ISSUER}/api/accounts/oauth/token`;
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
const MAX_AUTH_RESPONSE_BYTES = 512 * 1024;
const MAX_MODEL_CATALOG_BYTES = 8 * 1024 * 1024;

export interface ChatGptAccount {
  id: string;
  label: string;
  connected: boolean;
  sharing: boolean;
}
export interface ChatGptModel {
  id: string;
  name: string;
  reasoningLevels?: ReasoningLevel[];
  recommendedEffort?: ReasoningEffort;
  reasoningProtocol?: "openai" | "openai-compatible" | "anthropic";
}

const recovery: Record<string, string> = {
  access_denied: "ChatGPT sign-in was cancelled. Choose a sign-in method to try again.",
  subscription_sharing_user_not_eligible:
    "ChatGPT plan usage is unavailable for this account or workspace. Choose another account or API key.",
  subscription_sharing_usage_limit_exceeded: `ChatGPT plan usage limit reached. Manage usage: ${CHATGPT_USAGE_URL}`,
  subscription_sharing_usage_unavailable:
    "ChatGPT usage could not be checked. Retry later; your credentials are retained.",
  subscription_sharing_unsupported_capability:
    "This model or request capability is unavailable with your ChatGPT plan. Choose another model.",
  subscription_sharing_route_not_supported:
    "ChatGPT plan usage does not support this request route.",
  invalid_grant: "ChatGPT authorization expired. Continue with ChatGPT again.",
};

export class ChatGptAuthError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
    readonly requestId?: string,
  ) {
    super(
      recovery[code] ??
        `ChatGPT request failed${status ? ` (HTTP ${status})` : ""}. Reconnect through /connect if authorization is required.`,
    );
    this.name = "ChatGptAuthError";
  }
}

export function openSystemBrowser(url: string): Promise<void> {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", shell: false });
    child.once("error", () =>
      reject(new Error("Open the displayed sign-in link in your browser.")),
    );
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

/** Official public-client sign-in flow. Never reads or borrows another app's credentials. */
export class ChatGptAuth {
  readonly store: ChatGptStore;
  private readonly fetcher: typeof fetch;
  private readonly openBrowser: (url: string) => Promise<void>;
  constructor(
    options: {
      store?: ChatGptStore;
      fetch?: typeof fetch;
      openBrowser?: (url: string) => Promise<void>;
    } = {},
  ) {
    this.store = options.store ?? new ChatGptStore();
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.openBrowser = options.openBrowser ?? openSystemBrowser;
  }

  accounts(): ChatGptAccount[] {
    return this.store.profiles().map((p) => ({
      id: p.id,
      label: `${p.subject ? (p.email ?? p.name ?? "ChatGPT account") : "Finish ChatGPT sign-in"} · ${p.id.slice(0, 8)}`,
      connected: !!(p.accessToken && p.refreshToken),
      sharing: !!p.accessToken && p.scopes.includes(PLAN_SCOPE),
    }));
  }

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    return this.fetcher(url, {
      ...init,
      redirect: "error",
      signal: init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
    });
  }
  private async json(
    response: Response,
    purpose: "authentication" | "model catalog" = "authentication",
  ): Promise<Record<string, unknown>> {
    const maximumBytes =
      purpose === "model catalog" ? MAX_MODEL_CATALOG_BYTES : MAX_AUTH_RESPONSE_BYTES;
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (reader)
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > maximumBytes) {
          await reader.cancel();
          throw new Error(
            `ChatGPT ${purpose} response exceeded the permitted size (${maximumBytes} bytes)`,
          );
        }
        chunks.push(next.value);
      }
    const body = Buffer.concat(chunks).toString("utf8");
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(body);
    } catch {
      throw new ChatGptAuthError("invalid_response", response.status);
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new ChatGptAuthError("invalid_response", response.status);
    if (!response.ok) {
      const error = value.error;
      const code =
        typeof error === "string"
          ? error
          : error &&
              typeof error === "object" &&
              typeof (error as { code?: unknown }).code === "string"
            ? (error as { code: string }).code
            : "request_failed";
      throw new ChatGptAuthError(
        code,
        response.status,
        response.headers.get("x-request-id") ?? undefined,
      );
    }
    return value;
  }
  private async discovery(): Promise<{ jwks: string; revoke: string }> {
    const metadata = await this.json(
      await this.request(`${ISSUER}/.well-known/openid-configuration`),
    );
    if (
      metadata.issuer !== ISSUER ||
      metadata.authorization_endpoint !== AUTHORIZE ||
      metadata.token_endpoint !== TOKEN ||
      typeof metadata.jwks_uri !== "string" ||
      typeof metadata.revocation_endpoint !== "string"
    )
      throw new Error("Unexpected OpenAI authorization metadata");
    for (const endpoint of [metadata.jwks_uri, metadata.revocation_endpoint]) {
      const url = new URL(endpoint);
      if (url.origin !== ISSUER || url.username || url.password || url.hash)
        throw new Error("Unexpected OpenAI authorization endpoint");
    }
    return { jwks: metadata.jwks_uri, revoke: metadata.revocation_endpoint };
  }
  private async identity(token: string, clientId: string, nonce?: string) {
    const metadata = await this.discovery();
    const keys = await this.json(await this.request(metadata.jwks));
    const verified = await jwtVerify(token, createLocalJWKSet(keys as unknown as JSONWebKeySet), {
      issuer: ISSUER,
      audience: clientId,
      algorithms: ["RS256", "ES256"],
      requiredClaims: ["sub", "exp", "iat", ...(nonce ? ["nonce"] : [])],
      clockTolerance: 5,
    });
    if (!verified.payload.sub || (nonce && verified.payload.nonce !== nonce))
      throw new Error("ChatGPT sign-in identity could not be verified");
    return verified.payload;
  }
  private credentials(data: Record<string, unknown>, previous?: ChatGptProfile) {
    if (
      data.token_type !== "Bearer" ||
      typeof data.access_token !== "string" ||
      !data.access_token ||
      typeof data.refresh_token !== "string" ||
      !data.refresh_token ||
      typeof data.expires_in !== "number" ||
      !Number.isFinite(data.expires_in) ||
      data.expires_in <= 0 ||
      data.expires_in > 86_400 ||
      (data.scope !== undefined && typeof data.scope !== "string")
    )
      throw new Error("Invalid ChatGPT token response");
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
      scopes:
        typeof data.scope === "string"
          ? data.scope.split(/\s+/).filter(Boolean)
          : (previous?.scopes ?? []),
      idToken: typeof data.id_token === "string" ? data.id_token : previous?.idToken,
    };
  }

  async signIn(
    options: {
      profileId?: string;
      signal?: AbortSignal;
      onLink?: (url: string) => void;
      onBrowserUnavailable?: () => void;
    } = {},
  ): Promise<ChatGptAccount> {
    return this.store.exclusive(async () => {
      options.signal?.throwIfAborted();
      const previous = options.profileId ? this.store.profile(options.profileId) : undefined;
      const profileId = previous?.id ?? randomUUID();
      const state = randomBytes(32).toString("base64url");
      const nonce = randomBytes(32).toString("base64url");
      const verifier = randomBytes(48).toString("base64url");
      let accept: (value: URLSearchParams) => void = () => undefined;
      let reject: (reason: unknown) => void = () => undefined;
      const callback = new Promise<URLSearchParams>((resolve, fail) => {
        accept = resolve;
        reject = fail;
      });
      let claimed = false;
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          const url = new URL(request.url);
          if (
            request.method !== "GET" ||
            url.pathname !== "/auth/callback" ||
            url.searchParams.getAll("state").length !== 1 ||
            url.searchParams.get("state") !== state ||
            claimed
          )
            return new Response("Invalid or expired sign-in attempt.", { status: 400 });
          claimed = true;
          accept(url.searchParams);
          return new Response("Return to EigenGrid to finish connecting your ChatGPT account.", {
            headers: {
              "Content-Type": "text/plain; charset=utf-8",
              "Cache-Control": "no-store",
              "Referrer-Policy": "no-referrer",
            },
          });
        },
      });
      const redirect = `http://127.0.0.1:${server.port}/auth/callback`;
      const url = new URL(AUTHORIZE);
      url.search = new URLSearchParams({
        client_id: previous?.clientId ?? "dynamic_agent_client",
        ...(previous ? {} : { agent_name_hint: "EigenGrid" }),
        ...(previous?.accessToken && !previous.scopes.includes(PLAN_SCOPE)
          ? { prompt: "consent" }
          : {}),
        ext_agent_host_id: this.store.hostId(),
        response_type: "code",
        redirect_uri: redirect,
        scope: SCOPES,
        resource: CHATGPT_RESOURCE,
        state,
        nonce,
        code_challenge_method: "S256",
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      }).toString();
      const abort = () => reject(new DOMException("ChatGPT sign-in cancelled", "AbortError"));
      const timeout = setTimeout(
        () => reject(new Error("ChatGPT sign-in timed out. Try /connect again.")),
        5 * 60_000,
      );
      options.signal?.addEventListener("abort", abort, { once: true });
      try {
        options.onLink?.(url.toString());
        await this.openBrowser(url.toString()).catch(() => options.onBrowserUnavailable?.());
        const returned = await callback;
        if (returned.get("error")) throw new ChatGptAuthError(returned.get("error")!);
        const clientId = returned.get("client_id") ?? previous?.clientId;
        const code = returned.get("code");
        if (
          !code ||
          returned.getAll("code").length !== 1 ||
          !clientId ||
          !/^[A-Za-z0-9_-]{1,256}$/.test(clientId) ||
          clientId === "dynamic_agent_client" ||
          returned.getAll("client_id").length > 1 ||
          (previous && clientId !== previous.clientId)
        )
          throw new Error(
            "ChatGPT registration callback is incomplete or belongs to a different account",
          );
        // Retain issued registration even when a short-lived authorization code fails.
        const registration = previous ?? { id: profileId, clientId, scopes: [] };
        this.store.save(registration);
        const data = await this.json(
          await this.request(TOKEN, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            signal: options.signal,
            body: new URLSearchParams({
              grant_type: "authorization_code",
              client_id: clientId,
              code,
              code_verifier: verifier,
              redirect_uri: redirect,
              resource: CHATGPT_RESOURCE,
            }),
          }),
        );
        if (typeof data.id_token !== "string")
          throw new Error("ChatGPT did not return a verifiable identity");
        const identity = await this.identity(data.id_token, clientId, nonce);
        options.signal?.throwIfAborted();
        if (previous?.subject && identity.sub !== previous.subject)
          throw new Error("ChatGPT returned a different account. Add it as a new account instead.");
        const credentials = this.credentials(data);
        this.store.save({
          ...registration,
          ...credentials,
          subject: identity.sub,
          email: typeof identity.email === "string" ? identity.email : undefined,
          name: typeof identity.name === "string" ? identity.name : undefined,
        });
        return this.accounts().find((account) => account.id === profileId)!;
      } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abort);
        await server.stop(true);
      }
    });
  }

  async accessToken(profileId: string): Promise<string> {
    return this.store.exclusive(async () => {
      const profile = this.store.profile(profileId);
      if (!profile.scopes.includes(PLAN_SCOPE) || !profile.accessToken || !profile.refreshToken)
        throw new Error(
          "ChatGPT plan usage is not enabled. Continue with ChatGPT and grant plan access, or choose API key.",
        );
      if ((profile.expiresAt ?? 0) > Date.now() + 60_000) return profile.accessToken;
      try {
        const data = await this.json(
          await this.request(TOKEN, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "refresh_token",
              client_id: profile.clientId,
              refresh_token: profile.refreshToken,
              resource: CHATGPT_RESOURCE,
            }),
          }),
        );
        if (typeof data.id_token === "string") {
          const identity = await this.identity(data.id_token, profile.clientId);
          if (identity.sub !== profile.subject)
            throw new Error("Refreshed ChatGPT identity does not match the selected account");
        }
        const credentials = this.credentials(data, profile);
        this.store.save({ ...profile, ...credentials });
        if (!credentials.scopes.includes(PLAN_SCOPE))
          throw new Error(
            "ChatGPT plan permission is no longer enabled. Sign in again through /connect.",
          );
        return credentials.accessToken;
      } catch (error) {
        if (
          error instanceof ChatGptAuthError &&
          [
            "invalid_grant",
            "invalid_refresh_token",
            "token_expired",
            "refresh_token_expired",
            "refresh_token_invalidated",
            "refresh_token_reused",
          ].includes(error.code)
        )
          this.store.clearTokens(profileId);
        throw error;
      }
    });
  }

  async models(profileId: string): Promise<ChatGptModel[]> {
    const token = await this.accessToken(profileId);
    const data = await this.json(
      await this.request(`${CHATGPT_RESOURCE}/models`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      "model catalog",
    );
    if (!Array.isArray(data.models))
      throw new Error("ChatGPT did not return an account model catalog");
    return data.models.flatMap((model: unknown) => {
      if (!model || typeof model !== "object") return [];
      const m = model as Record<string, unknown>;
      return m.visibility === "list" &&
        typeof m.slug === "string" &&
        m.slug &&
        typeof m.display_name === "string"
        ? [
            {
              id: m.slug,
              name: m.display_name,
              reasoningLevels: parseReasoningLevels(m.supported_reasoning_levels),
              recommendedEffort: isReasoningEffort(m.default_reasoning_level)
                ? m.default_reasoning_level
                : undefined,
              reasoningProtocol: "openai" as const,
            },
          ]
        : [];
    });
  }

  async signOut(profileId: string): Promise<{ revoked: boolean }> {
    return this.store.exclusive(async () => {
      const profile = this.store.profile(profileId);
      let revoked = !profile.refreshToken;
      try {
        if (profile.refreshToken) {
          const metadata = await this.discovery();
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const response = await this.request(metadata.revoke, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                  token: profile.refreshToken,
                  token_type_hint: "refresh_token",
                  client_id: profile.clientId,
                }),
              });
              if (response.status === 200) {
                revoked = true;
                break;
              }
              if (response.status < 500) break;
            } catch {
              /* bounded revocation retry; local sign-out still clears secrets */
            }
            await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
          }
        }
      } catch {
        revoked = false;
      } finally {
        this.store.clearTokens(profileId);
      }
      return { revoked };
    });
  }
}
