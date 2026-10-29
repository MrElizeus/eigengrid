#!/usr/bin/env bun
import { canonicalJson } from "@eigengrid/scientific-schema";
import { EIGENGRID_VERSION } from "../src/version";
import {
  BunExecutor,
  SlurmCliClient,
  SlurmSubmissionTransport,
  type AnySubmitterCapability,
} from "@eigengrid/slurm";
import {
  AmberSlurmSubmitterBackend,
  verifyRootOwnedAmberBinary,
} from "../src/services/amber-slurm-backend";
import { amberEnginePath, amberSanderPath } from "../src/services/amber-slurm-profile";
import { loadAmberSlurmSiteProfile } from "../src/services/amber-slurm-site-files";
import {
  assertSubmitterCurrentPolicy,
  consumeSubmitterLaunchAuthority,
  loadSubmitterServiceConfig,
  loadSubmitterSitePolicy,
  type SubmitterSitePolicy,
} from "../src/services/submitter-site-authority";
import {
  PipeBackendChannel,
  serveSubmitterBackendSession,
} from "../src/services/submitter-backend-session";

let startupStage = "arguments";

/** NOT a public submit CLI. Root-provisioned service launch FD + confinement are
 * mandatory, before reading any request. The private journal/listener are never
 * inherited by this child. The only external effect follows the parent's second
 * frame, after its append/fsync/revalidation, and fresh site revalidation here.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === "--help" || args[0] === "--version")) {
    process.stdout.write(
      args[0] === "--version"
        ? `${EIGENGRID_VERSION}\n`
        : "Usage: eigengrid-submit-backend --service-config <protected-file> --launch-fd <fd> [--check-only]\nInternal service child: requires a protected launch descriptor and confined OS identity.\n",
    );
    return;
  }
  if (
    (args.length !== 4 && !(args.length === 5 && args[4] === "--check-only")) ||
    args[0] !== "--service-config" ||
    args[2] !== "--launch-fd" ||
    !/^[1-9][0-9]{0,3}$/u.test(args[3]!)
  )
    throw new Error("Invalid protected backend invocation");
  startupStage = "root-config";
  const config = await loadSubmitterServiceConfig(args[1]!);
  startupStage = "launch-authority";
  consumeSubmitterLaunchAuthority(config, Number(args[3]));
  startupStage = "site-profile";
  const profile = await loadAmberSlurmSiteProfile(config.siteProfilePath);
  if (profile.transport.uid !== config.uid || profile.gid !== config.gid)
    throw new Error("Service/site profile identity mismatch");
  let initialPolicy: SubmitterSitePolicy | undefined;
  let activeCapability: AnySubmitterCapability | undefined;
  const authorize = async (capability: AnySubmitterCapability) => {
    if (
      canonicalJson(await loadSubmitterServiceConfig(config.configPath)) !== canonicalJson(config)
    )
      throw new Error("Root service configuration changed during request");
    const policy = await loadSubmitterSitePolicy(config);
    if (initialPolicy && canonicalJson(initialPolicy) !== canonicalJson(policy))
      throw new Error("Root site authority changed during request");
    if (policy.siteProfileDigest !== profile.transport.siteProfileDigest)
      throw new Error("Current site authority differs from installed renderer profile");
    assertSubmitterCurrentPolicy(capability, policy);
    initialPolicy ??= policy;
    activeCapability = capability;
  };
  startupStage = "local-identity";
  const executor = new BunExecutor("parent");
  const transport = new SlurmSubmissionTransport(profile.transport, executor);
  const accounting = new SlurmCliClient(
    {
      run(command, args, options) {
        if (command !== "sacct") throw new Error("Protected accounting permits only sacct");
        return executor.run("/usr/bin/sacct", args, {
          ...options,
          inheritEnv: false,
          cwd: "/",
          env: {
            ...options?.env,
            PATH: "/usr/bin:/bin",
            HOME: profile.transport.home,
            USER: profile.transport.username,
            LOGNAME: profile.transport.username,
          },
        });
      },
    },
    profile.transport.slurmVersion,
  );
  const backend = new AmberSlurmSubmitterBackend(
    profile,
    {
      sendAdmitted: (binding, script) =>
        transport.sendAdmitted(binding, script, async () => {
          if (!activeCapability) throw new Error("No prepared service authority");
          await authorize(activeCapability); // AFTER scontrol, immediately before effect
        }),
      discover: (binding) => transport.discover(binding),
    },
    undefined,
    Date.now,
    async (jobId) => {
      if (!activeCapability || activeCapability.action !== "accounting")
        throw new Error("No prepared accounting authority");
      await authorize(activeCapability);
      return accounting.getAccounting(jobId);
    },
  );
  const channel = new PipeBackendChannel(
    Bun.stdin.stream(),
    (bytes) =>
      new Promise<void>((resolve, reject) => {
        process.stdout.write(bytes, (error) => (error ? reject(error) : resolve()));
      }),
  );
  process.stdout.on("error", () => {}); // write callback owns EPIPE; no raw request diagnostics
  try {
    if (args[4] === "--check-only") {
      // Service startup check: same protected launch/profile/UID boundary, but
      // no capability, journal, command, scheduler query or effect is accepted.
      startupStage = "site-policy";
      const policy = await loadSubmitterSitePolicy(config);
      if (policy.siteProfileDigest !== profile.transport.siteProfileDigest)
        throw new Error("Readiness policy/profile mismatch");
      startupStage = "pinned-binaries";
      await verifyRootOwnedAmberBinary(profile.runnerExecutable, profile.runnerSha256);
      await verifyRootOwnedAmberBinary(amberSanderPath(profile), profile.sanderSha256);
      if (profile.pmemdCudaSha256)
        await verifyRootOwnedAmberBinary(
          amberEnginePath(profile, "pmemd.cuda"),
          profile.pmemdCudaSha256,
        );
      await channel.writeFrame({
        status: "site_ready",
        uid: config.uid,
        gid: config.gid,
        siteProfileDigest: policy.siteProfileDigest,
      });
      return;
    }
    startupStage = "request-protocol";
    await serveSubmitterBackendSession(channel, backend, authorize);
  } finally {
    await channel.close();
  }
}
main().catch(() => {
  // Fixed code location only, never exception text, paths, payload or keys.
  process.stderr.write(`eigengrid protected backend rejected: ${startupStage}\n`);
  process.exitCode = 74;
});
