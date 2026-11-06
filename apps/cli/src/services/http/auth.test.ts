import { expect, test } from "bun:test";
import type { MissionLocalContext } from "../mission-local-authority";
import { PostgresHttpAuth, type HttpSql } from "./auth";

function fixture() {
  const buckets = new Map<string, number>();
  let now = 0;
  const sql: HttpSql = {
    async query(statement, args = []) {
      if (statement.includes("http_login_limits")) {
        const key = `${args[0]}:${args[1]}`;
        const attempts = (buckets.get(key) ?? 0) + 1;
        buckets.set(key, attempts);
        return { rows: [{ attempts }], rowCount: 1 };
      }
      if (statement.startsWith("SELECT status"))
        return { rows: [{ status: "active" }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
  };
  const auth = new PostgresHttpAuth(
    sql,
    {
      async authenticateHttp(credential) {
        if (!["alice", "bob"].includes(credential)) throw new Error("Invalid credential");
        return {
          http: { sessionSeconds: 60 },
          authenticatedActor: { id: credential },
          configDigest: "a".repeat(64),
        } as unknown as MissionLocalContext;
      },
      httpActor() {
        throw new Error("unused");
      },
      async assertCurrent() {},
    },
    () => now,
  );
  return { auth, buckets, advance: () => (now += 600_000) };
}

test("users behind the same proxy have independent credential quotas", async () => {
  const { auth, buckets, advance } = fixture();
  for (let i = 0; i < 10; i++) await auth.login("alice", "127.0.0.1");
  await expect(auth.login("alice", "127.0.0.2")).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  expect((await auth.login("bob", "127.0.0.1")).token).toHaveLength(43);
  expect(buckets.size).toBe(2);
  advance();
  expect((await auth.login("alice", "127.0.0.1")).token).toHaveLength(43);
});

test("invalid secrets cannot consume another user's quota or create buckets", async () => {
  const { auth, buckets } = fixture();
  for (let i = 0; i < 20; i++) {
    await expect(auth.login(`invalid-${i}`, "127.0.0.1")).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
  }
  expect(buckets.size).toBe(0);
  expect((await auth.login("alice", "127.0.0.1")).token).toHaveLength(43);
});
