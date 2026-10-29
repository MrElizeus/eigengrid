import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { MissionHttpError } from "./routes/mission-routes";
import type { MissionLocalContext, MissionLocalAuthority } from "../mission-local-authority";

export interface HttpSql {
  query(
    text: string,
    args?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}
export const httpSecretDigest = (secret: string) =>
  createHash("sha256").update(secret).digest("hex");
const tokenPattern = /^[A-Za-z0-9_-]{43}$/u;
export const SessionCookieName = "__Host-eigengrid";
export type HttpAuthority = Pick<
  MissionLocalAuthority,
  "authenticateHttp" | "httpActor" | "assertCurrent"
>;
export interface HttpSession {
  readonly context: MissionLocalContext;
  assertCurrent(): Promise<void>;
  verifyCsrf(request: Request): Promise<boolean>;
  revoke(): Promise<void>;
}

/** Secrets are 256-bit opaque credentials, never passwords or request-supplied actors.
 * Session and CSRF secrets are stored only as SHA-256 digests. Every read rechecks
 * protected policy, expiry, revocation and the current canonical user account. */
export class PostgresHttpAuth {
  constructor(
    readonly sql: HttpSql,
    readonly authority: HttpAuthority,
    readonly now = () => Date.now(),
  ) {}

  async login(credential: string, remoteAddress: string) {
    const window = Math.floor(this.now() / 600_000);
    const rate = await this.sql.query(
      `INSERT INTO eigengrid_a5_http_login_limits(bucket,window_id,attempts) VALUES($1,$2,1)
       ON CONFLICT(bucket,window_id) DO UPDATE SET attempts=eigengrid_a5_http_login_limits.attempts+1 RETURNING attempts`,
      [httpSecretDigest(remoteAddress), window],
    );
    if (Number(rate.rows[0]?.attempts) > 10) throw new MissionHttpError("QUOTA_EXCEEDED");
    let context: MissionLocalContext;
    try {
      context = await this.authority.authenticateHttp(credential);
    } catch {
      throw new MissionHttpError("UNAUTHENTICATED");
    }
    if (!context.http) throw new MissionHttpError("UNAUTHENTICATED");
    await this.active(context);
    const token = randomBytes(32).toString("base64url");
    const csrf = randomBytes(32).toString("base64url");
    const expiresAt = new Date(this.now() + context.http.sessionSeconds * 1000).toISOString();
    await this.sql.query(
      `INSERT INTO eigengrid_a5_http_sessions(token_digest,csrf_digest,actor_id,config_digest,expires_at)
      VALUES($1,$2,$3,$4,$5)`,
      [
        httpSecretDigest(token),
        httpSecretDigest(csrf),
        context.authenticatedActor.id,
        context.configDigest,
        expiresAt,
      ],
    );
    await this.authority.assertCurrent(context);
    return { token, csrf, expiresAt, maxAge: context.http.sessionSeconds };
  }

  private async active(context: MissionLocalContext) {
    await this.authority.assertCurrent(context);
    const user = await this.sql.query("SELECT status FROM users WHERE id=$1", [
      context.authenticatedActor.id,
    ]);
    if (user.rows.length !== 1 || user.rows[0]!.status !== "active")
      throw new MissionHttpError("UNAUTHENTICATED");
  }

  async resolve(request: Request): Promise<HttpSession | null> {
    const values = (request.headers.get("cookie") ?? "")
      .split(";")
      .map((value) => value.trim())
      .filter((value) => value.startsWith(SessionCookieName + "="));
    if (values.length !== 1) return null;
    const token = values[0]!.slice(SessionCookieName.length + 1);
    if (!tokenPattern.test(token)) return null;
    const digest = httpSecretDigest(token);
    const load = async () => {
      const result = await this.sql.query(
        "SELECT actor_id,config_digest,csrf_digest,expires_at,revoked FROM eigengrid_a5_http_sessions WHERE token_digest=$1",
        [digest],
      );
      const row = result.rows[0];
      if (!row || row.revoked !== false || new Date(String(row.expires_at)).getTime() <= this.now())
        throw new MissionHttpError("UNAUTHENTICATED");
      let context: MissionLocalContext;
      try {
        context = await this.authority.httpActor(String(row.actor_id), String(row.config_digest));
      } catch {
        throw new MissionHttpError("UNAUTHENTICATED");
      }
      await this.active(context);
      return { row, context };
    };
    const initial = await load();
    return {
      context: initial.context,
      assertCurrent: async () => {
        await load();
      },
      verifyCsrf: async (req) => {
        const { row } = await load();
        const token = req.headers.get("x-csrf-token") ?? "";
        return (
          tokenPattern.test(token) &&
          timingSafeEqual(
            Buffer.from(httpSecretDigest(token), "hex"),
            Buffer.from(String(row.csrf_digest), "hex"),
          )
        );
      },
      revoke: async () => {
        await this.sql.query(
          "UPDATE eigengrid_a5_http_sessions SET revoked=TRUE WHERE token_digest=$1",
          [digest],
        );
      },
    };
  }
}
