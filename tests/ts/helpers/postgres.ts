import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface EphemeralPostgresCluster {
  dataDir: string;
  port: number;
  url: string;
  cleanup: () => void | Promise<void>;
}

export const canRunPostgres = (() => {
  if (process.env.EIGENGRID_TEST_POSTGRES_URL) return true;
  try {
    return Bun.spawnSync(["which", "initdb"]).success;
  } catch {
    return false;
  }
})();

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

export async function startEphemeralPostgres(): Promise<EphemeralPostgresCluster> {
  // Never consume DATABASE_URL: an operator shell may point at production.
  // EIGENGRID_TEST_POSTGRES_URL explicitly authorizes a disposable test database.
  const explicitUrl = process.env.EIGENGRID_TEST_POSTGRES_URL;
  if (explicitUrl) {
    // Every fixture owns a new database, including migration-drift tests.
    // The supplied URL is an administration endpoint, never the fixture itself.
    const { Client } = await import("pg");
    const admin = new Client({ connectionString: explicitUrl, connectionTimeoutMillis: 5_000 });
    const name = `eigengrid_test_${crypto.randomUUID().replaceAll("-", "")}`;
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${name}`);
    } catch (error) {
      await admin.end();
      throw error;
    }
    const url = new URL(explicitUrl);
    url.pathname = `/${name}`;
    return {
      dataDir: "",
      port: 0,
      url: url.toString(),
      cleanup: async () => {
        try {
          await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
        } finally {
          await admin.end();
        }
      },
    };
  }

  const dataDir = mkdtempSync(join(tmpdir(), "eigengrid-pg-"));
  const port = 15_432 + Math.floor(Math.random() * 1_000);
  const user = process.env.USER || "eigengrid";
  const url = `postgres://${user}@localhost:${port}/eigengrid_test`;
  const initialized = Bun.spawnSync(["initdb", "--auth=trust", "-D", dataDir, "-U", user]);
  if (!initialized.success) {
    rmSync(dataDir, { recursive: true, force: true });
    throw new Error(`initdb failed: ${initialized.stderr.toString()}`);
  }

  const postgres = Bun.spawn(["postgres", "-D", dataDir, "-p", String(port), "-k", dataDir], {
    env: { ...process.env },
  });
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (
      Bun.spawnSync(["pg_isready", "-h", "localhost", "-p", String(port), "-d", "postgres"]).success
    ) {
      ready = true;
      break;
    }
    await sleep(200);
  }
  if (!ready) {
    postgres.kill();
    rmSync(dataDir, { recursive: true, force: true });
    throw new Error("PostgreSQL did not become ready within 6000ms");
  }

  const created = Bun.spawnSync([
    "createdb",
    "-h",
    "localhost",
    "-p",
    String(port),
    "-U",
    user,
    "eigengrid_test",
  ]);
  if (!created.success) {
    postgres.kill();
    rmSync(dataDir, { recursive: true, force: true });
    throw new Error(`createdb failed: ${created.stderr.toString()}`);
  }

  return {
    dataDir,
    port,
    url,
    cleanup: () => {
      Bun.spawnSync(["pg_ctl", "-D", dataDir, "-m", "fast", "stop"]);
      postgres.kill(9);
      rmSync(dataDir, { recursive: true, force: true, retryDelay: 100, maxRetries: 3 });
    },
  };
}
