import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { WebStore, WebUser } from "./store";

const lifetime = 12 * 60 * 60 * 1000;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const equal = (left: string, right: string) =>
  timingSafeEqual(Buffer.from(digest(left)), Buffer.from(digest(right)));
type Identity = Pick<WebUser, "id" | "username" | "role">;
let dummyHash: Promise<string> | undefined;

/** Browser identity is independent of CLI model credentials and scientific authority. */
export class WebAuth {
  readonly setupCode = randomBytes(32).toString("base64url");
  private sessions = new Map<string, { user: Identity; expires: number }>();
  private attempts = new Map<string, number[]>();
  private verifying = 0;
  constructor(
    private store: WebStore,
    private secure = false,
    private now = Date.now,
  ) {}
  async setupRequired() {
    return !(await this.store.hasUsers());
  }
  private cookieName(request: Request) {
    return this.secure
      ? "__Host-eigengrid-session"
      : `eigengrid_session_${new URL(request.url).port}`;
  }
  private token(request: Request) {
    const prefix = `${this.cookieName(request)}=`;
    return (
      request.headers
        .get("cookie")
        ?.split(";")
        .map((s) => s.trim())
        .find((s) => s.startsWith(prefix))
        ?.slice(prefix.length) ?? ""
    );
  }
  authenticated(request: Request): Identity | null {
    const token = this.token(request),
      key = digest(token),
      session = this.sessions.get(key);
    if (!token || !session || session.expires <= this.now()) {
      this.sessions.delete(key);
      return null;
    }
    return session.user;
  }
  async status(request: Request) {
    const user = this.authenticated(request);
    return {
      authenticated: !!user,
      setupRequired: await this.setupRequired(),
      username: user?.username,
      role: user?.role,
    };
  }
  async invitation() {
    const token = randomBytes(32).toString("base64url"),
      expires = this.now() + 24 * 60 * 60 * 1000;
    await this.store.invite(digest(token), expires);
    return { token, expires };
  }
  async login(request: Request, input: unknown, mode: "setup" | "login" | "register") {
    const value = input as Record<string, unknown> | null;
    const username =
      typeof value?.username === "string" ? value.username.trim().toLocaleLowerCase("en-US") : "";
    const password = typeof value?.password === "string" ? value.password : "";
    if (
      !/^[a-z0-9_.@-]{1,64}$/.test(username) ||
      password.length < (mode === "login" ? 1 : 12) ||
      password.length > 256
    )
      return Response.json(
        {
          error:
            mode === "login"
              ? "Incorrect username or password."
              : "Use a username with letters, numbers, dots or hyphens and a password of 12 to 256 characters.",
        },
        { status: 400 },
      );
    for (const [key, values] of this.attempts) {
      const remaining = values.filter((time) => time > this.now() - 15 * 60 * 1000);
      if (remaining.length) this.attempts.set(key, remaining);
      else this.attempts.delete(key);
    }
    const attempts = this.attempts.get(username) ?? [];
    if (attempts.length >= 10 || this.verifying >= 4 || this.attempts.size >= 2000)
      return Response.json(
        { error: "Too many attempts. Try again later." },
        { status: 429, headers: { "Retry-After": "900" } },
      );
    this.attempts.set(username, [...attempts, this.now()]);
    this.verifying++;
    try {
      let user: WebUser;
      if (mode !== "login") {
        if (
          typeof value?.code !== "string" ||
          (mode === "setup" &&
            (!(await this.setupRequired()) || !equal(value.code, this.setupCode)))
        )
          return Response.json(
            { error: "The access link is invalid or has already been used." },
            { status: 403 },
          );
        const hash = await Bun.password.hash(password, {
          algorithm: "argon2id",
          memoryCost: 65536,
          timeCost: 3,
        });
        try {
          user = await this.store.createUser(
            username,
            hash,
            mode === "register" ? digest(value.code as string) : undefined,
          );
        } catch {
          return Response.json(
            {
              error:
                "Unable to create the account. Check the invitation or choose another username.",
            },
            { status: 409 },
          );
        }
      } else {
        const found = await this.store.user(username);
        dummyHash ??= Bun.password.hash(randomBytes(32).toString("hex"), {
          algorithm: "argon2id",
          memoryCost: 65536,
          timeCost: 3,
        });
        const valid = await Bun.password.verify(password, found?.passwordHash ?? (await dummyHash));
        if (!valid || !found)
          return Response.json({ error: "Incorrect username or password." }, { status: 401 });
        user = found;
      }
      this.attempts.delete(username);
      for (const [key, session] of this.sessions)
        if (session.expires <= this.now()) this.sessions.delete(key);
      const owned = [...this.sessions].filter(([, session]) => session.user.id === user.id);
      if (owned.length >= 10) this.sessions.delete(owned[0]![0]);
      const token = randomBytes(32).toString("base64url");
      this.sessions.set(digest(token), {
        user: { id: user.id, username: user.username, role: user.role },
        expires: this.now() + lifetime,
      });
      return Response.json(
        { authenticated: true, username: user.username, role: user.role },
        {
          headers: {
            "Set-Cookie": this.cookie(request, token, lifetime / 1000),
            "Cache-Control": "no-store",
          },
        },
      );
    } finally {
      this.verifying--;
    }
  }
  private cookie(request: Request, token: string, age: number) {
    return `${this.cookieName(request)}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${this.secure ? "; Secure" : ""}`;
  }
  logout(request: Request) {
    this.sessions.delete(digest(this.token(request)));
    return Response.json(
      { authenticated: false },
      { headers: { "Set-Cookie": this.cookie(request, "", 0), "Cache-Control": "no-store" } },
    );
  }
}
