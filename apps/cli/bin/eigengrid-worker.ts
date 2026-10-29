#!/usr/bin/env bun
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { loadConfig } from "@eigengrid/config";
import { DurableNodeHeartbeatJournal, publicDigest } from "@eigengrid/protocol";
import {
  checkWorkerLayout,
  createStopController,
  ensureWorkerLayout,
  runDaemon,
  runOnce,
  WorkerHeartbeatReporter,
  type DaemonConfig,
} from "@eigengrid/worker";
import { EIGENGRID_VERSION } from "../src/version";

const HELP = `Usage: eigengrid-worker [--init|--once|--health] [options]

Options:
  --init                         Initialize the deterministic worker layout
  --once                         Process at most one queued bundle, then stop
  --health                       Validate the layout and report health
  --scratch-dir <path>           Worker-owned scratch root
  --heartbeat-file <path>        Durable heartbeat journal
  --heartbeat-interval-ms <ms>   Heartbeat interval
  --heartbeat-expires-ms <ms>    Heartbeat expiry
  --poll-interval-ms <ms>        Queue polling interval
  --max-concurrent <count>       Maximum concurrent bundles
  --version                      Print the EigenGrid version
  --help                         Print this help
`;

/**
 * Production worker entrypoint.
 *
 * The worker is deliberately deterministic: it consumes validated bundles
 * from the worker queue and never receives a model-provider secret or a
 * general-purpose shell authority. Provisioning and systemd call this binary
 * directly; the CLI command remains a human-friendly wrapper.
 */

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be positive`);
  return parsed;
}

function log(event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(
    `${JSON.stringify({ timestamp: new Date().toISOString(), event, ...fields })}\n`,
  );
}

async function main(): Promise<void> {
  if (process.argv.includes("--version")) {
    process.stdout.write(`${EIGENGRID_VERSION}\n`);
    return;
  }
  if (process.argv.includes("--help")) {
    process.stdout.write(HELP);
    return;
  }
  const config = await loadConfig();
  const scratchDir = resolve(option("--scratch-dir") ?? config.remoteScratchDir ?? process.cwd());
  const once = process.argv.includes("--once");
  const health = process.argv.includes("--health");
  const initialize = process.argv.includes("--init");
  const heartbeatFile = option("--heartbeat-file") ?? process.env.EIGENGRID_HEARTBEAT_FILE;

  if (initialize) ensureWorkerLayout(scratchDir);
  const layout = checkWorkerLayout(scratchDir);
  if (!layout.ok) {
    throw new Error(`worker layout is incomplete (${layout.missing.join(", ")}); use --init once`);
  }
  if (health) {
    log("eigengrid_worker_health", {
      status: "healthy",
      node: config.nodeName ?? hostname(),
      scratchDir,
    });
    return;
  }
  if (once) {
    const result = await runOnce(scratchDir);
    log("eigengrid_worker_once", result);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  const stop = createStopController();
  const stopSignal = (signal: string) => {
    log("eigengrid_worker_shutdown_requested", { signal });
    stop.stop();
  };
  process.once("SIGTERM", () => stopSignal("SIGTERM"));
  process.once("SIGINT", () => stopSignal("SIGINT"));

  const heartbeatReporter = heartbeatFile
    ? new WorkerHeartbeatReporter({
        nodeId: config.nodeName ?? hostname(),
        instanceId: `worker:${process.pid}:${randomUUID()}`,
        fence: `${String(Date.now()).padStart(16, "0")}:${randomUUID()}`,
        capabilityDigest:
          (process.env.EIGENGRID_NODE_CAPABILITY_DIGEST as `sha256:${string}`) ??
          (publicDigest({
            node: config.nodeName ?? hostname(),
            runtime: "eigengrid-worker",
          }) as `sha256:${string}`),
        intervalMilliseconds: positiveInteger(
          option("--heartbeat-interval-ms"),
          10_000,
          "--heartbeat-interval-ms",
        ),
        expiresAfterMilliseconds: positiveInteger(
          option("--heartbeat-expires-ms"),
          30_000,
          "--heartbeat-expires-ms",
        ),
        journal: new DurableNodeHeartbeatJournal(resolve(heartbeatFile)),
        // The local journal is the durable handoff. A deployed Head may
        // replace this sink with its authenticated transport boundary.
        sink: (heartbeat) => log("eigengrid_worker_heartbeat", heartbeat),
      })
    : undefined;

  const workerConfig: DaemonConfig = {
    scratchDir,
    pollIntervalMs: positiveInteger(option("--poll-interval-ms"), 5_000, "--poll-interval-ms"),
    maxConcurrent: positiveInteger(option("--max-concurrent"), 1, "--max-concurrent"),
    heartbeatReporter,
  };
  log("eigengrid_worker_ready", {
    node: config.nodeName ?? hostname(),
    scratchDir,
    pollIntervalMs: workerConfig.pollIntervalMs,
    maxConcurrent: workerConfig.maxConcurrent,
    deterministic: true,
  });
  const state = await runDaemon(workerConfig, stop);
  log("eigengrid_worker_stopped", { ...state });
}

await main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      event: "eigengrid_worker_failed",
      message: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exitCode = 1;
});
