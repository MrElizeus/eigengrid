import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { ChatGptAuth, ChatGptAuthError } from "./chatgpt-auth";
import { ChatGptStore } from "./chatgpt-store";

const issuer = "https://auth.openai.com";
const clientId = "oaiapp_fixture";
const expectedAccountModels = [
  { id: "account-model", name: "Account Model", reasoningProtocol: "openai" as const },
];
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: { keys: object[] };
beforeAll(async () => {
  keys = await generateKeyPair("RS256");
  jwks = { keys: [{ ...(await exportJWK(keys.publicKey)), kid: "fixture", alg: "RS256" }] };
});

describe("ChatGPT public-client authentication (offline)", () => {
  let directory: string;
  let store: ChatGptStore;
  let nonce: string;
  let authorization: URL;
  let grants: URLSearchParams[];
  let failure: string | undefined;
  let scope: string;
  let subject: string;
  let badNonce: boolean;
  let auth: ChatGptAuth;
  let browserMode: "valid" | "deny" | "wait";
  let wrongStateStatus: number;
  let onIdentityFetch: (() => void) | undefined;
  let catalogPaddingBytes: number;
  let tokenPaddingBytes: number;
  let oversizedCatalog: boolean;
  let catalogCancelled: boolean;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "eigengrid-chatgpt-auth-"));
    store = new ChatGptStore(join(directory, "auth"));
    grants = [];
    failure = undefined;
    badNonce = false;
    subject = "fixture-user";
    scope = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
    browserMode = "valid";
    onIdentityFetch = undefined;
    catalogPaddingBytes = 0;
    tokenPaddingBytes = 0;
    oversizedCatalog = false;
    catalogCancelled = false;
    auth = new ChatGptAuth({
      store,
      openBrowser: async (link) => {
        authorization = new URL(link);
        nonce = authorization.searchParams.get("nonce")!;
        if (browserMode === "wait") return;
        const callback = new URL(authorization.searchParams.get("redirect_uri")!);
        callback.search = new URLSearchParams({
          state: "wrong",
          code: "fixture-code",
          client_id: clientId,
        }).toString();
        wrongStateStatus = (await fetch(callback)).status;
        callback.searchParams.set("state", authorization.searchParams.get("state")!);
        if (browserMode === "deny") callback.searchParams.set("error", "access_denied");
        await fetch(callback);
      },
      fetch: (async (input, init) => {
        const url = String(input);
        if (url.endsWith("/.well-known/openid-configuration"))
          return Response.json({
            issuer,
            authorization_endpoint: `${issuer}/api/accounts/authorize`,
            token_endpoint: `${issuer}/api/accounts/oauth/token`,
            jwks_uri: `${issuer}/jwks`,
            revocation_endpoint: `${issuer}/revoke`,
          });
        if (url.endsWith("/jwks")) {
          onIdentityFetch?.();
          return Response.json(jwks);
        }
        if (url.endsWith("/revoke")) return new Response(null, { status: 200 });
        if (url.endsWith("/models") && oversizedCatalog) {
          const chunk = new Uint8Array(64 * 1024).fill(32);
          return new Response(
            new ReadableStream({
              pull(controller) {
                controller.enqueue(chunk);
              },
              cancel() {
                catalogCancelled = true;
              },
            }),
          );
        }
        if (url.endsWith("/models"))
          return Response.json({
            metadata: "x".repeat(catalogPaddingBytes),
            models: [
              { slug: "account-model", display_name: "Account Model", visibility: "list" },
              { slug: "hidden", display_name: "Hidden", visibility: "hidden" },
            ],
          });
        expect(url).toBe(`${issuer}/api/accounts/oauth/token`);
        const grant = new URLSearchParams(String(init?.body));
        grants.push(grant);
        if (failure)
          return Response.json(
            { error: failure },
            { status: failure === "temporarily_unavailable" ? 503 : 400 },
          );
        const idToken = await new SignJWT({
          nonce: badNonce ? "wrong" : nonce,
          email: "fixture@example.test",
        })
          .setProtectedHeader({ alg: "RS256", kid: "fixture" })
          .setIssuer(issuer)
          .setAudience(clientId)
          .setSubject(subject)
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(keys.privateKey);
        return Response.json({
          metadata: "x".repeat(tokenPaddingBytes),
          token_type: "Bearer",
          access_token: "fixture-access",
          refresh_token: `fixture-refresh-${grants.length}`,
          id_token: idToken,
          expires_in: 3600,
          scope,
        });
      }) as typeof fetch,
    });
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  test("registers with PKCE, validates state and signed identity, keeps credentials private and lists account models", async () => {
    const account = await auth.signIn();
    expect(wrongStateStatus).toBe(400);
    expect(authorization.origin + authorization.pathname).toBe(`${issuer}/api/accounts/authorize`);
    expect(authorization.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(authorization.searchParams.get("agent_name_hint")).toBe("EigenGrid");
    expect(authorization.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(grants[0].get("code_verifier")!).digest("base64url"),
    );
    expect(grants[0].get("redirect_uri")).toBe(authorization.searchParams.get("redirect_uri"));
    expect(grants[0].get("client_id")).toBe(clientId);
    expect(account.sharing).toBe(true);
    expect(await auth.models(account.id)).toEqual(expectedAccountModels);
    expect(statSync(store.path).mode & 0o777).toBe(0o600);
    expect(statSync(store.directory).mode & 0o777).toBe(0o700);
    expect(JSON.stringify(auth.accounts())).not.toContain("fixture-access");
    const host = authorization.searchParams.get("ext_agent_host_id");
    await auth.signIn({ profileId: account.id });
    expect(authorization.searchParams.get("ext_agent_host_id")).toBe(host);
    expect(authorization.searchParams.get("client_id")).toBe(clientId);
    expect(authorization.searchParams.has("agent_name_hint")).toBe(false);
    expect(auth.accounts()).toHaveLength(1);
  });

  test("retains issued registration after an expired code, without storing the dynamic entrypoint", async () => {
    failure = "invalid_grant";
    await expect(auth.signIn()).rejects.toThrow("expired");
    expect(store.profiles()[0].clientId).toBe(clientId);
    expect(store.profiles()[0].accessToken).toBeUndefined();
    expect(readFileSync(store.path, "utf8")).not.toContain("dynamic_agent_client");
  });
  test("loads model catalogs larger than the authentication response limit", async () => {
    const account = await auth.signIn();
    catalogPaddingBytes = 600 * 1024;
    expect(await auth.models(account.id)).toEqual(expectedAccountModels);
    expect(store.profile(account.id).accessToken).toBe("fixture-access");
    expect(auth.accounts()[0].sharing).toBe(true);
  });
  test("still bounds model responses and cancels an oversized stream without losing the saved session", async () => {
    const account = await auth.signIn();
    oversizedCatalog = true;
    await expect(auth.models(account.id)).rejects.toThrow("model catalog response exceeded");
    expect(catalogCancelled).toBe(true);
    expect(store.profile(account.id).accessToken).toBe("fixture-access");
  });
  test("keeps the smaller token response limit independent of model catalog size", async () => {
    tokenPaddingBytes = 600 * 1024;
    await expect(auth.signIn()).rejects.toThrow("authentication response exceeded");
    expect(store.profiles()[0].accessToken).toBeUndefined();
  });
  test("rejects an invalid nonce without accepting credentials", async () => {
    badNonce = true;
    await expect(auth.signIn()).rejects.toThrow("verified");
    expect(auth.accounts()[0].connected).toBe(false);
    expect(store.profiles()[0].accessToken).toBeUndefined();
  });
  test("preserves a prior account when reauthorization returns a different identity", async () => {
    const account = await auth.signIn();
    subject = "different-user";
    await expect(auth.signIn({ profileId: account.id })).rejects.toThrow("different account");
    expect(store.profile(account.id).subject).toBe("fixture-user");
  });
  test("identity sign-in without plan permission cannot make inference requests", async () => {
    scope = "openid profile email offline_access";
    const account = await auth.signIn();
    expect(account.sharing).toBe(false);
    await expect(auth.models(account.id)).rejects.toThrow("not enabled");
  });
  test("denied consent and cancellation close the loopback listener without accepting tokens", async () => {
    browserMode = "deny";
    await expect(auth.signIn()).rejects.toBeInstanceOf(ChatGptAuthError);
    expect(store.profiles()).toHaveLength(0);
    browserMode = "wait";
    const controller = new AbortController();
    const result = auth.signIn({
      signal: controller.signal,
      onLink: () => queueMicrotask(() => controller.abort()),
    });
    await expect(result).rejects.toThrow();
    expect(store.profiles()).toHaveLength(0);
  });
  test("serializes rotating refresh tokens and reloads the latest credentials", async () => {
    const account = await auth.signIn();
    store.save({ ...store.profile(account.id), expiresAt: 0 });
    const tokens = await Promise.all([auth.accessToken(account.id), auth.accessToken(account.id)]);
    expect(tokens).toEqual(["fixture-access", "fixture-access"]);
    expect(grants.filter((grant) => grant.get("grant_type") === "refresh_token")).toHaveLength(1);
    expect(store.profile(account.id).refreshToken).toBe("fixture-refresh-2");
  });
  test("cancelling during identity validation cannot save a new authenticated session", async () => {
    const controller = new AbortController();
    onIdentityFetch = () => controller.abort();
    await expect(auth.signIn({ signal: controller.signal })).rejects.toThrow();
    expect(store.profiles()[0].accessToken).toBeUndefined();
  });
  test("temporary refresh failures preserve credentials; terminal failures clear only tokens", async () => {
    const account = await auth.signIn();
    store.save({ ...store.profile(account.id), expiresAt: 0 });
    failure = "temporarily_unavailable";
    await expect(auth.accessToken(account.id)).rejects.toThrow();
    expect(store.profile(account.id).refreshToken).toBeDefined();
    failure = "invalid_grant";
    await expect(auth.accessToken(account.id)).rejects.toThrow();
    expect(store.profile(account.id).refreshToken).toBeUndefined();
    expect(store.profile(account.id).clientId).toBe(clientId);
  });
  test("revokes on sign-out while retaining account registration and host identity", async () => {
    const account = await auth.signIn();
    const host = store.hostId();
    expect(await auth.signOut(account.id)).toEqual({ revoked: true });
    expect(store.profile(account.id).accessToken).toBeUndefined();
    expect(store.profile(account.id).clientId).toBe(clientId);
    expect(store.hostId()).toBe(host);
  });
  test("refuses credential files readable by other users", async () => {
    await auth.signIn();
    chmodSync(store.path, 0o644);
    expect(() => auth.accounts()).toThrow("unsafe");
  });
});
