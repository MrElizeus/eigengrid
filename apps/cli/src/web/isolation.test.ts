import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Pool } from "pg";
import { startWebServer } from "./server";

for (const provider of ["sqlite", "postgres"] as const) {
  test.skipIf(provider === "postgres" && !process.env.EIGENGRID_TEST_POSTGRES_URL)(
    `${provider}: private histories, invite-only accounts, administrator boundary and session revocation`,
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "eigengrid-web-isolation-"));
      mkdirSync(join(dir, ".eigengrid"), { mode: 0o700 });
      let pool: Pool | undefined;
      let database: string | undefined;
      let databaseUrl: string | undefined;
      if (provider === "postgres") {
        pool = new Pool({ connectionString: process.env.EIGENGRID_TEST_POSTGRES_URL });
        database = `web_test_${crypto.randomUUID().replaceAll("-", "")}`;
        await pool.query(`CREATE DATABASE "${database}"`);
        const url = new URL(process.env.EIGENGRID_TEST_POSTGRES_URL!);
        url.pathname = `/${database}`;
        databaseUrl = url.href;
      }
      let app: Awaited<ReturnType<typeof startWebServer>> | undefined;
      try {
        const origin = provider === "postgres" ? "https://eigengrid.example.test" : undefined;
        app = await startWebServer({
          port: 0,
          statePath: join(dir, "chats.sqlite"),
          connectionDirectory: dir,
          databaseUrl,
          origin,
          run: async (input) => ({
            ok: true,
            response: "Respuesta privada",
            messages: [
              { role: "user", content: input.prompt },
              { role: "assistant", content: "Respuesta privada" },
            ],
          }),
        });
        const target = app.server.url.origin;
        const publicOrigin = origin ?? target;
        const request = (
          path: string,
          method = "GET",
          data?: unknown,
          cookie = "",
          headers: Record<string, string> = {},
        ) =>
          fetch(`${target}/api${path}`, {
            method,
            headers: {
              Host: new URL(publicOrigin).host,
              Origin: publicOrigin,
              "Content-Type": "application/json",
              Cookie: cookie,
              ...headers,
            },
            ...(data === undefined ? {} : { body: JSON.stringify(data) }),
          });
        const cookie = (response: Response) => response.headers.get("set-cookie")!.split(";")[0]!;
        const setup = await request("/auth/setup", "POST", {
          username: "admin",
          password: "administrator-test-password",
          code: new URL(app.url).hash.slice(7),
        });
        expect(setup.status).toBe(200);
        if (origin) expect(setup.headers.get("set-cookie")).toContain("; Secure");
        const admin = cookie(setup);
        expect(
          (
            await request("/auth/setup", "POST", {
              username: "intruder",
              password: "another-test-password",
              code: new URL(app.url).hash.slice(7),
            })
          ).status,
        ).toBe(403);
        expect(
          (
            await request("/auth/register", "POST", {
              username: "intruder",
              password: "another-test-password",
              code: "forged",
            })
          ).status,
        ).toBe(409);
        const invitation = await (await request("/admin/invitations", "POST", {}, admin)).json();
        const code = new URL(invitation.url).hash.slice(8);
        const register = await request("/auth/register", "POST", {
          username: "researcher",
          password: "researcher-test-password",
          code,
        });
        expect(register.status).toBe(200);
        const researcher = cookie(register);
        expect(
          (
            await request("/auth/register", "POST", {
              username: "replay",
              password: "another-test-password",
              code,
            })
          ).status,
        ).toBe(409);
        expect((await request("/admin/invitations", "POST", {}, researcher)).status).toBe(403);
        const chat = await (await request("/chats", "POST", {}, admin)).json();
        await (
          await request(`/chats/${chat.id}/messages`, "POST", { prompt: "Private question" }, admin)
        ).text();
        expect((await (await request("/state", "GET", undefined, admin)).json()).chats.length).toBe(
          1,
        );
        expect(
          (await (await request("/state", "GET", undefined, researcher)).json()).chats,
        ).toEqual([]);
        for (const [method, suffix, data] of [
          ["GET", "", undefined],
          ["PATCH", "", { title: "stolen" }],
          ["DELETE", "", {}],
          ["POST", "/messages", { prompt: "steal" }],
          ["POST", "/fork", { messageIndex: 0 }],
          ["POST", "/cancel", {}],
          ["POST", "/steer", { prompt: "steal" }],
        ] as const) {
          expect(
            (await request(`/chats/${chat.id}${suffix}`, method, data, researcher)).status,
          ).toBe(404);
        }
        expect(
          (await request("/auth/logout", "POST", {}, admin, { Origin: "https://attacker.test" }))
            .status,
        ).toBe(403);
        expect(
          (await request("/auth/login", "POST", {}, "", { Host: "attacker.test" })).status,
        ).toBe(403);
        await request("/auth/logout", "POST", {}, researcher);
        expect((await request("/state", "GET", undefined, researcher)).status).toBe(401);
        expect((await request("/state", "GET", undefined, admin)).status).toBe(200);
      } finally {
        await app?.close();
        if (pool && database) {
          await pool.query(`DROP DATABASE "${database}"`);
          await pool.end();
        }
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
}

test("network access fails closed without PostgreSQL or an exact HTTPS origin", async () => {
  await expect(startWebServer({ origin: "http://example.test", port: 0 })).rejects.toThrow("HTTPS");
  await expect(startWebServer({ origin: "https://example.test/path", port: 0 })).rejects.toThrow(
    "HTTPS",
  );
  await expect(
    startWebServer({ origin: "https://example.test", databaseUrl: "", port: 0 }),
  ).rejects.toThrow("EIGENGRID_WEB_DATABASE_URL");
});
