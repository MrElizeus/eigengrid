import { z } from "zod";
import {
  DigestSchema,
  digestCanonical,
  assertMdStageSpecDigest,
} from "@eigengrid/scientific-schema";
import { readAmberBondGraph } from "./amber-topology";
import {
  checkCell,
  checkCoordinates,
  point,
  delta,
  norm,
  distance,
  PeriodicNeighbors,
  type OrthorhombicCell,
} from "./periodic-geometry";
import { AmberTelemetryParseRequestSchema, parseAmberMdTelemetry } from "./telemetry";

const index = z.number().int().positive().max(1_000_000);
const range = z
  .tuple([z.number().finite().positive(), z.number().finite().positive()])
  .refine((v) => v[0] <= v[1]);
export const GeometryQcPolicySchema = z
  .object({
    schemaVersion: z.literal("eigengrid.amber-geometry-policy/v1"),
    topologyDigest: DigestSchema,
    atomMapDigest: DigestSchema,
    covalentLengthRangeAngstrom: range,
    minimumNonbondedHeavyDistanceAngstrom: z.number().finite().positive().max(3),
    requiredBonds: z
      .array(
        z
          .object({
            atoms: z.tuple([index, index]),
            kind: z.enum(["covalent", "disulfide"]),
            lengthRangeAngstrom: range,
          })
          .strict(),
      )
      .max(10_000),
    membrane: z
      .object({
        lipidComponentIds: z.array(z.string().min(1)).min(1).max(32),
        centerAtom: index,
        upperHeadgroupAtoms: z.array(index).min(1).max(10_000),
        lowerHeadgroupAtoms: z.array(index).min(1).max(10_000),
        headgroupSeparationRangeAngstrom: range,
        orderCHBonds: z.array(z.tuple([index, index])).max(100_000),
      })
      .strict()
      .nullable(),
    policyDigest: DigestSchema,
  })
  .strict();
export type GeometryQcPolicy = z.infer<typeof GeometryQcPolicySchema>;
export function computeGeometryQcPolicyDigest(
  value: Omit<GeometryQcPolicy, "policyDigest"> | GeometryQcPolicy,
) {
  const { policyDigest: _digest, ...p } = value as GeometryQcPolicy;
  return digestCanonical(p);
}
function assertBoundedMdout(text: string): void {
  if (typeof text !== "string" || text.length > 128 * 1024 * 1024)
    throw new Error("MDOUT text exceeds the bounded inspection profile");
}
function median(values: number[]): number {
  values.sort((a, b) => a - b);
  const i = Math.floor(values.length / 2);
  return values.length % 2 ? values[i]! : (values[i - 1]! + values[i]!) / 2;
}

/** Evaluate actual coordinates/connectivity. This is endpoint QC, NOT trajectory convergence or permeation. */
export function assessAmberGeometry(
  policyValue: unknown,
  topologyText: string,
  mapValue: unknown,
  coordinates: number[],
  cellValue: OrthorhombicCell,
) {
  const policy = GeometryQcPolicySchema.parse(policyValue),
    graph = readAmberBondGraph(topologyText, mapValue),
    map = graph.atomMap;
  if (
    policy.policyDigest !== computeGeometryQcPolicyDigest(policy) ||
    policy.topologyDigest !== graph.topologyDigest ||
    policy.atomMapDigest !== map.mapDigest
  )
    throw new Error("Physical QC policy/material mismatch");
  const cell = checkCell(cellValue, policy.minimumNonbondedHeavyDistanceAngstrom);
  checkCoordinates(coordinates, map.atomCount);
  const issues: Array<{ code: string; atoms: number[]; value: number | null }> = [];
  let issueCount = 0;
  const record = (code: string, atoms: number[], value: number | null) => {
    issueCount++;
    if (issues.length < 64) issues.push({ code, atoms, value });
  };
  const separation = (a: number, b: number) =>
    distance(point(coordinates, a), point(coordinates, b), cell);
  for (const [a, b] of graph.bonds) {
    const d = separation(a, b);
    if (d < policy.covalentLengthRangeAngstrom[0] || d > policy.covalentLengthRangeAngstrom[1])
      record("covalent_length_out_of_range", [a, b], d);
  }
  const byIndex = new Map(map.entries.map((a) => [a.systemAtomIndex, a]));
  for (const bond of policy.requiredBonds) {
    const [a, b] = bond.atoms;
    if (!byIndex.has(a) || !byIndex.has(b) || a === b)
      throw new Error("Required bond selection invalid");
    if (bond.kind === "disulfide" && [a, b].some((i) => byIndex.get(i)!.element !== "S"))
      throw new Error("Disulfide policy must name sulfur atoms");
    if (!graph.neighbors.get(a)?.has(b)) record("required_topology_bond_missing", [a, b], null);
    const d = separation(a, b);
    if (d < bond.lengthRangeAngstrom[0] || d > bond.lengthRangeAngstrom[1])
      record("required_bond_geometry", [a, b], d);
  }
  const heavy = map.entries.filter((a) => a.element !== "H").map((a) => a.systemAtomIndex);
  const neighbors = new PeriodicNeighbors(
    coordinates,
    heavy,
    cell,
    policy.minimumNonbondedHeavyDistanceAngstrom,
  );
  let clashes = 0;
  for (const a of heavy)
    for (const b of neighbors.near(point(coordinates, a))) {
      if (b <= a || graph.neighbors.get(a)?.has(b)) continue;
      if ([...(graph.neighbors.get(a) ?? [])].some((n) => graph.neighbors.get(n)?.has(b))) continue; // exclude 1-3 covalent pairs
      clashes++;
      record("nonbonded_heavy_atom_overlap", [a, b], separation(a, b));
    }
  let membrane: null | {
    headgroupSeparationAngstrom: number;
    meanOrderP2: number | null;
    boxAreaAngstrom2: number;
  } = null;
  if (policy.membrane) {
    const m = policy.membrane,
      heads = [...m.upperHeadgroupAtoms, ...m.lowerHeadgroupAtoms];
    if (
      !byIndex.has(m.centerAtom) ||
      new Set(heads).size !== heads.length ||
      heads.some(
        (i) =>
          !byIndex.has(i) ||
          !m.lipidComponentIds.includes(byIndex.get(i)!.componentId) ||
          !["P", "O"].includes(byIndex.get(i)!.element),
      )
    )
      throw new Error("Membrane headgroup/center selection is missing or ambiguous");
    const center = point(coordinates, m.centerAtom);
    const upper = m.upperHeadgroupAtoms.map((i) => delta(point(coordinates, i), center, cell)[2]);
    const lower = m.lowerHeadgroupAtoms.map((i) => delta(point(coordinates, i), center, cell)[2]);
    if (upper.some((z) => z <= 0) || lower.some((z) => z >= 0))
      record("leaflet_assignment_crosses_midplane", [], null);
    const thickness = median(upper) - median(lower);
    if (
      thickness < m.headgroupSeparationRangeAngstrom[0] ||
      thickness > m.headgroupSeparationRangeAngstrom[1]
    )
      record("headgroup_separation_out_of_range", [], thickness);
    const order = m.orderCHBonds.map(([c, h]) => {
      if (
        !m.lipidComponentIds.includes(byIndex.get(c)?.componentId ?? "") ||
        byIndex.get(h)?.componentId !== byIndex.get(c)?.componentId ||
        byIndex.get(c)?.element !== "C" ||
        byIndex.get(h)?.element !== "H" ||
        !graph.neighbors.get(c)?.has(h)
      )
        throw new Error("Lipid order requires exact bonded C-H atom selections");
      const v = delta(point(coordinates, h), point(coordinates, c), cell),
        length = norm(v);
      if (length < 1e-12) throw new Error("Degenerate C-H order geometry");
      return 0.5 * (3 * (v[2] / length) ** 2 - 1);
    });
    membrane = {
      headgroupSeparationAngstrom: thickness,
      meanOrderP2: order.length ? order.reduce((a, b) => a + b, 0) / order.length : null,
      boxAreaAngstrom2: cell.lengthsAngstrom[0] * cell.lengthsAngstrom[1],
    };
  }
  const result = {
    schemaVersion: "eigengrid.amber-geometry-qc/v1" as const,
    policyDigest: policy.policyDigest,
    topologyDigest: graph.topologyDigest,
    atomMapDigest: map.mapDigest,
    coordinateObservationDigest: digestCanonical({ coordinates, cell }),
    status: issueCount ? ("failed" as const) : ("passed" as const),
    scientificVerdict: "not_evaluated" as const,
    scope: "endpoint-connectivity-clashes-and-declared-membrane-markers" as const,
    issueCount,
    issues,
    clashes,
    membrane,
  };
  return { ...result, resultDigest: digestCanonical(result) };
}

export const ThermodynamicWindowPolicySchema = z
  .object({
    schemaVersion: z.literal("eigengrid.amber-thermodynamic-window/v1"),
    stageResultDigest: DigestSchema,
    startTimePs: z.number().finite().nonnegative(),
    endTimePs: z.number().finite().positive(),
    expectedSamples: z.number().int().min(2).max(1_000_000),
    cadencePs: z.number().finite().positive(),
    meanTemperatureRangeKelvin: range,
    maximumRelativeVolumeDrift: z.number().finite().nonnegative().max(1),
    policyDigest: DigestSchema,
  })
  .strict()
  .refine(
    (p) =>
      p.endTimePs > p.startTimePs &&
      Math.abs((p.expectedSamples - 1) * p.cadencePs - (p.endTimePs - p.startTimePs)) < 1e-8,
    "Declared thermodynamic window count and cadence must cover its endpoints exactly",
  );
export type ThermodynamicWindowPolicy = z.infer<typeof ThermodynamicWindowPolicySchema>;
export function computeThermodynamicWindowPolicyDigest(
  value: Omit<ThermodynamicWindowPolicy, "policyDigest"> | ThermodynamicWindowPolicy,
) {
  const { policyDigest: _digest, ...p } = value as ThermodynamicWindowPolicy;
  return digestCanonical(p);
}
/** Derives a window from exact mdout BYTES. Instantaneous pressure is not used as an equilibrium gate. */
export function assessAmberThermodynamicWindow(
  text: string,
  parseRequest: unknown,
  policyValue: unknown,
) {
  assertBoundedMdout(text);
  const policy = ThermodynamicWindowPolicySchema.parse(policyValue);
  if (policy.policyDigest !== computeThermodynamicWindowPolicyDigest(policy))
    throw new Error("Thermodynamic policy digest mismatch");
  const parsed = parseAmberMdTelemetry(text, parseRequest);
  if (parsed.stageResult.resultDigest !== policy.stageResultDigest)
    throw new Error("Wrong thermodynamic stage result");
  const samples = parsed.samples.filter(
    (s) =>
      s.timePs !== undefined &&
      s.timePs >= policy.startTimePs - 1e-9 &&
      s.timePs <= policy.endTimePs + 1e-9,
  );
  const usable =
    parsed.status === "completed" &&
    samples.length === policy.expectedSamples &&
    samples.every(
      (s, i) =>
        s.timePs !== undefined &&
        Math.abs(s.timePs - (policy.startTimePs + i * policy.cadencePs)) < 1e-8 &&
        s.values.temperature !== undefined &&
        s.values.volume !== undefined &&
        s.values.volume > 0,
    );
  let meanTemperatureKelvin: number | null = null,
    relativeVolumeDrift: number | null = null;
  if (usable) {
    meanTemperatureKelvin =
      samples.reduce((sum, s) => sum + s.values.temperature!, 0) / samples.length;
    const n = Math.floor(samples.length / 2),
      mean = (values: number[]) => values.reduce((s, v) => s + v, 0) / values.length;
    const first = mean(samples.slice(0, n).map((s) => s.values.volume!)),
      last = mean(samples.slice(-n).map((s) => s.values.volume!));
    relativeVolumeDrift = Math.abs(last - first) / first;
  }
  const passed =
    usable &&
    meanTemperatureKelvin !== null &&
    Number.isFinite(meanTemperatureKelvin) &&
    meanTemperatureKelvin >= policy.meanTemperatureRangeKelvin[0] &&
    meanTemperatureKelvin <= policy.meanTemperatureRangeKelvin[1] &&
    relativeVolumeDrift !== null &&
    Number.isFinite(relativeVolumeDrift) &&
    relativeVolumeDrift <= policy.maximumRelativeVolumeDrift;
  const result = {
    schemaVersion: "eigengrid.amber-thermodynamic-qc/v1" as const,
    policyDigest: policy.policyDigest,
    parseDigest: parsed.parseDigest,
    stageResultDigest: policy.stageResultDigest,
    status: !usable
      ? ("indeterminate" as const)
      : passed
        ? ("passed" as const)
        : ("failed" as const),
    scientificVerdict: "not_evaluated" as const,
    observedSamples: samples.length,
    meanTemperatureKelvin,
    relativeVolumeDrift,
    rationale: !usable
      ? "Incomplete, failed or irregular telemetry; missing values are not zero"
      : "Predeclared mean temperature and split-window volume drift only; not receptor convergence",
  };
  return { ...result, resultDigest: digestCanonical(result) };
}

export const NveDriftPolicySchema = z
  .object({
    schemaVersion: z.literal("eigengrid.amber-nve-drift-policy/v1"),
    stageResultDigest: DigestSchema,
    atomCount: z.number().int().positive().max(1_000_000),
    startTimePs: z.number().finite().nonnegative(),
    endTimePs: z.number().finite().positive(),
    expectedSamples: z.number().int().min(3).max(1_000_000),
    cadencePs: z.number().finite().positive(),
    maximumAbsoluteSlopeKcalMolPsPerAtom: z.number().finite().positive(),
    policyDigest: DigestSchema,
  })
  .strict()
  .refine(
    (p) =>
      p.endTimePs > p.startTimePs &&
      Math.abs((p.expectedSamples - 1) * p.cadencePs - (p.endTimePs - p.startTimePs)) < 1e-8,
  );
export type NveDriftPolicy = z.infer<typeof NveDriftPolicySchema>;
export function computeNveDriftPolicyDigest(
  value: Omit<NveDriftPolicy, "policyDigest"> | NveDriftPolicy,
) {
  const { policyDigest: _digest, ...p } = value as NveDriftPolicy;
  return digestCanonical(p);
}
/** Least-squares total-energy drift for an exact NVE stage; no cross-build qualification inference. */
export function assessAmberNveDrift(
  text: string,
  parseRequest: unknown,
  stageValue: unknown,
  policyValue: unknown,
  material: { prmtop: string; atomMap: unknown },
) {
  assertBoundedMdout(text);
  const policy = NveDriftPolicySchema.parse(policyValue),
    stage = assertMdStageSpecDigest(stageValue);
  const request = AmberTelemetryParseRequestSchema.parse(parseRequest),
    result = request.stageResult;
  const graph = readAmberBondGraph(material.prmtop, material.atomMap);
  if (
    graph.atomCount !== policy.atomCount ||
    graph.topologyDigest !== stage.system.topologyDigest ||
    graph.atomMap.mapDigest !== stage.system.atomMapDigest
  )
    throw new Error("NVE atom normalization must match the exact topology and AtomMap");
  const parsed = parseAmberMdTelemetry(text, request);
  if (
    policy.policyDigest !== computeNveDriftPolicyDigest(policy) ||
    policy.stageResultDigest !== parsed.stageResult.resultDigest ||
    stage.stageDigest !== result.stageDigest ||
    stage.id !== result.stageId ||
    stage.revision !== result.stageRevision ||
    stage.kind !== result.stageKind ||
    stage.ensemble !== "nve" ||
    stage.thermostat.kind !== "none" ||
    stage.barostat.kind !== "none"
  )
    throw new Error("NVE drift must bind the exact unthermostatted fixed-cell stage and result");
  const samples = parsed.samples.filter(
    (s) =>
      s.timePs !== undefined &&
      s.timePs >= policy.startTimePs - 1e-9 &&
      s.timePs <= policy.endTimePs + 1e-9,
  );
  const usable =
    parsed.status === "completed" &&
    result.errors.length === 0 &&
    samples.length === policy.expectedSamples &&
    samples.every(
      (s, i) =>
        s.timePs !== undefined &&
        Math.abs(s.timePs - (policy.startTimePs + i * policy.cadencePs)) < 1e-8 &&
        s.values.total_energy !== undefined,
    );
  let slopeKcalMolPsPerAtom: number | null = null;
  if (usable) {
    const midpoint = ((policy.expectedSamples - 1) * policy.cadencePs) / 2;
    const referenceEnergy = samples[0]!.values.total_energy!;
    let cross = 0,
      variance = 0;
    for (let i = 0; i < samples.length; i++) {
      const t = i * policy.cadencePs - midpoint;
      cross += t * (samples[i]!.values.total_energy! - referenceEnergy);
      variance += t * t;
    }
    const value = cross / variance / policy.atomCount;
    if (Number.isFinite(value)) slopeKcalMolPsPerAtom = value;
  }
  const assessment = {
    schemaVersion: "eigengrid.amber-nve-drift-qc/v1" as const,
    policyDigest: policy.policyDigest,
    stageDigest: stage.stageDigest,
    topologyDigest: graph.topologyDigest,
    atomMapDigest: graph.atomMap.mapDigest,
    parseDigest: parsed.parseDigest,
    status:
      slopeKcalMolPsPerAtom === null
        ? ("indeterminate" as const)
        : Math.abs(slopeKcalMolPsPerAtom) <= policy.maximumAbsoluteSlopeKcalMolPsPerAtom
          ? ("passed" as const)
          : ("failed" as const),
    slopeKcalMolPsPerAtom,
    observedSamples: samples.length,
    scientificVerdict: "not_evaluated" as const,
    limitation:
      "Atom normalization is topology-bound; a short NVE drift check is not whole-system convergence or GPU qualification",
  };
  return { ...assessment, resultDigest: digestCanonical(assessment) };
}
