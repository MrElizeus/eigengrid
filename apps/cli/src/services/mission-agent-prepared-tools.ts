import { createHash } from "node:crypto";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { AmberCanonicalStageMappingSchema } from "@eigengrid/amber-adapter";
import {
  MissionCandidateSchema,
  computeMissionCandidateDigest,
  MissionCancelRequestSchema,
} from "./mission-application";
import { AmberMaterialRequestSchema } from "./amber-material-publication";
import type { openMissionApplication } from "./mission-composition";
import type { AgentPrincipal } from "./agent-sessions";
import type { AgentToolCall } from "@eigengrid/agent-runtime";

const address = z.object({ projectId: z.string().min(1), missionId: z.string().min(1) }).strict();
const evidence = address
  .extend({ evidenceId: z.string().min(1), contentDigest: z.string().regex(/^[a-f0-9]{64}$/u) })
  .strict();
const revision = z.number().int().positive().safe();
const schemas = {
  "mission-capabilities": address,
  "mission-review": address.extend({ planId: z.string().min(1) }).strict(),
  "mission-evidence-list": address
    .extend({ limit: z.number().int().min(1).max(100).default(30), after: z.string().optional() })
    .strict(),
  "mission-prepared-input": evidence,
  "mission-import-candidate": evidence.extend({ expectedRevision: revision }).strict(),
  "mission-material": evidence.extend({ expectedRevision: revision }).strict(),
  "mission-publish-md-stage": evidence
    .extend({ expectedRevision: revision, workUnitId: z.string().min(1) })
    .strict(),
  "mission-cancel": address
    .extend({ expectedRevision: revision, reason: z.string().trim().min(1).max(2048) })
    .strict(),
};
export type PreparedMissionToolName = keyof typeof schemas;
const descriptions: Record<PreparedMissionToolName, string> = {
  "mission-capabilities":
    "Read host-selected engine capabilities and policy digests without credentials, filesystem paths or execution grants. Catalog knowledge alone does not imply runnable support.",
  "mission-review":
    "Read a current plan, exact candidate digest and scientific approval requests. Copy returned identities; never invent hashes or approve as a human.",
  "mission-evidence-list":
    "List immutable evidence IDs and digests in this mission. Prepared candidates, material commands and stage mappings must already be built and registered by the authorized workflow.",
  "mission-prepared-input":
    "Inspect a prepared JSON input from immutable same-mission CAS evidence, bound to its exact returned content digest. No filesystem paths or arbitrary hashes.",
  "mission-import-candidate":
    "Import a deterministically prepared candidate from same-mission evidence; host verifies and derives its candidate digest. Requests scientific approval; cannot grant it. Requires per-call human approval.",
  "mission-material":
    "Apply a prepared material command from exact immutable mission evidence. Supports proposal, execution and preparation continuation. Human scientific approve actions are forbidden. Requires per-call human approval plus existing scientific authority.",
  "mission-publish-md-stage":
    "Publish an already scientifically approved MD stage using a prepared mapping from exact same-mission evidence. No dispatch or new scientific approval. Requires per-call human approval.",
  "mission-cancel":
    "Request canonical cancellation of the current mission at the exact observed revision and supplied reason. Requires per-call human approval.",
};
const reads = new Set<PreparedMissionToolName>([
  "mission-capabilities",
  "mission-review",
  "mission-evidence-list",
  "mission-prepared-input",
]);
export const preparedMissionToolDefinitions = Object.entries(schemas).map(([name, schema]) => ({
  name,
  description: descriptions[name as PreparedMissionToolName],
  inputSchema: zodToJsonSchema(schema, { $refStrategy: "none" }) as Record<string, unknown>,
}));
export const isPreparedMissionTool = (name: string): name is PreparedMissionToolName =>
  Object.hasOwn(schemas, name);
type Session = Awaited<ReturnType<typeof openMissionApplication>>;

function inputFor(call: AgentToolCall, principal: AgentPrincipal) {
  if (!isPreparedMissionTool(call.name)) throw new Error("Unknown canonical mission tool");
  const value = schemas[call.name].parse(call.input);
  if (value.projectId !== principal.projectId || value.missionId !== principal.missionId)
    throw new Error("Cross-project mission action denied");
  return value;
}

async function preparedJson(
  session: Session,
  input: { projectId: string; missionId: string; evidenceId: string; contentDigest: string },
) {
  const provenance = await session.application.read({
    projectId: input.projectId,
    missionId: input.missionId,
  });
  const ref = provenance.evidence.find((item) => item.id === input.evidenceId);
  if (
    !ref ||
    ref.missionId !== input.missionId ||
    !ref.immutable ||
    ref.contentDigest !== input.contentDigest ||
    ref.uri !== `cas://sha256/${input.contentDigest}`
  )
    throw new Error(
      "Prepared immutable mission evidence is absent or changed; refresh mission-evidence-list",
    );
  if (!ref.mediaType || !(ref.mediaType === "application/json" || ref.mediaType.endsWith("+json")))
    throw new Error("Prepared command evidence must be JSON");
  if (ref.sizeBytes !== undefined && ref.sizeBytes > 4 * 1024 * 1024)
    throw new Error("Prepared input exceeds 4 MiB");
  const object = await session.artifacts.get(input.contentDigest);
  if (createHash("sha256").update(object.bytes).digest("hex") !== input.contentDigest)
    throw new Error("Prepared input bytes changed after approval");
  if (
    object.bytes.byteLength > 4 * 1024 * 1024 ||
    (ref.sizeBytes !== undefined && ref.sizeBytes !== object.bytes.byteLength)
  )
    throw new Error("Prepared command evidence size is invalid or exceeds 4 MiB");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(object.bytes)) as unknown;
}

async function preparedMaterial(session: Session, input: Parameters<typeof preparedJson>[1]) {
  const command = AmberMaterialRequestSchema.parse(await preparedJson(session, input));
  if (
    command.projectId !== input.projectId ||
    command.missionId !== input.missionId ||
    command.action === "approve"
  )
    throw new Error(
      "Material command is outside this mission or attempts human scientific approval",
    );
  return command;
}

/** Repeat observed-revision preflight before execution. This is not a cross-I/O
 * transaction: canonical application/store admission still owns current plan,
 * scientific approval, state and policy fencing at the durable mutation boundary.
 * Per-call approval binds the immutable prepared input ID AND its content digest.
 */
export async function validatePreparedMissionTool(
  call: AgentToolCall,
  principal: AgentPrincipal,
  session: Session,
) {
  const input = inputFor(call, principal);
  const state = await session.application.status({
    projectId: input.projectId,
    missionId: input.missionId,
  });
  if ("expectedRevision" in input && state.revision !== input.expectedRevision)
    throw new Error(
      "Mission revision changed; read mission-status and obtain a new exact approval",
    );
  if (call.name === "mission-material")
    await preparedMaterial(session, input as Parameters<typeof preparedJson>[1]);
  return reads.has(call.name as PreparedMissionToolName) ? ("allow" as const) : ("ask" as const);
}

export async function executePreparedMissionTool(
  call: AgentToolCall,
  principal: AgentPrincipal,
  session: Session,
) {
  await validatePreparedMissionTool(call, principal, session);
  const input = inputFor(call, principal);
  switch (call.name) {
    case "mission-capabilities": {
      const context = session.context;
      return {
        policy: {
          id: context.compilerPolicy.id,
          digest: context.compilerPolicy.policyDigest,
          minimumApprovalRole: context.compilerPolicy.minimumApprovalRole,
        },
        environment: {
          id: context.environment.id,
          digest: context.environment.environmentDigest,
          selectedEngine: context.environment.selectedEngine,
          capabilities: context.environment.capabilities,
        },
        md: context.mdEnvironment
          ? {
              id: context.mdEnvironment.id,
              digest: context.mdEnvironment.environmentDigest,
              engine: context.mdEnvironment.engine,
              capabilities: context.mdEnvironment.capabilities,
              targetCompatibility: context.mdEnvironment.targetCompatibility,
              policyDigest: context.mdCompilerPolicy?.policyDigest,
            }
          : null,
      };
    }
    case "mission-review":
      return session.application.review(input as z.infer<(typeof schemas)["mission-review"]>);
    case "mission-evidence-list": {
      const value = schemas["mission-evidence-list"].parse(input);
      const evidence = (
        await session.application.read({ projectId: value.projectId, missionId: value.missionId })
      ).evidence
        .filter((item) => item.immutable)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const remaining = evidence.filter((item) => !value.after || item.id > value.after);
      const selected = remaining.slice(0, value.limit);
      return {
        evidence: selected.map(({ id, kind, contentDigest, sizeBytes, mediaType }) => ({
          id,
          kind,
          contentDigest,
          sizeBytes,
          mediaType,
        })),
        nextCursor: remaining.length > selected.length ? selected.at(-1)?.id : null,
      };
    }
    case "mission-prepared-input": {
      const value = await preparedJson(session, input as Parameters<typeof preparedJson>[1]);
      if (Buffer.byteLength(JSON.stringify(value)) > 64 * 1024)
        throw new Error(
          "Prepared input is too large for conversational display; use the scientific review interface",
        );
      return {
        evidenceId: (input as z.infer<typeof evidence>).evidenceId,
        contentDigest: (input as z.infer<typeof evidence>).contentDigest,
        preparedInput: value,
      };
    }
    case "mission-import-candidate": {
      const candidate = MissionCandidateSchema.parse(
        await preparedJson(session, input as Parameters<typeof preparedJson>[1]),
      );
      if (
        candidate.plan.missionId !== principal.missionId ||
        computeMissionCandidateDigest(candidate) !== candidate.candidateDigest
      )
        throw new Error("Prepared candidate identity or digest changed");
      return session.application.importCandidate({
        projectId: principal.projectId,
        missionId: principal.missionId,
        candidate,
        expectedCandidateDigest: candidate.candidateDigest,
      });
    }
    case "mission-material":
      return session.applyAmberMaterial(
        await preparedMaterial(session, input as Parameters<typeof preparedJson>[1]),
      );
    case "mission-publish-md-stage":
      return session.publishMdStage({
        projectId: principal.projectId,
        missionId: principal.missionId,
        workUnitId: (input as z.infer<(typeof schemas)["mission-publish-md-stage"]>).workUnitId,
        mapping: AmberCanonicalStageMappingSchema.parse(
          await preparedJson(session, input as Parameters<typeof preparedJson>[1]),
        ),
      });
    case "mission-cancel":
      return session.application.requestCancel(
        MissionCancelRequestSchema.parse({
          ...input,
          schemaVersion: "eigengrid.mission-cancel/v1",
        }),
      );
    default:
      throw new Error("Unknown canonical mission tool");
  }
}

/** No effect retry: only confirmed material projection finalization is available here. */
export async function recoverPreparedMissionTool(
  call: AgentToolCall,
  principal: AgentPrincipal,
  session: Session,
): Promise<unknown | null> {
  const input = inputFor(call, principal);
  if (reads.has(call.name as PreparedMissionToolName))
    return executePreparedMissionTool(call, principal, session);
  if (call.name === "mission-material") {
    const command = await preparedMaterial(session, input as Parameters<typeof preparedJson>[1]);
    if (command.action !== "execute") return null;
    return session.reconcileConfirmedMaterialPublication({
      actorId: principal.actorId,
      projectId: principal.projectId,
      expectedRevision: (input as z.infer<(typeof schemas)["mission-material"]>).expectedRevision,
      request: command,
    });
  }
  return null;
}
