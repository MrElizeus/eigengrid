import { digestCanonical, type ResolvedSkillGraph } from "@eigengrid/scientific-schema";

/**
 * Authoritative payload for a resolved scientific-skill graph digest.
 *
 * Repository identity, mission binding, and resolution time are deliberately
 * excluded. Exact skill versions, dependency edges, selected fragments,
 * resolver version, and environment compatibility are authoritative.
 */
export function resolvedScientificSkillGraphDigestPayload(
  graph: Omit<ResolvedSkillGraph, "graphDigest"> | ResolvedSkillGraph,
): Omit<ResolvedSkillGraph, "id" | "missionId" | "resolvedAt" | "graphDigest"> {
  return {
    schemaVersion: graph.schemaVersion,
    requestedSkillIds: graph.requestedSkillIds,
    nodes: graph.nodes,
    edges: graph.edges,
    selectedFragments: graph.selectedFragments,
    resolverVersion: graph.resolverVersion,
    environmentDigest: graph.environmentDigest,
  };
}

/** Lower-case SHA-256 digest consumed by persistence and protocol compilation. */
export function computeResolvedScientificSkillGraphDigest(
  graph: Omit<ResolvedSkillGraph, "graphDigest"> | ResolvedSkillGraph,
): string {
  return digestCanonical(resolvedScientificSkillGraphDigestPayload(graph));
}

/**
 * Return a graph whose content digest is reusable across missions while its
 * persisted record identity remains mission-scoped.
 */
export function withResolvedScientificSkillGraphDigest(
  graph: Omit<ResolvedSkillGraph, "graphDigest"> | ResolvedSkillGraph,
): ResolvedSkillGraph {
  const {
    graphDigest: _ignored,
    id: _staleId,
    ...withoutDigestAndId
  } = graph as ResolvedSkillGraph;
  const digest = computeResolvedScientificSkillGraphDigest({
    ...withoutDigestAndId,
    id: "pending",
  });
  return {
    ...withoutDigestAndId,
    id: `skill-graph-${digestCanonical({
      missionId: withoutDigestAndId.missionId,
      graphDigest: digest,
    }).slice(0, 24)}`,
    graphDigest: digest,
  };
}
