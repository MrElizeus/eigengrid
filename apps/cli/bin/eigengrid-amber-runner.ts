#!/usr/bin/env bun
import { canonicalJson } from "@eigengrid/scientific-schema";
import { AmberRunnerCapsuleSchema } from "../src/services/amber-slurm-profile";
import { loadAmberSlurmSiteProfile } from "../src/services/amber-slurm-site-files";
import {
  amberRunnerAllocationObservation,
  collectAmberSlurmStage,
  runAmberSlurmStage,
} from "../src/services/amber-slurm-runner";
import { EIGENGRID_VERSION } from "../src/version";

/** Worker-local only. A capsule identifies admitted bytes, not authority to
 * submit Slurm or mutate an attempt. Site/UID/allocation checks remain mandatory.
 * --collect reads only this UID's worker workspace and never starts a process.
 */
async function main(): Promise<void> {
  let args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write(
      "Usage: eigengrid-amber-runner [--collect] --site-profile <protected-file> --capsule <canonical-base64>\nWorker-local execution requires an admitted capsule, protected site identity and a verified allocation.\n",
    );
    return;
  }
  if (args.length === 1 && args[0] === "--version") {
    process.stdout.write(`${EIGENGRID_VERSION}\n`);
    return;
  }
  const collect = args[0] === "--collect";
  if (collect) args = args.slice(1);
  if (args.length !== 4 || args[0] !== "--site-profile" || args[2] !== "--capsule")
    throw new Error("Invalid fixed Amber runner arguments");
  const [profilePath, encoded] = [args[1]!, args[3]!];
  if (!encoded.length || encoded.length > 64 * 1024) throw new Error("Invalid capsule size");
  const bytes = Buffer.from(encoded, "base64");
  const text = bytes.toString("utf8");
  const capsule = AmberRunnerCapsuleSchema.parse(JSON.parse(text));
  if (
    bytes.toString("base64") !== encoded ||
    !Buffer.from(text).equals(bytes) ||
    canonicalJson(capsule) !== text
  )
    throw new Error("Noncanonical capsule");
  if (!collect)
    process.stdout.write(
      canonicalJson({
        event: "amber_runner_allocation",
        observation: amberRunnerAllocationObservation(),
      }) + "\n",
    );
  const profile = await loadAmberSlurmSiteProfile(profilePath);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  process.once("SIGHUP", stop);
  try {
    if (collect)
      process.stdout.write(canonicalJson(await collectAmberSlurmStage(capsule, profile)) + "\n");
    else {
      const result = await runAmberSlurmStage(capsule, profile, controller.signal);
      process.stdout.write(canonicalJson(result) + "\n");
      process.exitCode = result.exitCode;
    }
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGHUP", stop);
  }
}

main().catch(() => {
  // Detailed diagnostics belong to protected evidence, not arbitrary RPC text.
  process.stderr.write('{"event":"amber_worker_failed","resubmitAllowed":false}\n');
  process.exitCode = 74;
});
