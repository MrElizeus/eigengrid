import {
  assertMdWorkflowProtocolDigest,
  assertPublishedBiomolecularSystemManifestDigest,
  type EvidenceReference,
} from "@eigengrid/scientific-schema";
import {
  type MissionApplicationContext,
  MissionApplicationError,
  type MissionApplicationState,
} from "./contracts";
import { missionVerifyEvidence } from "./evidence";
import { type MissionCandidate } from "./requests";

export function missionPolicy<C extends MissionApplicationContext>(
  application: MissionApplicationState<C>,
  candidate: MissionCandidate,
  context: C,
) {
  if (
    candidate.md &&
    (!context.mdCompilerPolicy || !context.mdEnvironment || !application.options.mdStore)
  )
    throw new MissionApplicationError(
      "CONFLICT",
      "MD candidate requires trusted MD policy, environment, and projection store",
    );
  return candidate.md ? context.mdCompilerPolicy! : context.compilerPolicy;
}

export async function missionVerifyMd<C extends MissionApplicationContext>(
  application: MissionApplicationState<C>,
  candidate: MissionCandidate,
  context: C,
  evidence: readonly EvidenceReference[],
) {
  missionPolicy(application, candidate, context);
  const md = candidate.md!;
  const system = assertPublishedBiomolecularSystemManifestDigest(md.system);
  const protocol = assertMdWorkflowProtocolDigest(md.protocol);
  const persisted = await application.options.mdStore!.getSystemManifest(
    system.id,
    system.revision,
  );
  if (
    !persisted ||
    persisted.missionId !== candidate.plan.missionId ||
    persisted.manifestDigest !== system.manifestDigest ||
    protocol.missionId !== candidate.plan.missionId ||
    protocol.system.manifestDigest !== system.manifestDigest
  )
    throw new MissionApplicationError(
      "CONFLICT",
      "MD system must already have exact published preparation authority in this mission",
    );
  for (const ref of md.decisionRefs) {
    const decision = await application.options.mdStore!.getBiomolecularDecision(
      ref.id,
      ref.revision,
    );
    if (
      !decision ||
      decision.missionId !== candidate.plan.missionId ||
      decision.decisionDigest !== ref.decisionDigest
    )
      throw new MissionApplicationError("CONFLICT", "MD decision lacks exact durable authority");
  }
  for (const stage of protocol.stages)
    for (const artifact of stage.inputs) {
      const reference = evidence.find(
        (item) => item.id === artifact.evidenceRef && item.contentDigest === artifact.contentDigest,
      );
      if (!reference)
        throw new MissionApplicationError(
          "INVALID_CANDIDATE",
          `MD stage input ${artifact.evidenceRef} is absent or changed`,
        );
      await missionVerifyEvidence(application, [reference], candidate.plan.missionId);
    }
}
