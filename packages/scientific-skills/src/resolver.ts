import {
  CapabilityMaturitySchema,
  DigestSchema,
  KnowledgeMaturitySchema,
  digestCanonical,
  type ResolvedSkillGraph,
  type SkillVersionReference,
} from "@eigengrid/scientific-schema";
import type { z } from "zod";
import { withResolvedScientificSkillGraphDigest } from "./graph-digest";
import type { ScientificSkillManifest } from "./schema";
import { ScientificSkillRegistry } from "./registry";
import { satisfiesSemver } from "./semver";
import type { LoadedScientificSkill, ResolvedScientificSkillGraph } from "./types";

type SkillDependency = ScientificSkillManifest["requires"][number];
type CapabilityMaturity = z.infer<typeof CapabilityMaturitySchema>;
type KnowledgeMaturity = z.infer<typeof KnowledgeMaturitySchema>;

export type SkillResolutionErrorCode =
  | "MISSING_DEPENDENCY"
  | "VERSION_CONFLICT"
  | "ENGINE_INCOMPATIBLE"
  | "DOMAIN_INCOMPATIBLE"
  | "MATURITY_INCOMPATIBLE"
  | "CAPABILITY_INCOMPATIBLE"
  | "SKILL_CONFLICT"
  | "CIRCULAR_DEPENDENCY"
  | "WITHDRAWN_SKILL";

export class ScientificSkillResolutionError extends Error {
  constructor(
    public readonly code: SkillResolutionErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ScientificSkillResolutionError";
  }
}

export interface RequestedSkill {
  id: string;
  range?: string;
}

export interface ResolveScientificSkillsRequest {
  requested: readonly (string | RequestedSkill)[];
  optional?: readonly (string | RequestedSkill)[];
  includeOptional?: boolean;
  missionId?: string;
  engine?: { id: string; version: string };
  domains?: readonly string[];
  minimumKnowledgeMaturity?: KnowledgeMaturity;
  minimumDomainMaturity?: CapabilityMaturity;
  requiredCapability?: CapabilityMaturity;
  activeConditions?: readonly string[];
  allowDeprecated?: boolean;
  resolverVersion?: string;
  resolvedAt?: string;
  /** Exact digest of the validated environment capability profile. */
  environmentDigest?: string;
  /** Optional non-authoritative compatibility material used when no exact digest is supplied. */
  environment?: unknown;
}

interface Constraint {
  range: string;
  reason: string;
  from?: string;
}

interface ResolutionState {
  selected: Map<string, LoadedScientificSkill>;
  constraints: Map<string, Constraint[]>;
}

const KNOWLEDGE_RANK: readonly KnowledgeMaturity[] = [
  "draft",
  "reference_curated",
  "expert_reviewed",
  "benchmark_backed",
  "production_certified",
];
const CAPABILITY_RANK: readonly CapabilityMaturity[] = [
  "reference",
  "advisory",
  "plannable",
  "renderable",
  "executable",
  "validated",
];

function normalizeRequested(requested: readonly (string | RequestedSkill)[]): RequestedSkill[] {
  return requested
    .map((item) => (typeof item === "string" ? { id: item, range: "*" } : { ...item }))
    .map((item) => ({ ...item, range: item.range ?? "*" }))
    .sort((a, b) => `${a.id}\0${a.range}`.localeCompare(`${b.id}\0${b.range}`));
}

function capabilityAvailable(
  manifest: ScientificSkillManifest,
  capability: CapabilityMaturity,
  engine?: { id: string; version: string },
): boolean {
  if (capability === "reference") return manifest.capability_levels.reference;
  if (capability === "advisory") return manifest.capability_levels.advisory;
  if (capability === "plannable") return manifest.capability_levels.plannable;
  if (!engine) return false;
  if (capability === "renderable") {
    const range = manifest.capability_levels.renderable[engine.id];
    return Boolean(range && satisfiesSemver(engine.version, range));
  }
  if (capability === "executable") {
    const range = manifest.capability_levels.executable[engine.id];
    return Boolean(range && satisfiesSemver(engine.version, range));
  }
  return manifest.capability_levels.validated[engine.id] === true;
}

function candidateCompatibility(
  skill: LoadedScientificSkill,
  request: ResolveScientificSkillsRequest,
): SkillResolutionErrorCode | undefined {
  const manifest = skill.manifest;
  if (manifest.status === "withdrawn") return "WITHDRAWN_SKILL";
  if (manifest.status === "deprecated" && !request.allowDeprecated) return "WITHDRAWN_SKILL";
  if (request.engine && Object.keys(manifest.engine_compatibility).length > 0) {
    const range = manifest.engine_compatibility[request.engine.id];
    if (!range || !satisfiesSemver(request.engine.version, range)) return "ENGINE_INCOMPATIBLE";
  }
  if (request.domains?.length) {
    if (!request.domains.some((domain) => manifest.domains.includes(domain))) {
      return "DOMAIN_INCOMPATIBLE";
    }
    if (request.minimumDomainMaturity) {
      const minimum = CAPABILITY_RANK.indexOf(request.minimumDomainMaturity);
      const matureInOneDomain = request.domains.some((domain) => {
        const maturity = manifest.domain_maturity[domain];
        return maturity ? CAPABILITY_RANK.indexOf(maturity) >= minimum : false;
      });
      if (!matureInOneDomain) return "MATURITY_INCOMPATIBLE";
    }
  }
  if (
    request.minimumKnowledgeMaturity &&
    KNOWLEDGE_RANK.indexOf(manifest.knowledge_level) <
      KNOWLEDGE_RANK.indexOf(request.minimumKnowledgeMaturity)
  ) {
    return "MATURITY_INCOMPATIBLE";
  }
  if (
    request.requiredCapability &&
    !capabilityAvailable(manifest, request.requiredCapability, request.engine)
  ) {
    return "CAPABILITY_INCOMPATIBLE";
  }
  return undefined;
}

function classifyNoCandidates(
  registry: ScientificSkillRegistry,
  id: string,
  constraints: readonly Constraint[],
  request: ResolveScientificSkillsRequest,
): ScientificSkillResolutionError {
  const versions = registry.versions(id);
  if (versions.length === 0) {
    return new ScientificSkillResolutionError(
      "MISSING_DEPENDENCY",
      `Required scientific skill ${id} is not present in the repository corpus`,
      { id, constraints },
    );
  }
  const matchingVersions = versions.filter((skill) =>
    constraints.every((constraint) => satisfiesSemver(skill.manifest.version, constraint.range)),
  );
  if (matchingVersions.length === 0) {
    return new ScientificSkillResolutionError(
      "VERSION_CONFLICT",
      `No version of ${id} satisfies ${constraints.map((item) => item.range).join(" and ")}`,
      { id, constraints, available: versions.map((item) => item.manifest.version) },
    );
  }
  const failures = matchingVersions.map((skill) => candidateCompatibility(skill, request));
  const code = failures.find((failure) => failure !== undefined) ?? "CAPABILITY_INCOMPATIBLE";
  return new ScientificSkillResolutionError(code, `No compatible version of ${id} is available`, {
    id,
    failures,
    engine: request.engine,
    domains: request.domains,
  });
}

function activeConflict(
  left: LoadedScientificSkill,
  right: LoadedScientificSkill,
  activeConditions: ReadonlySet<string>,
): string | undefined {
  for (const conflict of left.manifest.conflicts) {
    if (
      conflict.id === right.manifest.id &&
      satisfiesSemver(right.manifest.version, conflict.range) &&
      (!conflict.when || activeConditions.has(conflict.when))
    ) {
      return conflict.reason;
    }
  }
  return undefined;
}

function firstConflict(
  selected: ReadonlyMap<string, LoadedScientificSkill>,
  request: ResolveScientificSkillsRequest,
): { left: LoadedScientificSkill; right: LoadedScientificSkill; reason: string } | undefined {
  const skills = [...selected.values()].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
  const activeConditions = new Set(request.activeConditions ?? []);
  for (let leftIndex = 0; leftIndex < skills.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < skills.length; rightIndex += 1) {
      const left = skills[leftIndex];
      const right = skills[rightIndex];
      const reason =
        activeConflict(left, right, activeConditions) ??
        activeConflict(right, left, activeConditions);
      if (reason) return { left, right, reason };
    }
  }
  return undefined;
}

function cloneConstraints(source: ReadonlyMap<string, Constraint[]>): Map<string, Constraint[]> {
  return new Map([...source].map(([id, values]) => [id, [...values]]));
}

function addConstraint(
  constraints: Map<string, Constraint[]>,
  id: string,
  constraint: Constraint,
): void {
  const values = constraints.get(id) ?? [];
  if (
    !values.some(
      (existing) =>
        existing.range === constraint.range &&
        existing.reason === constraint.reason &&
        existing.from === constraint.from,
    )
  ) {
    values.push(constraint);
    values.sort((a, b) =>
      `${a.from ?? ""}\0${a.range}\0${a.reason}`.localeCompare(
        `${b.from ?? ""}\0${b.range}\0${b.reason}`,
      ),
    );
    constraints.set(id, values);
  }
}

function solveHardGraph(
  registry: ScientificSkillRegistry,
  requested: readonly RequestedSkill[],
  request: ResolveScientificSkillsRequest,
): ResolutionState {
  const initialConstraints = new Map<string, Constraint[]>();
  for (const item of requested) {
    addConstraint(initialConstraints, item.id, {
      range: item.range ?? "*",
      reason: "explicitly requested",
    });
  }
  let mostSpecificError: ScientificSkillResolutionError | undefined;

  function recurse(state: ResolutionState): ResolutionState | undefined {
    for (const [id, skill] of state.selected) {
      const constraints = state.constraints.get(id) ?? [];
      if (!constraints.every((item) => satisfiesSemver(skill.manifest.version, item.range))) {
        mostSpecificError = classifyNoCandidates(registry, id, constraints, request);
        return undefined;
      }
    }
    const nextId = [...state.constraints.keys()].filter((id) => !state.selected.has(id)).sort()[0];
    if (!nextId) {
      const conflict = firstConflict(state.selected, request);
      if (conflict) {
        mostSpecificError = new ScientificSkillResolutionError(
          "SKILL_CONFLICT",
          `${conflict.left.manifest.id} conflicts with ${conflict.right.manifest.id}: ${conflict.reason}`,
          {
            left: conflict.left.manifest.id,
            right: conflict.right.manifest.id,
            reason: conflict.reason,
          },
        );
        return undefined;
      }
      return state;
    }
    const constraints = state.constraints.get(nextId) ?? [];
    const candidates = registry
      .versions(nextId)
      .filter((skill) =>
        constraints.every((constraint) =>
          satisfiesSemver(skill.manifest.version, constraint.range),
        ),
      )
      .filter((skill) => !candidateCompatibility(skill, request));
    if (candidates.length === 0) {
      mostSpecificError = classifyNoCandidates(registry, nextId, constraints, request);
      return undefined;
    }
    for (const candidate of candidates) {
      const selected = new Map(state.selected);
      selected.set(nextId, candidate);
      const nextConstraints = cloneConstraints(state.constraints);
      for (const dependency of [...candidate.manifest.requires].sort((a, b) =>
        a.id.localeCompare(b.id),
      )) {
        addConstraint(nextConstraints, dependency.id, {
          range: dependency.range,
          reason: dependency.reason,
          from: candidate.manifest.id,
        });
      }
      const solved = recurse({ selected, constraints: nextConstraints });
      if (solved) return solved;
    }
    return undefined;
  }

  const result = recurse({ selected: new Map(), constraints: initialConstraints });
  if (!result) {
    throw (
      mostSpecificError ??
      new ScientificSkillResolutionError("VERSION_CONFLICT", "Skill graph has no solution")
    );
  }
  return result;
}

function graphEdges(
  selected: ReadonlyMap<string, LoadedScientificSkill>,
): ResolvedSkillGraph["edges"] {
  const edges: ResolvedSkillGraph["edges"] = [];
  for (const skill of selected.values()) {
    for (const dependency of skill.manifest.requires) {
      if (selected.has(dependency.id)) {
        edges.push({ from: skill.manifest.id, to: dependency.id, kind: "hard" });
      }
    }
    for (const dependency of skill.manifest.recommends) {
      if (selected.has(dependency.id)) {
        edges.push({ from: skill.manifest.id, to: dependency.id, kind: "optional" });
      }
    }
  }
  return edges.sort((a, b) =>
    `${a.from}\0${a.to}\0${a.kind}`.localeCompare(`${b.from}\0${b.to}\0${b.kind}`),
  );
}

function assertAcyclic(edges: ResolvedSkillGraph["edges"]): void {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = adjacency.get(edge.from) ?? [];
    targets.push(edge.to);
    targets.sort();
    adjacency.set(edge.from, targets);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];
  function visit(id: string): void {
    if (visiting.has(id)) {
      const start = path.indexOf(id);
      const cycle = [...path.slice(start), id];
      throw new ScientificSkillResolutionError(
        "CIRCULAR_DEPENDENCY",
        `Circular scientific-skill dependency: ${cycle.join(" -> ")}`,
        { cycle },
      );
    }
    if (visited.has(id)) return;
    visiting.add(id);
    path.push(id);
    for (const target of adjacency.get(id) ?? []) visit(target);
    path.pop();
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of [...adjacency.keys()].sort()) visit(id);
}

function collectReasons(state: ResolutionState): Record<string, string[]> {
  return Object.fromEntries(
    [...state.constraints.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, constraints]) => [
        id,
        [...new Set(constraints.map((item) => item.reason))].sort(),
      ]),
  );
}

/** Resolve a minimum, deterministic, exact-version skill graph. Optional nodes are attempted atomically. */
export function resolveScientificSkillGraph(
  registry: ScientificSkillRegistry,
  request: ResolveScientificSkillsRequest,
): ResolvedScientificSkillGraph {
  const requested = normalizeRequested(request.requested);
  if (requested.length === 0) {
    throw new ScientificSkillResolutionError(
      "MISSING_DEPENDENCY",
      "At least one scientific skill must be requested",
    );
  }
  const explicitOptional = normalizeRequested(request.optional ?? []);
  let roots = [...requested, ...explicitOptional];
  let state = solveHardGraph(registry, roots, request);
  const skippedOptional: Array<{ id: string; reason: string }> = [];

  if (request.includeOptional) {
    const considered = new Set<string>();
    while (true) {
      const candidates: Array<{ from: string; dependency: SkillDependency }> = [];
      for (const skill of [...state.selected.values()].sort((a, b) =>
        a.manifest.id.localeCompare(b.manifest.id),
      )) {
        for (const dependency of skill.manifest.recommends) {
          const key = `${skill.manifest.id}\0${dependency.id}\0${dependency.range}`;
          if (!state.selected.has(dependency.id) && !considered.has(key)) {
            candidates.push({ from: skill.manifest.id, dependency });
          }
        }
      }
      candidates.sort((a, b) =>
        `${a.dependency.id}\0${a.from}`.localeCompare(`${b.dependency.id}\0${b.from}`),
      );
      const candidate = candidates[0];
      if (!candidate) break;
      considered.add(
        `${candidate.from}\0${candidate.dependency.id}\0${candidate.dependency.range}`,
      );
      try {
        const nextRoots = [
          ...roots,
          { id: candidate.dependency.id, range: candidate.dependency.range },
        ];
        const nextState = solveHardGraph(registry, nextRoots, request);
        roots = nextRoots;
        state = nextState;
      } catch (error) {
        skippedOptional.push({
          id: candidate.dependency.id,
          reason:
            error instanceof ScientificSkillResolutionError
              ? `${error.code}: ${error.message}`
              : String(error),
        });
      }
    }
  }

  const edges = graphEdges(state.selected);
  assertAcyclic(edges);
  const skills = [...state.selected.values()].sort((a, b) =>
    a.manifest.id.localeCompare(b.manifest.id),
  );
  const nodes: SkillVersionReference[] = skills.map((skill) => ({
    skillId: skill.manifest.id,
    version: skill.manifest.version,
    contentDigest: skill.contentDigest,
  }));
  const environmentDigest = request.environmentDigest
    ? DigestSchema.parse(request.environmentDigest)
    : digestCanonical({
        engine: request.engine ?? null,
        domains: [...(request.domains ?? [])].sort(),
        minimumKnowledgeMaturity: request.minimumKnowledgeMaturity ?? null,
        minimumDomainMaturity: request.minimumDomainMaturity ?? null,
        requiredCapability: request.requiredCapability ?? null,
        activeConditions: [...(request.activeConditions ?? [])].sort(),
        environment: request.environment ?? null,
      });
  const requestedSkillIds = requested.map((item) => item.id);
  const graph = withResolvedScientificSkillGraphDigest({
    id: "pending",
    schemaVersion: "eigengrid.resolved-skill-graph/v1",
    missionId: request.missionId ?? "unbound",
    requestedSkillIds,
    nodes,
    edges,
    selectedFragments: [],
    resolverVersion: request.resolverVersion ?? "1.0.0",
    environmentDigest,
    resolvedAt: request.resolvedAt ?? "1970-01-01T00:00:00.000Z",
  });
  return {
    graph,
    skills,
    reasons: collectReasons(state),
    skippedOptional: skippedOptional.sort((a, b) => a.id.localeCompare(b.id)),
  };
}
