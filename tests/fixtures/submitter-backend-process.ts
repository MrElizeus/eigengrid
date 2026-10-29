/** TEST ONLY. Counted filesystem effect, not an Amber/Slurm backend or service.
 * Imported ONLY by process-boundary tests. Never packaged or installed.
 */
import {
  appendFileSync,
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import {
  PipeBackendChannel,
  serveSubmitterBackendSession,
} from "../../apps/cli/src/services/submitter-backend-session";

const config = JSON.parse(readFileSync(process.argv[3]!, "utf8")) as {
  mode: string;
  counter: string;
  descriptors: string;
  environment: string;
  descendant: string;
};
const inherited = readdirSync("/proc/self/fd").flatMap((fd) => {
  try {
    return [readlinkSync(`/proc/self/fd/${fd}`)];
  } catch {
    return [];
  }
});
writeFileSync(config.descriptors, JSON.stringify(inherited));
writeFileSync(config.environment, JSON.stringify({ env: process.env, identity: userInfo() }));
closeSync(Number(process.argv[5])); // TEST launch marker only, not root authority

const channel = new PipeBackendChannel(
  Bun.stdin.stream(),
  (bytes) =>
    new Promise<void>((resolve, reject) => {
      process.stdout.write(bytes, (error) => (error ? reject(error) : resolve()));
    }),
);
const backend = {
  async prepare(capability: { action: "submit" | "observe" | "accounting"; operationId: string }) {
    if (config.mode === "prepare-crash") process.exit(24);
    return { action: capability.action, operationId: capability.operationId };
  },
  async submit() {
    if (config.mode === "before-effect") throw new Error("TEST injected pre-effect failure");
    appendFileSync(config.counter, "one\n");
    const fd = openSync(config.counter, "r");
    fsyncSync(fd);
    closeSync(fd);
    if (config.mode === "lost-ack") process.exit(29);
    if (config.mode === "descendant") {
      const child = Bun.spawn(
        [
          "/usr/bin/python3",
          "-I",
          "-c",
          "import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(30)",
        ],
        { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: false },
      );
      writeFileSync(config.descendant, String(child.pid));
      child.unref();
    }
    return {
      status: "acknowledged" as const,
      jobId: "45",
      cluster: "fixture-cluster",
      resubmitAllowed: false as const,
    };
  },
  async observe() {
    return {
      status: "indeterminate" as const,
      reason: "TEST no accounting",
      resubmitAllowed: false as const,
      observations: [],
    };
  },
  async accounting() {
    return {
      observation: {
        status: "indeterminate" as const,
        reason: "TEST no accounting",
        resubmitAllowed: false as const,
        observations: [],
      },
      accounting: null,
    };
  },
};
process.stdout.on("error", () => {});
try {
  if (process.argv[6] === "--check-only") {
    await channel.writeFrame({
      status: "site_ready",
      uid: 2101,
      gid: 2101,
      siteProfileDigest: "a".repeat(64),
    });
  } else {
    await serveSubmitterBackendSession(channel, backend, async () => {});
  }
} catch {
  process.exitCode = 74;
} finally {
  await channel.close();
}
