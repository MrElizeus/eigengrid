#!/usr/bin/env bun
import { hostname } from "node:os";
import {
  RestartSafeScientificMissionHeadStore,
  ScientificEffectReconciliationStore,
  ScientificInternalWorkUnitStore,
  ScientificMissionHead,
  ScientificStore,
  ContentAddressedArtifactStore,
  MdProjectionStore,
  type ScientificMissionPolicyDigestResolver,
} from "@eigengrid/mission-runtime";
import { DigestSchema } from "@eigengrid/scientific-schema";
import { createApplicationContext } from "../src/composition";
import { ExactApprovalScientificMissionDriver } from "../src/services/scientific-approval-driver";
import { CanonicalScientificExecutionDriver } from "../src/services/scientific-mission-driver";
import { CanonicalScientificExecutionInspector } from "../src/services/scientific-execution-inspector";
import { CanonicalScientificPostprocessor } from "../src/services/scientific-postprocessor";
import { ScientificExecutionWithPostprocessingDriver } from "../src/services/scientific-execution-driver";
import { ScientificMissionDriverRouter } from "../src/services/scientific-internal-driver";
import { createHeadMdExecutionGateway } from "../src/services/amber-preparation-publication";
import { AmberMaterialPublicationDriver } from "../src/services/amber-material-publication";
import { EIGENGRID_VERSION } from "../src/version";

const HELP = `Usage: eigengrid-head [--once|--health] [options]

Options:
  --once                 Reconcile and execute one Head tick, then stop
  --health               Initialize dependencies, report health, then stop
  --dispatch-disabled    Monitor the durable DB without claiming/submitting work
  --owner-id <id>        Stable Head lease-owner identity
  --interval-ms <ms>     Continuous-loop interval (default: 1000)
  --lease-ms <ms>        Work-unit lease duration (default: 30000)
  --policy-digest <hex>  Current scientific policy digest
  --md-site-authority <path>  Root-provisioned MD authority configuration
  --md-artifact-root <path>   Head-owned private CAS for MD inputs and results
  --md-postprocessing <path>  Root-provisioned MD compiler/QC/replica authority
  --frozen-material-publication  Enable the closed approved frozen-material publisher
  --version              Print the EigenGrid version
  --help                 Print this help
`;

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!/^[1-9][0-9]*$/u.test(value) || !Number.isSafeInteger(parsed) || parsed > 2_147_483_647) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function log(event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(
    `${JSON.stringify({ timestamp: new Date().toISOString(), event, ...fields })}\n`,
  );
}

async function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolvePromise) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolvePromise();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
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
  const once = process.argv.includes("--once") || process.argv.includes("tick");
  const health = process.argv.includes("--health") || process.argv.includes("health");
  const dispatchDisabled = process.argv.includes("--dispatch-disabled");
  const production = process.env.EIGENGRID_DEPLOYMENT_PROFILE === "production";
  // Source composition is available, but dispatch remains closed until the
  // installed candidate and complete result/recovery path pass site qualification.
  if (production && !dispatchDisabled) {
    throw new Error(
      "Production Slurm dispatch is not yet qualified; start Head with --dispatch-disabled",
    );
  }
  const intervalMilliseconds = positiveInteger(option("--interval-ms"), 1_000, "--interval-ms");
  const leaseMilliseconds = positiveInteger(option("--lease-ms"), 30_000, "--lease-ms");
  const ownerId =
    option("--owner-id") ?? process.env.EIGENGRID_HEAD_ID ?? `eigengrid-head:${hostname()}`;
  const configuredPolicyDigest =
    option("--policy-digest") ?? process.env.EIGENGRID_SCIENTIFIC_POLICY_DIGEST;
  const currentPolicyDigest =
    configuredPolicyDigest === undefined ? undefined : DigestSchema.parse(configuredPolicyDigest);
  const mdSiteAuthorityConfigPath =
    option("--md-site-authority") ?? process.env.EIGENGRID_HEAD_MD_SITE_AUTHORITY;
  const mdArtifactRoot =
    option("--md-artifact-root") ?? process.env.EIGENGRID_HEAD_MD_ARTIFACT_ROOT;
  const mdPostprocessingConfigPath =
    option("--md-postprocessing") ?? process.env.EIGENGRID_HEAD_MD_POSTPROCESSING;
  if (mdPostprocessingConfigPath && !mdSiteAuthorityConfigPath)
    throw new Error("MD postprocessing requires the canonical MD gateway");
  const frozenMaterialPublication = process.argv.includes("--frozen-material-publication");
  if (
    frozenMaterialPublication &&
    (currentPolicyDigest === undefined || mdArtifactRoot === undefined)
  )
    throw new Error(
      "Frozen-material publication requires explicit policy authority and a private CAS",
    );
  if (mdSiteAuthorityConfigPath !== undefined && currentPolicyDigest === undefined)
    throw new Error("The Head MD gateway requires an explicit scientific policy digest");
  if (
    mdSiteAuthorityConfigPath !== undefined &&
    mdArtifactRoot === undefined &&
    !dispatchDisabled &&
    !health
  )
    throw new Error("The Head MD gateway requires a private --md-artifact-root");
  const currentPolicyDigestFor: ScientificMissionPolicyDigestResolver = () => currentPolicyDigest;

  const context = await createApplicationContext();
  const controller = new AbortController();
  const stop = (signalName: string): void => {
    if (!controller.signal.aborted) {
      log("scientific_head_shutdown_requested", { signal: signalName, ownerId });
      controller.abort();
    }
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));

  try {
    if (health) {
      log("scientific_head_health", {
        status: dispatchDisabled ? "not-ready" : "database-ready",
        liveness: true,
        readiness: !dispatchDisabled && currentPolicyDigest !== undefined,
        databaseSchema: await context.db.getMigrationVersion(),
        dispatchEnabled: !dispatchDisabled,
        ownerId,
      });
      if (dispatchDisabled || currentPolicyDigest === undefined) process.exitCode = 1;
      return;
    }

    if (dispatchDisabled) {
      log("scientific_head_dispatch_disabled", {
        ownerId,
        readiness: false,
        production,
        version: EIGENGRID_VERSION,
        releaseCommit: process.env.EIGENGRID_RELEASE_COMMIT ?? null,
      });
      do {
        const databaseSchema = await context.db.getMigrationVersion();
        log("scientific_head_standby", {
          ownerId,
          databaseSchema,
          liveness: true,
          readiness: false,
          dispatchEnabled: false,
        });
        if (once) break;
        await sleep(intervalMilliseconds, controller.signal);
      } while (!controller.signal.aborted);
      return;
    }

    const store = new ScientificStore(context.db);
    const canonical = new CanonicalScientificExecutionDriver({
      store,
      execution: context.execution,
      effectPersistence: new ScientificEffectReconciliationStore(context.db),
      currentPolicyDigestFor,
      ...(mdSiteAuthorityConfigPath !== undefined &&
      currentPolicyDigest !== undefined &&
      mdArtifactRoot !== undefined
        ? {
            md: createHeadMdExecutionGateway({
              database: context.db,
              siteAuthorityConfigPath: mdSiteAuthorityConfigPath,
              currentPolicyDigest,
              artifactRoot: mdArtifactRoot,
              postprocessingConfigPath: mdPostprocessingConfigPath,
            }),
          }
        : {}),
    });
    const postprocessor = new CanonicalScientificPostprocessor({
      store,
      execution: context.execution,
      inspector: new CanonicalScientificExecutionInspector(context.db),
    });
    const external = new ScientificExecutionWithPostprocessingDriver({
      store,
      executionDriver: canonical,
      postprocessor,
    });
    const materialArtifacts = frozenMaterialPublication
      ? new ContentAddressedArtifactStore(mdArtifactRoot!)
      : undefined;
    if (materialArtifacts) await materialArtifacts.init();
    const router = new ScientificMissionDriverRouter({
      store,
      persistence: new ScientificInternalWorkUnitStore(context.db),
      externalDriver: external,
      ...(materialArtifacts && currentPolicyDigest
        ? {
            systemPreparationDriver: new AmberMaterialPublicationDriver(
              {
                database: context.db,
                store,
                mdStore: new MdProjectionStore(context.db, materialArtifacts),
                artifacts: materialArtifacts,
              },
              () => currentPolicyDigest,
            ),
          }
        : {}),
    });
    const driver = new ExactApprovalScientificMissionDriver({
      store,
      delegate: router,
      currentPolicyDigestFor,
    });
    const head = new ScientificMissionHead({
      ownerId,
      store: new RestartSafeScientificMissionHeadStore(store, context.db),
      driver,
      leaseMilliseconds,
      policyDigestFor: currentPolicyDigestFor,
    });

    log("scientific_head_ready", {
      ownerId,
      mode: once ? "once" : "continuous",
      leaseMilliseconds,
      intervalMilliseconds,
      policyAuthority: currentPolicyDigest ? "configured" : "unavailable",
    });
    do {
      const report = await head.tick(controller.signal);
      log("scientific_head_tick", { ownerId, report });
      if (once) break;
      await sleep(intervalMilliseconds, controller.signal);
    } while (!controller.signal.aborted);
  } finally {
    await context.close();
    log("scientific_head_stopped", { ownerId });
  }
}

await main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      event: "scientific_head_failed",
      message: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exitCode = 1;
});
