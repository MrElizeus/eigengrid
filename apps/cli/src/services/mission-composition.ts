import { canonicalJson } from "@eigengrid/scientific-schema";
import { reconcileFailedAllocation } from "./md-failed-allocation-review";
import { callSubmitter, decodeSubmitterAccountingResponse } from "@eigengrid/slurm";
import { parseAmberSlurmDelivery } from "./amber-slurm-delivery";
import { reconcileReviewedNoSubmit } from "./md-no-submit-review";
import { PostgresDatabase } from "@eigengrid/db";
import {
  ContentAddressedArtifactStore,
  MdProjectionStore,
  ScientificStore,
  ScientificEffectReconciliationStore,
  MdPreparationPublicationStore,
} from "@eigengrid/mission-runtime";
import { ScientificMissionService } from "@eigengrid/scientific-agent";
import { MissionApplication } from "./mission-application";
import { MissionLocalAuthority, type MissionLocalContext } from "./mission-local-authority";
import { importMissionArtifact } from "./mission-request-file";
import { importAmberPreparedSystem } from "./amber-prepared-system-import";
import { AmberMaterialApplication } from "./amber-material-publication";
import { publishApprovedMdPreparation } from "./amber-md-preparation";
import { createHeadMdSiteAuthorityReader } from "./head-md-site-authority";

/** pg can inherit options, endpoints and TLS settings from libpq environment. */
export function assertMissionDatabaseEnvironment(environment: NodeJS.ProcessEnv): void {
  if (
    Object.keys(environment).some(
      (key) => /^PG[A-Z_]+$/u.test(key) && environment[key] !== undefined,
    )
  )
    throw new Error("Mission commands require libpq PG* environment overrides to be unset");
  if (environment.NODE_TLS_REJECT_UNAUTHORIZED === "0")
    throw new Error("Mission commands require TLS certificate verification");
}

/** Fixed protected composition; there are no DSN, identity, policy or CAS CLI overrides. */
export async function openMissionApplication(
  authority: {
    current(): Promise<MissionLocalContext>;
    assertCurrent(context: MissionLocalContext): Promise<void>;
  } = new MissionLocalAuthority(),
) {
  assertMissionDatabaseEnvironment(process.env);
  const context = await authority.current();
  const database = new PostgresDatabase(context.databaseUrl, { migrations: "validate" });
  const artifacts = new ContentAddressedArtifactStore(context.artifactRoot);
  const close = async () => {
    try {
      await artifacts.close();
    } finally {
      await database.close();
    }
  };
  try {
    try {
      await database.init();
    } catch {
      throw new Error("Protected mission database connection or schema validation failed");
    }
    await authority.assertCurrent(context);
    await artifacts.init();
    const store = new ScientificStore(database);
    const mdStore = new MdProjectionStore(database, artifacts);
    const application = new MissionApplication({
      store,
      service: new ScientificMissionService({ store }),
      artifacts,
      mdStore,
      authority: {
        async current() {
          await authority.assertCurrent(context);
          return context;
        },
        async assertCurrent(value) {
          if (value !== context) throw new Error("Mission composition context changed");
          await authority.assertCurrent(context);
        },
      },
    });
    return {
      application,
      database,
      artifacts,
      context,
      async reconcileNoSubmit(request: unknown) {
        await authority.assertCurrent(context);
        return reconcileReviewedNoSubmit(request, {
          store,
          effects: new ScientificEffectReconciliationStore(database),
          artifacts,
          site: createHeadMdSiteAuthorityReader("/etc/eigengrid/md-site-authority.json"),
          reviews: context.mdNoSubmitReviews ?? [],
          actor: context.authenticatedActor,
          roles: context.authorizedRoles,
          access: async (address) => {
            await authority.assertCurrent(context);
            await application.status(address);
          },
        });
      },
      async reconcileFailedAllocation(request: unknown) {
        await authority.assertCurrent(context);
        const site = createHeadMdSiteAuthorityReader("/etc/eigengrid/md-site-authority.json");
        return reconcileFailedAllocation(request, {
          store,
          effects: new ScientificEffectReconciliationStore(database),
          artifacts,
          site,
          reviews: context.mdFailedAllocationReviews ?? [],
          actor: context.authenticatedActor,
          roles: context.authorizedRoles,
          access: async (address) => {
            await authority.assertCurrent(context);
            await application.status(address);
          },
          accounting: async (delivery) => {
            const session = site.createAmberAccountingSession(database, {
              subject: delivery.principal.subject,
              projectId: delivery.principal.projectId,
            });
            const prepared = await session.accounting(delivery.operationId);
            const target = await session.authorizeAccountingRpc({ prepared });
            if (canonicalJson(target.delivery) !== canonicalJson(delivery))
              throw new Error("Accounting changed exact failed delivery");
            const response = decodeSubmitterAccountingResponse(
              await callSubmitter(target.socketPath, target.wire),
              {
                operationId: delivery.operationId,
                binding: parseAmberSlurmDelivery(delivery).binding,
              },
            );
            if (response.status !== "accounting")
              throw new Error("Failed allocation accounting rejected");
            return response;
          },
        });
      },
      async publishMdStage(request: unknown) {
        if (!context.mdCompilerPolicy) throw new Error("MD policy is not provisioned");
        await authority.assertCurrent(context);
        return publishApprovedMdPreparation(request, {
          store,
          mdStore,
          artifacts,
          publications: new MdPreparationPublicationStore(database),
          siteAuthority: createHeadMdSiteAuthorityReader("/etc/eigengrid/md-site-authority.json"),
          policyDigest: context.mdCompilerPolicy.policyDigest,
          assertAccess: async (address) => {
            await authority.assertCurrent(context);
            await application.status(address);
          },
        });
      },
      async applyAmberMaterial(request: unknown) {
        await authority.assertCurrent(context);
        return new AmberMaterialApplication({
          database,
          store,
          mdStore,
          artifacts,
          authority: {
            async current() {
              await authority.assertCurrent(context);
              return context;
            },
            async assertCurrent(value) {
              if (value !== context) throw new Error("Material composition context changed");
              await authority.assertCurrent(context);
            },
          },
        }).apply(request);
      },
      async importArtifact(path: string, expectedDigest: string) {
        const assertActive = async () => {
          await authority.assertCurrent(context);
          const user = await database.getUser(context.authenticatedActor.id);
          if (!user || user.status !== "active")
            throw new Error("Mission operator account is inactive");
        };
        await assertActive();
        return importMissionArtifact(artifacts, path, expectedDigest, assertActive);
      },
      async importPreparedSystem(directory: string) {
        const assertActive = async () => {
          await authority.assertCurrent(context);
          const user = await database.getUser(context.authenticatedActor.id);
          if (!user || user.status !== "active")
            throw new Error("Mission operator account is inactive");
        };
        await assertActive();
        return importAmberPreparedSystem({
          directory,
          actor: context.authenticatedActor,
          store,
          mdStore,
          artifacts,
          assertCurrent: assertActive,
        });
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
