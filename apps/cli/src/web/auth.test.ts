import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./store";
import { WebAuth } from "./auth";

test("operator setup requires the terminal code; passwords are hashed and sessions expire and revoke", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eigengrid-web-auth-"));
  const path = join(dir, "chats.sqlite");
  let store = new ChatStore(path);
  let now = 1000;
  const request = new Request("http://127.0.0.1:4317/api/auth/login");
  const credentials = { username: "operator", password: "correct-horse-battery" };
  try {
    const auth = new WebAuth(store, false, () => now);
    expect(await auth.status(request)).toEqual({
      authenticated: false,
      setupRequired: true,
      username: undefined,
      role: undefined,
    });
    expect((await auth.login(request, { ...credentials, code: "forged" }, "setup")).status).toBe(
      403,
    );
    expect(store.user("operator")).toBeNull();
    const setup = await auth.login(request, { ...credentials, code: auth.setupCode }, "setup");
    expect(setup.status).toBe(200);
    expect(store.user("operator")!.passwordHash).toStartWith("$argon2id$");
    expect(JSON.stringify(store.user("operator"))).not.toContain(credentials.password);
    const cookie = setup.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    const signedIn = new Request(request, { headers: { Cookie: cookie.split(";")[0]! } });
    expect((await auth.status(signedIn)).username).toBe("operator");
    expect(
      (await auth.login(request, { ...credentials, code: auth.setupCode }, "setup")).status,
    ).toBe(403);
    expect(
      (await auth.login(request, { ...credentials, username: "someone" }, "login")).status,
    ).toBe(401);
    auth.logout(signedIn);
    expect(auth.authenticated(signedIn)).toBeNull();
    const login = await auth.login(request, credentials, "login");
    const signedAgain = new Request(request, {
      headers: { Cookie: login.headers.get("set-cookie")!.split(";")[0]! },
    });
    expect(auth.authenticated(signedAgain)?.username).toBe("operator");
    now += 12 * 60 * 60 * 1000;
    expect(auth.authenticated(signedAgain)).toBeNull();
    const chat = store.create(store.user("operator")!.id);
    store.close();
    store = new ChatStore(path);
    const restarted = new WebAuth(store);
    expect(await restarted.setupRequired()).toBe(false);
    expect(restarted.authenticated(signedAgain)).toBeNull();
    expect((await restarted.login(request, credentials, "login")).status).toBe(200);
    expect(store.get(chat.id, chat.owner)?.id).toBe(chat.id);
    for (let i = 0; i < 10; i++)
      await restarted.login(request, { ...credentials, password: "wrong" }, "login");
    expect((await restarted.login(request, credentials, "login")).status).toBe(429);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
