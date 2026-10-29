/** Real immutable Amber bundle and admitted delivery for raw-collection store
 * tests. Molecular input bytes are explicitly synthetic; no
 * external scientific execution or scientific acceptance is asserted here. */
import { generateKeyPairSync } from "node:crypto";
import {
  ContentAddressedArtifactStore,
  ScientificEffectReconciliationStore,
  ScientificStore,
  mdStageEffectIdentity,
  type ScientificDatabase,
} from "@eigengrid/mission-runtime";
import {
  ExternalOperationSchema,
  MdExecutionBindingParametersSchema,
  digestCanonical,
  type WorkUnit,
} from "@eigengrid/scientific-schema";
import {
  createAmberMdStageOperationRequest,
  renderCanonicalAmberStage,
} from "@eigengrid/amber-adapter";
import {
  assertAmberRunnerCapsule,
  buildAdmittedAmberSlurmBody,
  computeAmberSlurmSiteProfileDigest,
  type AmberSlurmSiteProfile,
} from "../../../apps/cli/src/services/amber-slurm-profile";
import { parseAmberSlurmDelivery } from "../../../apps/cli/src/services/amber-slurm-delivery";
import {
  signedMapping,
  unsignedMapping,
  reviewedSander26Environment,
} from "../../../packages/amber-adapter/src/canonical-stage.fixture";
import { publishAmberStageBundle } from "../../../apps/cli/src/services/amber-stage-bundle";
import { HeadMdDeliverySigner } from "../../../apps/cli/src/services/md-delivery-signer";
import {
  MD_FIXTURE_NOW,
  MD_FIXTURE_POLICY,
  MD_FIXTURE_PROJECT,
  MD_FIXTURE_SUBJECT,
  type seedCanonicalMdAuthority,
} from "./canonical-md-authority";

type Seeded = Awaited<ReturnType<typeof seedCanonicalMdAuthority>>;
export async function publishCanonicalMdFixtureBundle(
  cas: ContentAddressedArtifactStore,
  seeded: Seeded,
  workUnit: WorkUnit,
) {
  const executionBinding = MdExecutionBindingParametersSchema.parse(
    workUnit.protocolFragment.parameters,
  );
  const base = unsignedMapping(seeded.stage, executionBinding);
  const environment = reviewedSander26Environment();
  const mapping = signedMapping({
    ...base,
    canonicalAtomMap: {
      id: seeded.atomMap.id,
      revision: seeded.atomMap.revision,
      mapDigest: seeded.atomMap.mapDigest,
      viewVersion: "1.0.0",
    },
    environment,
    artifactPaths: {
      ...base.artifactPaths,
      inputs: seeded.stage.inputs.map((input) => ({
        artifactId: input.artifactId,
        role: input.role,
        contentDigest: input.contentDigest,
        logicalPath: input.role === "topology" ? "inputs/system.prmtop" : "inputs/system.rst7",
      })),
    },
  });
  const rendered = renderCanonicalAmberStage(
    seeded.stage,
    mapping,
    executionBinding,
    seeded.atomMap,
  );
  const request = createAmberMdStageOperationRequest(rendered, environment, {
    workUnitId: workUnit.id,
    bindingDigest: mapping.canonicalWorkUnit.bindingDigest,
    outputContractDigest: digestCanonical(workUnit.outputContract),
  });
  return publishAmberStageBundle(cas, {
    stage: seeded.stage,
    mapping,
    executionBinding,
    atomMap: seeded.atomMap,
    request,
  });
}

export function canonicalMdFixtureProfile(
  publicationRoot = "/fixture/publication",
): AmberSlurmSiteProfile {
  const environment = reviewedSander26Environment().canonicalSnapshot.engine;
  const profile: AmberSlurmSiteProfile = {
    schemaVersion: "eigengrid.amber-slurm-site/v1",
    profilePath: "/fixture/profile.json",
    transport: {
      cluster: "counted-fixture",
      slurmVersion: "23.11.4",
      uid: 2101,
      username: "test-scientist",
      home: "/home/test-scientist",
      submissionDirectory: "/home/test-scientist/.eg-submit",
      siteProfileDigest: "0".repeat(64),
      partition: "test",
      node: "counted-node",
      account: "test-account",
      cpuLimit: 2,
      memoryMiBLimit: 1024,
      walltimeLimitSeconds: 3600,
    },
    gid: 2101,
    runnerExecutable: "/opt/test-only-amber-runner",
    runnerSha256: "1".repeat(64),
    amberHome: "/opt/test-only-amber",
    sanderSha256: environment.buildDigest,
    amberVersion: environment.version,
    engineEnvironmentDigest: environment.environmentDigest,
    scratchRoot: "/scratch/test-only",
    projects: [{ subject: MD_FIXTURE_SUBJECT, projectId: MD_FIXTURE_PROJECT, publicationRoot }],
  };
  profile.transport.siteProfileDigest = computeAmberSlurmSiteProfileDigest(profile);
  return profile;
}

export async function consumeCanonicalMdFixtureDelivery(
  database: ScientificDatabase,
  cas: ContentAddressedArtifactStore,
  seeded: Seeded,
  workUnit: WorkUnit,
  profile: AmberSlurmSiteProfile = canonicalMdFixtureProfile(),
  options: { policyDigest?: string; now?: string } = {},
) {
  const policy = options.policyDigest ?? MD_FIXTURE_POLICY;
  const at = options.now ?? MD_FIXTURE_NOW;
  const store = new ScientificStore(database);
  const effects = new ScientificEffectReconciliationStore(database, () => new Date(at));
  const bundle = await publishCanonicalMdFixtureBundle(cas, seeded, workUnit);
  const operationId = `operation-${workUnit.id}`;
  const reservationId = `reservation-${workUnit.id}`;
  const budget = await store.getMissionBudget(workUnit.missionId);
  await store.reserveBudget({
    missionId: workUnit.missionId,
    expectedBudgetRevision: budget.revision,
    reservation: {
      id: reservationId,
      kind: "external_operation",
      amount: 1,
      state: "reserved",
      workUnitId: workUnit.id,
      operationId,
      createdAt: at,
      updatedAt: at,
    },
  });
  const intent = await store.createOperationIntent(
    ExternalOperationSchema.parse({
      id: operationId,
      missionId: workUnit.missionId,
      workUnitId: workUnit.id,
      idempotencyKey: `idempotency-${workUnit.id}`,
      kind: "md_stage_execution",
      state: "intent",
      request: bundle.manifest.request,
      requestDigest: digestCanonical(bundle.manifest.request),
      policyDigest: policy,
      budgetReservationId: reservationId,
      revision: 1,
      createdAt: at,
      updatedAt: at,
    }),
    { claimOwner: seeded.ownerId, now: at },
  );
  const begun = await effects.beginWorkUnitEffect({
    operationId,
    expectedOperationRevision: intent.revision,
    workUnitId: workUnit.id,
    expectedWorkUnitRevision: workUnit.revision,
    claimOwner: seeded.ownerId,
    ...mdStageEffectIdentity(intent),
    currentPolicyDigest: policy,
    at: at,
  });
  const grant = {
    principal: {
      subject: MD_FIXTURE_SUBJECT,
      projectId: MD_FIXTURE_PROJECT,
      uid: profile.transport.uid,
      gid: profile.gid,
      siteProfileDigest: profile.transport.siteProfileDigest,
    },
    recoveryEpoch: "collection-test-epoch",
    membershipGeneration: 1,
    currentPolicyDigest: policy,
  };
  const pem = generateKeyPairSync("ed25519")
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  const signer = new HeadMdDeliverySigner(
    database,
    () => grant,
    (authority) => buildAdmittedAmberSlurmBody(authority, grant.principal, bundle, profile),
    pem,
    () => new Date(at),
  );
  const prepared = await signer.prepare({ operationId, claimOwner: seeded.ownerId });
  if (prepared.action !== "submit")
    throw new Error("Fixture requires first exact durable delivery");
  const operation = await store.transitionExternalOperation({
    operationId,
    expectedRevision: begun.operation.revision,
    to: "acknowledged",
    at: at,
    externalIdentity: {
      slurmJobId: "9001",
      slurmCluster: profile.transport.cluster,
      slurmUid: profile.transport.uid,
      slurmSubmittedAt: at,
    },
  });
  const body = parseAmberSlurmDelivery(prepared.delivery);
  const capsule = assertAmberRunnerCapsule(
    {
      schemaVersion: "eigengrid.amber-runner-capsule/v1",
      operationId,
      admissionDigest: prepared.delivery.admissionDigest,
      fencingGeneration: prepared.delivery.fencingGeneration,
      ...prepared.delivery.principal,
      request: body.request,
      bundle: body.bundle,
    },
    profile,
  );
  return {
    operation,
    delivery: prepared.delivery,
    bundle,
    profile,
    capsule,
    binding: body.binding,
  };
}
