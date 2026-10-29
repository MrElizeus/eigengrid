import {
  ContentAddressedArtifactStore,
  MdResultCollectionStore,
  ScientificEntityConflictError,
  ScientificIntegrityError,
  type MdResultCollection,
  type ScientificDatabase,
} from "@eigengrid/mission-runtime";
import { canonicalJson } from "@eigengrid/scientific-schema";
import {
  callSubmitter,
  decodeSubmitterAccountingResponse,
  isSlurmTerminal,
} from "@eigengrid/slurm";
import { parseAmberSlurmDelivery } from "./amber-slurm-delivery";
import { assertAmberRunnerCapsule } from "./amber-slurm-profile";
import { readAmberStageBundle } from "./amber-stage-bundle";
import { verifyAmberWorkerReceipt } from "./amber-slurm-runner";
import { createAmberResultSpool } from "./amber-result-spool";
import type { HeadMdSiteAuthorityReader } from "./head-md-site-authority";

export type MdResultCollectionOutcome =
  | { status: "collected"; collection: MdResultCollection; canonicalAcknowledged: false }
  | { status: "waiting"; detail: string }
  | { status: "conflict"; detail: string };

type Spool = Awaited<ReturnType<typeof createAmberResultSpool>>;
type CollectionStore = Pick<MdResultCollectionStore, "get" | "readAuthority" | "adopt">;

/** Only independently established contradictions become conflicts. Neither an
 * unavailable file/RPC nor an arbitrary exception proves a second identity. */
class ConfirmedMdResultConflict extends Error {}

const publicationConflicts = new Set([
  "Amber result job differs from scheduler-correlated job",
  "Amber result marker identity mismatch",
  "Amber result publication manifest differs from its exact frozen inputs",
  "Result publication binding differs from the exact Amber capsule/profile",
  "Amber worker receipt differs from the exact capsule/binding",
  "Amber worker receipt differs from exact admitted capsule",
  "Amber output inventory differs from its contract",
  "Amber artifact size mismatch",
  "Amber artifact status/budget differs from its verified inventory",
  "Invalid bounded engine evidence",
  "Amber engine evidence size mismatch",
  "Frozen engine evidence differs from its worker/capsule/JobID",
  "Amber result bytes differ from the declared digest/size",
  "Amber result object changed during collection",
  "Amber result object path changed during collection",
  "Amber result directory replaced during collection",
]);

function confirmedConflict(error: unknown): boolean {
  return (
    error instanceof ConfirmedMdResultConflict ||
    error instanceof ScientificIntegrityError ||
    error instanceof ScientificEntityConflictError ||
    (error instanceof Error && publicationConflicts.has(error.message))
  );
}

/** Internal Head service: authority comes from the consumed PostgreSQL delivery
 * and protected site reader. Neither callers nor spool bytes select an RPC,
 * principal, executable, path, job identity, or scientific verdict. */
export class CanonicalMdResultCollector {
  constructor(
    private readonly input: {
      database: ScientificDatabase;
      objects: ContentAddressedArtifactStore;
      siteAuthority: Pick<
        HeadMdSiteAuthorityReader,
        "resolveResultPublication" | "createAmberAccountingSession"
      >;
      now?: () => Date;
      callSubmitter?: typeof callSubmitter;
      openSpool?: (configPath: string) => Promise<Spool>;
      /** Local boundary test seam; never supplied by service configuration. */
      collectionStore?: CollectionStore;
    },
  ) {}

  async collect(operationId: string, signal?: AbortSignal): Promise<MdResultCollectionOutcome> {
    const waiting = (detail: string): MdResultCollectionOutcome => ({ status: "waiting", detail });
    if (signal?.aborted) return waiting("MD result collection deferred for graceful shutdown");
    let phase = "durable execution authority";
    try {
      const store =
        this.input.collectionStore ??
        new MdResultCollectionStore(this.input.database, this.input.objects);
      const previous = await store.get(operationId);
      if (previous)
        return { status: "collected", collection: previous, canonicalAcknowledged: false };
      const { operation, delivery } = await store.readAuthority(operationId);
      let body: ReturnType<typeof parseAmberSlurmDelivery>;
      try {
        body = parseAmberSlurmDelivery(delivery);
      } catch {
        throw new ConfirmedMdResultConflict("Durable Amber delivery is inconsistent");
      }
      const association = {
        subject: delivery.principal.subject,
        projectId: delivery.principal.projectId,
      };
      phase = "protected result publication authority";
      const authority = this.input.siteAuthority.resolveResultPublication(association);
      const capsule = assertAmberRunnerCapsule(
        {
          schemaVersion: "eigengrid.amber-runner-capsule/v1",
          operationId: operation.id,
          admissionDigest: delivery.admissionDigest,
          fencingGeneration: delivery.fencingGeneration,
          ...delivery.principal,
          request: body.request,
          bundle: body.bundle,
        },
        authority.profile,
      );
      phase = "authenticated scheduler accounting";
      const session = this.input.siteAuthority.createAmberAccountingSession(
        this.input.database,
        association,
        this.input.now,
      );
      const prepared = await session.accounting(operation.id);
      if (signal?.aborted) return waiting("MD result collection deferred for graceful shutdown");
      const target = await session.authorizeAccountingRpc({ prepared });
      if (canonicalJson(target.delivery) !== canonicalJson(delivery))
        throw new ConfirmedMdResultConflict("Accounting authority changed its consumed delivery");
      const raw = await (this.input.callSubmitter ?? callSubmitter)(target.socketPath, target.wire);
      const response = decodeSubmitterAccountingResponse(raw, {
        operationId,
        binding: body.binding,
      });
      if (response.status === "rejected")
        return waiting(
          "MD accounting rejected; current authority and the existing submitter claim require review",
        );
      if (response.observation.status === "conflict")
        return {
          status: "conflict",
          detail: "Authenticated scheduler observations conflict for the consumed MD delivery",
        };
      if (
        response.observation.status !== "matched" ||
        !response.accounting ||
        !isSlurmTerminal(response.accounting.state)
      )
        return waiting("MD accounting has not established an exact terminal scheduler identity");
      const identity = response.observation.identity;
      for (const [key, expected] of Object.entries({
        slurmJobId: identity.jobId,
        slurmCluster: identity.cluster,
        slurmUid: identity.uid,
        slurmSubmittedAt: identity.submittedAt,
      })) {
        if (
          operation.externalIdentity?.[key] !== undefined &&
          operation.externalIdentity[key] !== expected
        )
          throw new ConfirmedMdResultConflict(
            "Terminal accounting conflicts with the durable acknowledgement",
          );
      }
      if (signal?.aborted)
        return waiting("MD collection interrupted after accounting; metadata is unchanged");
      phase = "verified private input snapshot";
      // Saved before admission. Historical collection never renews scientific
      // approvals, rereads mutable input NFS, or invokes the engine.
      const bundle = await readAmberStageBundle(this.input.objects, body.bundle, body.request);
      phase = "bounded result spool verification";
      const spool = await (this.input.openSpool ?? createAmberResultSpool)(
        authority.resultPublicationConfigPath,
      );
      if (canonicalJson(spool.siteProfile) !== canonicalJson(authority.profile))
        throw new ConfirmedMdResultConflict("Result spool changed its protected site profile");
      const publication = await spool.openVerifiedPublication({
        capsule,
        binding: body.binding,
        expectedJobId: identity.jobId,
      });
      try {
        for (const item of publication.manifest.objects) {
          if (!item.object) continue;
          if (signal?.aborted)
            return waiting(
              "MD collection interrupted during transfer; private CAS objects remain unadopted",
            );
          const source = await publication.getStream(item.object.sha256, {
            maxBytes: item.object.sizeBytes,
          });
          const stored = await this.input.objects.putStream(source.bytes, {
            maxBytes: Math.max(1, item.object.sizeBytes),
          });
          if (stored.digest !== item.object.sha256 || stored.sizeBytes !== item.object.sizeBytes)
            throw new ConfirmedMdResultConflict("Result copy differs from its frozen object");
        }
        const receipt = await verifyAmberWorkerReceipt(
          this.input.objects,
          publication.receipt,
          capsule,
          authority.profile,
          bundle,
        );
        if (receipt.jobId !== identity.jobId)
          throw new ConfirmedMdResultConflict("Worker result targets another scheduler allocation");
        const marker = await this.input.objects.put(
          Buffer.from(canonicalJson(publication.manifest)),
        );
        if (
          marker.digest !== publication.reference.sha256 ||
          marker.sizeBytes !== publication.reference.sizeBytes
        )
          throw new ConfirmedMdResultConflict(
            "Result marker differs from its verified canonical bytes",
          );
        const accounting = await this.input.objects.put(Buffer.from(canonicalJson(response)));
        const rawReceipt = await this.input.objects.put(Buffer.from(canonicalJson(receipt)));
        if (rawReceipt.digest !== publication.manifest.receipt.sha256)
          throw new ConfirmedMdResultConflict(
            "Worker receipt differs from its verified canonical bytes",
          );
        const evidence = (
          role: string,
          object: { digest: string; sizeBytes: number },
          kind: MdResultCollection["artifacts"][number]["kind"] = "artifact",
          mediaType = "application/json",
        ) => ({ role, kind, sha256: object.digest, sizeBytes: object.sizeBytes, mediaType });
        const artifacts: MdResultCollection["artifacts"] = [
          evidence("publication", marker),
          evidence("accounting", accounting),
          evidence("worker_receipt", rawReceipt, "operation_receipt"),
          evidence("engine_claim", {
            digest: receipt.engineClaim.sha256,
            sizeBytes: receipt.engineClaim.sizeBytes,
          }),
          evidence("engine_receipt", {
            digest: receipt.engineReceipt.sha256,
            sizeBytes: receipt.engineReceipt.sizeBytes,
          }),
        ];
        for (const item of receipt.outputs) {
          if (!item.object) continue;
          const kind =
            (
              {
                "stage.restart": "restart",
                "stage.trajectory": "trajectory",
                "stage.mdout": "mdout",
                "stage.mdinfo": "mdinfo",
              } as const
            )[item.role as "stage.restart" | "stage.trajectory" | "stage.mdout" | "stage.mdinfo"] ??
            "artifact";
          artifacts.push(
            evidence(
              `output_${item.role.replaceAll(".", "_")}`,
              { digest: item.object.sha256, sizeBytes: item.object.sizeBytes },
              kind,
              item.mediaType,
            ),
          );
        }
        const success =
          response.accounting.state === "COMPLETED" &&
          response.accounting.exitCode === 0 &&
          response.accounting.signal === 0 &&
          response.accounting.derivedExitCode === 0 &&
          response.accounting.derivedSignal === 0 &&
          receipt.engine.exitCode === 0 &&
          receipt.engine.signal === null &&
          receipt.engine.executionError === null &&
          receipt.supervision?.exitCode === 0 &&
          receipt.supervision.stopReason === null;
        const outcome =
          response.accounting.state === "CANCELLED"
            ? "cancelled"
            : success
              ? "completed"
              : "failed";
        phase = "atomic canonical result adoption";
        await publication.revalidate();
        if (
          canonicalJson(this.input.siteAuthority.resolveResultPublication(association)) !==
          canonicalJson(authority)
        )
          throw new ConfirmedMdResultConflict(
            "Protected result authority changed during collection",
          );
        if (signal?.aborted)
          return waiting(
            "MD collection interrupted before adoption; private CAS objects remain unadopted",
          );
        const adopted = await store.adopt({
          schemaVersion: "eigengrid.md-result-collection/v1",
          operationId,
          deliveryDigest: delivery.deliveryDigest,
          bindingDigest: delivery.bindingDigest,
          publicationDigest: marker.digest,
          accountingDigest: accounting.digest,
          workerReceiptDigest: rawReceipt.digest,
          slurmJobId: identity.jobId,
          slurmCluster: identity.cluster,
          submittedAt: identity.submittedAt,
          uid: identity.uid,
          outcome,
          artifactStatus: receipt.artifactStatus,
          artifacts,
          durability: "pending_replication",
          scientificVerdict: "not_evaluated",
          collectedAt: (this.input.now ?? (() => new Date()))().toISOString(),
        });
        return {
          status: "collected",
          collection: adopted.collection,
          canonicalAcknowledged: false,
        };
      } finally {
        await publication.close();
      }
    } catch (error) {
      // Keep only closed classifications. Exception messages, paths and response
      // diagnostics can contain protected data and never enter operator output.
      if (confirmedConflict(error))
        return {
          status: "conflict",
          detail: `MD result collection found conflicting ${phase}; no terminal result was adopted`,
        };
      return waiting(`MD result collection awaits ${phase}; no terminal result was adopted`);
    }
  }
}
