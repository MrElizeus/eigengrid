import { test, expect } from "bun:test";
import { createServer } from "node:https";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { MissionHttpClient, configuredMissionHttpClient } from "./mission-http-client";
import { writePrivateClientJson } from "./mission-http-private-files";

const sid = "41f4b0b5-046a-4401-bcb2-8899fc77c1c2";
const snapshot = {
  sessionId: sid,
  prompt: "inspect",
  phase: "OPEN",
  cursor: { sequence: 0, digest: "a".repeat(64) },
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "eg-http-tls-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(root, "key"),
      "-out",
      join(root, "cert"),
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  let drops = false,
    wrongActor = false,
    missing = false,
    mismatched = false,
    posts = 0;
  const server = createServer(
    { key: await readFile(join(root, "key")), cert: await readFile(join(root, "cert")) },
    async (req, res) => {
      for await (const _ of req) {
        /* drain */
      }
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/api/v1/auth/login") {
        res.setHeader("Set-Cookie", "__Host-eigengrid=privatecookie; Secure; HttpOnly; Path=/");
        res.end(
          JSON.stringify({
            csrfToken: "privatecsrf",
            expiresAt: new Date(Date.now() + 60000).toISOString(),
          }),
        );
      } else if (req.url === "/api/v1/auth/session")
        res.end(JSON.stringify({ actor: { id: wrongActor ? "intruder" : "eliseo" } }));
      else if (req.url?.includes("/requests/")) {
        if (missing) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
        } else
          res.end(
            JSON.stringify({
              result: {
                status: "complete",
                result: mismatched ? { ...snapshot, prompt: "different" } : snapshot,
              },
            }),
          );
      } else if (req.method === "POST") {
        posts++;
        if (drops) req.socket.destroy();
        else res.end(JSON.stringify({ result: snapshot }));
      } else res.end(JSON.stringify({ result: snapshot }));
    },
  );
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  const config = {
    schemaVersion: "eigengrid.mission-http-client/v1",
    origin: `https://localhost:${port}`,
    caCertificate: await readFile(join(root, "cert"), "utf8"),
    credential: "a".repeat(43),
    actorId: "eliseo",
    projectId: "project",
    missionId: "mission",
  };
  return {
    root,
    config,
    client: new MissionHttpClient(config, join(root, "state.json")),
    drop: () => {
      drops = true;
    },
    wrongActor: () => {
      wrongActor = true;
    },
    missing: () => {
      missing = true;
    },
    mismatch: () => {
      mismatched = true;
    },
    posts: () => posts,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await rm(root, { recursive: true, force: true });
    },
  };
}
const input = { projectId: "project", missionId: "mission", prompt: "inspect" };
test("verified TLS binds session IDs and rejects cross-mission use", async () => {
  const f = await fixture();
  try {
    expect(((await f.client.run("open", input)) as typeof snapshot).sessionId).toBe(sid);
    expect(((await f.client.run("observe", { sessionId: sid })) as typeof snapshot).sessionId).toBe(
      sid,
    );
    await expect(
      f.client.run("observe", { sessionId: "59124a8f-d71a-4099-bb43-b3d13ea26ad4" }),
    ).rejects.toThrow("not bound");
    await expect(f.client.run("open", { ...input, missionId: "other" })).rejects.toThrow(
      "different project",
    );
    expect(f.posts()).toBe(1);
    expect(JSON.stringify(await f.client.status())).not.toContain("privatecookie");
  } finally {
    await f.close();
  }
});
test("lost ACK fences new mutations and credential rotation preserves original pending scope", async () => {
  const f = await fixture();
  try {
    const configPath = join(f.root, "config.json");
    await writePrivateClientJson(configPath, f.config);
    const first = (await configuredMissionHttpClient(configPath))!;
    f.drop();
    await expect(first.run("open", input)).rejects.toThrow("no mutation is automatically retried");
    expect(f.posts()).toBe(1);
    await writePrivateClientJson(configPath, { ...f.config, credential: "b".repeat(43) });
    const rotated = (await configuredMissionHttpClient(configPath))!;
    expect(rotated.statePath).toBe(first.statePath);
    await expect(rotated.run("open", input)).rejects.toThrow("pending");
    expect(f.posts()).toBe(1);
    expect((await rotated.recoverPending()).status).toBe("recovered");
    expect((await rotated.status()).pending).toBeNull();
    expect(f.posts()).toBe(1);
  } finally {
    await f.close();
  }
});
test("authenticated actor mismatch fails before mutation", async () => {
  const f = await fixture();
  try {
    f.wrongActor();
    await expect(f.client.run("open", input)).rejects.toThrow("actor differs");
    expect(f.posts()).toBe(0);
  } finally {
    await f.close();
  }
});
test("untrusted TLS certificate is rejected without sending a mutation", async () => {
  const f = await fixture();
  const other = await fixture();
  try {
    const client = new MissionHttpClient(
      { ...f.config, caCertificate: other.config.caCertificate },
      join(f.root, "untrusted.json"),
    );
    await expect(client.run("open", input)).rejects.toThrow("transport unavailable");
    expect(f.posts()).toBe(0);
  } finally {
    await f.close();
    await other.close();
  }
});

for (const scenario of ["missing", "mismatch"] as const) {
  test(`insufficient ${scenario} recovery preserves pending and never repeats effect`, async () => {
    const f = await fixture();
    try {
      f.drop();
      await expect(f.client.run("open", input)).rejects.toThrow();
      f[scenario]();
      await expect(f.client.recoverPending()).rejects.toThrow();
      expect((await f.client.status()).pending?.action).toBe("open");
      await expect(f.client.run("open", input)).rejects.toThrow("pending");
      expect(f.posts()).toBe(1);
    } finally {
      await f.close();
    }
  });
}
