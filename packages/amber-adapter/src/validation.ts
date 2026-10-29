import { z } from "zod";
import { assertAmberAtomMapView, type AmberAtomMapView } from "./atom-map";
import { Sha256Schema } from "./contracts";

export const AMBER_CHARGE_SCALE = 18.2223;
export const MINIMUM_PRMTOP_FLAGS = [
  "POINTERS",
  "ATOM_NAME",
  "CHARGE",
  "MASS",
  "ATOM_TYPE_INDEX",
  "NUMBER_EXCLUDED_ATOMS",
  "NONBONDED_PARM_INDEX",
  "RESIDUE_LABEL",
  "RESIDUE_POINTER",
  "BONDS_INC_HYDROGEN",
  "BONDS_WITHOUT_HYDROGEN",
  "AMBER_ATOM_TYPE",
] as const;
const PERIODIC_PRMTOP_FLAGS = ["BOX_DIMENSIONS", "SOLVENT_POINTERS", "ATOMS_PER_MOLECULE"] as const;

export interface AmberTopologySummary {
  topologyAtomCount: number | null;
  coordinateAtomCount: number | null;
  totalChargeElectrons: number | null;
  periodicTopology: boolean;
  hasVelocities: boolean;
  minimumSectionsPresent: boolean;
  topologyBox: [number, number, number, number] | null;
  coordinateBox: [number, number, number, number, number, number] | null;
  atomMapViewDigest: string;
  atomMapDigest: string;
}

export interface TopologyValidationIssue {
  code: string;
  message: string;
}

export interface ValidateAmberTopologyRequest {
  prmtop: string;
  rst7: string;
  atomMapView: AmberAtomMapView;
  expectedCanonicalAtomMapDigest: string;
  expectedAtomCount?: number;
  expectedTotalCharge?: number;
  chargeTolerance?: number;
  requirePeriodicBox?: boolean;
  requireVelocities?: boolean;
  /** Prepared and NVT coordinates match the topology box; NPT restart cells may change. */
  coordinateContext?: "prepared" | "npt_restart";
}

export interface AmberTopologyValidationResult {
  validationScope: "lightweight-structural-v2";
  amberConsumableCertified: false;
  valid: boolean;
  summary: AmberTopologySummary;
  issues: TopologyValidationIssue[];
}

function flagValues(prmtop: string, flagName: string): string[] | null {
  const lines = prmtop.split(/\r?\n/);
  const flagIndex = lines.findIndex((line) => line.trim() === `%FLAG ${flagName}`);
  if (flagIndex < 0) return null;
  const formatLine = lines[flagIndex + 1]?.trim() ?? "";
  const format = formatLine.match(/^%FORMAT\((\d+)([A-Za-z])(\d+)(?:\.\d+)?\)$/i);
  if (!format) return null;
  const width = Number(format[3]);
  if (!Number.isSafeInteger(width) || width < 1 || width > 128) return null;
  const values: string[] = [];
  for (let index = flagIndex + 2; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.startsWith("%FLAG")) break;
    if (line.startsWith("%")) continue;
    for (let offset = 0; offset < line.length; offset += width) {
      const value = line.slice(offset, offset + width).trim();
      if (value.length > 0) values.push(value);
    }
  }
  return values;
}

function finiteAmberNumber(value: string): number | null {
  if (!/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eEdD][-+]?\d+)?$/.test(value)) return null;
  const parsed = Number(value.replace(/[dD]/, "E"));
  return Number.isFinite(parsed) ? parsed : null;
}

function prmtopFlags(prmtop: string): Set<string> {
  return new Set([...prmtop.matchAll(/^%FLAG\s+([A-Z0-9_]+)\s*$/gm)].map((match) => match[1]!));
}

function residueIdentityByAtom(
  atomCount: number,
  labels: string[],
  pointers: number[],
): string[] | null {
  if (
    labels.length === 0 ||
    labels.length !== pointers.length ||
    pointers[0] !== 1 ||
    pointers.some(
      (pointer, index) =>
        !Number.isInteger(pointer) ||
        pointer < 1 ||
        pointer > atomCount ||
        (index > 0 && pointer <= pointers[index - 1]!),
    )
  ) {
    return null;
  }
  const residues = Array.from({ length: atomCount }, () => "");
  for (let index = 0; index < labels.length; index += 1) {
    const start = pointers[index]! - 1;
    const end = (pointers[index + 1] ?? atomCount + 1) - 1;
    for (let atom = start; atom < end; atom += 1) residues[atom] = labels[index]!;
  }
  return residues.every((residue) => residue.length > 0) ? residues : null;
}

function parsePrmtop(prmtop: string): {
  atomCount: number | null;
  totalCharge: number | null;
  periodic: boolean;
  box: [number, number, number, number] | null;
  flags: Set<string>;
  atomNames: string[];
  atomResidues: string[] | null;
  masses: Array<number | null> | null;
  atomTypeIndexes: Array<number | null> | null;
  bondSections: Array<Array<number | null> | null>;
} {
  const flags = prmtopFlags(prmtop);
  const pointers = flagValues(prmtop, "POINTERS")?.map(finiteAmberNumber) ?? [];
  const rawAtomCount = pointers[0] ?? null;
  const atomCount =
    rawAtomCount !== null &&
    Number.isSafeInteger(rawAtomCount) &&
    rawAtomCount > 0 &&
    rawAtomCount <= 10_000_000
      ? rawAtomCount
      : null;
  const periodic = (pointers[27] ?? 0) > 0;
  const charges = flagValues(prmtop, "CHARGE")?.map(finiteAmberNumber) ?? null;
  const totalCharge =
    charges === null ||
    atomCount === null ||
    charges.length !== atomCount ||
    charges.some((value) => value === null)
      ? null
      : (charges as number[]).reduce((sum, value) => sum + value, 0) / AMBER_CHARGE_SCALE;
  const boxValues = flagValues(prmtop, "BOX_DIMENSIONS")?.map(finiteAmberNumber) ?? null;
  const box =
    boxValues !== null &&
    boxValues.length >= 4 &&
    boxValues.slice(0, 4).every((value) => value !== null)
      ? (boxValues.slice(0, 4) as [number, number, number, number])
      : null;
  const atomNames = flagValues(prmtop, "ATOM_NAME") ?? [];
  const residueLabels = flagValues(prmtop, "RESIDUE_LABEL") ?? [];
  const residuePointers =
    flagValues(prmtop, "RESIDUE_POINTER")
      ?.map(finiteAmberNumber)
      .filter((v): v is number => v !== null) ?? [];
  return {
    atomCount,
    totalCharge,
    periodic,
    box,
    flags,
    atomNames,
    atomResidues:
      atomCount === null ||
      (flagValues(prmtop, "RESIDUE_POINTER") ?? []).some((v) => finiteAmberNumber(v) === null)
        ? null
        : residueIdentityByAtom(atomCount, residueLabels, residuePointers),
    masses: flagValues(prmtop, "MASS")?.map(finiteAmberNumber) ?? null,
    atomTypeIndexes: flagValues(prmtop, "ATOM_TYPE_INDEX")?.map(finiteAmberNumber) ?? null,
    bondSections: ["BONDS_INC_HYDROGEN", "BONDS_WITHOUT_HYDROGEN"].map(
      (flag) => flagValues(prmtop, flag)?.map(finiteAmberNumber) ?? null,
    ),
  };
}

function parseRst7(
  rst7: string,
  periodicExpected: boolean,
): {
  atomCount: number | null;
  box: [number, number, number, number, number, number] | null;
  numericCount: number;
  hasVelocities: boolean;
  validNumbers: boolean;
} {
  const lines = rst7.split(/\r?\n/);
  const atomToken = lines[1]?.trim().split(/\s+/)[0];
  const atomCount =
    atomToken === undefined || !/^\d+$/.test(atomToken) ? null : Number.parseInt(atomToken, 10);
  if (
    atomCount === null ||
    !Number.isSafeInteger(atomCount) ||
    atomCount <= 0 ||
    atomCount > 10_000_000
  ) {
    return {
      atomCount: null,
      box: null,
      numericCount: 0,
      hasVelocities: false,
      validNumbers: false,
    };
  }
  const numeric = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[EeDd][-+]?\d+)?/g;
  const body = lines.slice(2).join("\n");
  const rawValues = (body.match(numeric) ?? []).map(finiteAmberNumber);
  const header = lines[1]?.trim().split(/\s+/) ?? [];
  const validNumbers =
    body.replace(numeric, "").trim().length === 0 &&
    rawValues.every((v) => v !== null) &&
    header.length <= 2 &&
    (header.length === 1 ||
      (finiteAmberNumber(header[1]!) !== null && finiteAmberNumber(header[1]!)! >= 0));
  const values = rawValues.filter((v): v is number => v !== null);
  const coordinateOnly = atomCount * 3;
  const coordinatesAndVelocities = atomCount * 6;
  const hasBox =
    periodicExpected &&
    (values.length === coordinateOnly + 6 || values.length === coordinatesAndVelocities + 6);
  const box = hasBox
    ? (values.slice(-6) as [number, number, number, number, number, number])
    : null;
  const hasVelocities = values.length === coordinatesAndVelocities + (periodicExpected ? 6 : 0);
  return { atomCount, box, numericCount: values.length, hasVelocities, validNumbers };
}

export function validateAmberTopology(
  request: ValidateAmberTopologyRequest,
): AmberTopologyValidationResult {
  const issues: TopologyValidationIssue[] = [];
  if (
    typeof request.prmtop !== "string" ||
    typeof request.rst7 !== "string" ||
    request.prmtop.length > 128 * 1024 * 1024 ||
    request.rst7.length > 128 * 1024 * 1024
  ) {
    throw new TypeError("Expected bounded ASCII topology/restart; use the byte decoder for NetCDF");
  }
  const coordinateContext = z
    .enum(["prepared", "npt_restart"])
    .parse(request.coordinateContext ?? "prepared");
  const flags = [...request.prmtop.matchAll(/^%FLAG\s+([A-Z0-9_]+)\s*$/gm)].map((x) => x[1]);
  if (new Set(flags).size !== flags.length)
    issues.push({
      code: "duplicate_topology_section",
      message: "Duplicate prmtop flags are ambiguous",
    });
  const requirePeriodicBox = z.boolean().parse(request.requirePeriodicBox ?? false);
  const requireVelocities = z.boolean().parse(request.requireVelocities ?? false);
  const prmtop = parsePrmtop(request.prmtop);
  const periodicExpected = prmtop.periodic || requirePeriodicBox;
  const rst7 = parseRst7(request.rst7, periodicExpected);
  if (!rst7.validNumbers)
    issues.push({
      code: "invalid_restart_numbers",
      message: "Restart contains non-finite, malformed or non-ASCII numeric payload",
    });
  if (
    coordinateContext === "npt_restart" &&
    (!prmtop.periodic || !rst7.hasVelocities || rst7.box === null)
  ) {
    issues.push({
      code: "incomplete_npt_restart",
      message: "NPT continuation requires periodic coordinates, velocities and a cell",
    });
  }
  const atomMapView = assertAmberAtomMapView(
    request.atomMapView,
    Sha256Schema.parse(request.expectedCanonicalAtomMapDigest),
  );
  const atomMap = atomMapView.entries;
  const mapDigest = atomMapView.canonicalAtomMap.mapDigest;
  const tolerance = z
    .number()
    .finite()
    .positive()
    .parse(request.chargeTolerance ?? 1e-4);
  const expectedTotalCharge =
    request.expectedTotalCharge === undefined
      ? undefined
      : z.number().finite().parse(request.expectedTotalCharge);
  const requiredFlags = [
    ...MINIMUM_PRMTOP_FLAGS,
    ...(prmtop.periodic || requirePeriodicBox ? PERIODIC_PRMTOP_FLAGS : []),
  ];
  for (const flag of requiredFlags) {
    if (!prmtop.flags.has(flag)) {
      issues.push({
        code: "missing_prmtop_section",
        message: `Required prmtop section ${flag} is absent`,
      });
    }
  }

  if (prmtop.atomCount === null) {
    issues.push({
      code: "missing_topology_atom_count",
      message: "prmtop POINTERS/NATOM is absent",
    });
  }
  if (rst7.atomCount === null) {
    issues.push({ code: "missing_coordinate_atom_count", message: "rst7 atom count is absent" });
  }
  if (prmtop.atomCount !== null && rst7.atomCount !== null && prmtop.atomCount !== rst7.atomCount) {
    issues.push({
      code: "topology_coordinate_atom_mismatch",
      message: `prmtop has ${prmtop.atomCount} atoms but rst7 has ${rst7.atomCount}`,
    });
  }
  if (request.expectedAtomCount !== undefined) {
    const expected = z.number().int().positive().parse(request.expectedAtomCount);
    if (prmtop.atomCount !== expected || rst7.atomCount !== expected) {
      issues.push({
        code: "unexpected_atom_count",
        message: `Expected ${expected} atoms in both topology and coordinates`,
      });
    }
  }
  if (
    prmtop.atomCount !== null &&
    (prmtop.atomNames.length !== prmtop.atomCount ||
      prmtop.masses === null ||
      prmtop.masses.length !== prmtop.atomCount ||
      prmtop.masses.some((mass) => mass === null || mass <= 0) ||
      prmtop.atomTypeIndexes === null ||
      prmtop.atomTypeIndexes.length !== prmtop.atomCount ||
      prmtop.atomTypeIndexes.some(
        (atomType) => atomType === null || !Number.isInteger(atomType) || atomType <= 0,
      ) ||
      prmtop.atomResidues === null)
  ) {
    issues.push({
      code: "invalid_topology_identity_sections",
      message: "Atom names, masses, atom types, and residue identity must cover NATOM",
    });
  }
  if (prmtop.atomCount !== null) {
    for (const bonds of prmtop.bondSections) {
      if (bonds === null || bonds.length % 3 !== 0) {
        issues.push({
          code: "invalid_bond_section",
          message: "Bond sections must contain triples",
        });
        continue;
      }
      for (let index = 0; index < bonds.length; index += 3) {
        const first = bonds[index];
        const second = bonds[index + 1];
        const parameter = bonds[index + 2];
        if (
          first === null ||
          second === null ||
          parameter === null ||
          !Number.isInteger(first) ||
          !Number.isInteger(second) ||
          !Number.isInteger(parameter) ||
          first % 3 !== 0 ||
          second % 3 !== 0 ||
          first < 0 ||
          second < 0 ||
          first / 3 >= prmtop.atomCount ||
          second / 3 >= prmtop.atomCount ||
          parameter <= 0
        ) {
          issues.push({
            code: "invalid_bond_section",
            message: "Bond entries must reference valid AMBER coordinate indexes and parameters",
          });
          break;
        }
      }
    }
  }

  const expectedCoordinateValues = rst7.atomCount === null ? null : rst7.atomCount * 3;
  const allowedCoordinateValues =
    expectedCoordinateValues === null
      ? []
      : periodicExpected
        ? [expectedCoordinateValues + 6, expectedCoordinateValues * 2 + 6]
        : [expectedCoordinateValues, expectedCoordinateValues * 2];
  if (expectedCoordinateValues !== null && !allowedCoordinateValues.includes(rst7.numericCount)) {
    issues.push({
      code: "invalid_coordinate_payload",
      message: "rst7 coordinate/velocity/box value count is inconsistent with NATOM",
    });
  }

  if (prmtop.totalCharge === null || !Number.isFinite(prmtop.totalCharge)) {
    issues.push({ code: "missing_charge", message: "prmtop CHARGE values are absent or invalid" });
  } else {
    if (Math.abs(prmtop.totalCharge - Math.round(prmtop.totalCharge)) > tolerance) {
      issues.push({
        code: "non_integral_charge",
        message: `Whole-system charge ${prmtop.totalCharge} is not integral`,
      });
    }
    if (
      expectedTotalCharge !== undefined &&
      Math.abs(prmtop.totalCharge - expectedTotalCharge) > tolerance
    ) {
      issues.push({
        code: "charge_mismatch",
        message: `Observed charge ${prmtop.totalCharge} differs from expected ${expectedTotalCharge}`,
      });
    }
  }

  if (requirePeriodicBox && (!prmtop.periodic || rst7.box === null)) {
    issues.push({
      code: "missing_periodic_box",
      message: "Periodic validation requires IFBOX and six rst7 box values",
    });
  }
  if (prmtop.periodic && prmtop.box === null) {
    issues.push({
      code: "missing_topology_box_dimensions",
      message: "A periodic prmtop must contain BOX_DIMENSIONS",
    });
  }
  if (coordinateContext === "prepared" && prmtop.box !== null && rst7.box !== null) {
    const topologyLengths = prmtop.box.slice(1);
    const coordinateLengths = rst7.box.slice(0, 3);
    const betaMismatch = Math.abs(prmtop.box[0] - rst7.box[4]) > 1e-4;
    if (
      betaMismatch ||
      topologyLengths.some((length, index) => Math.abs(length - coordinateLengths[index]!) > 1e-4)
    ) {
      issues.push({
        code: "box_mismatch",
        message: "prmtop and rst7 box dimensions are inconsistent",
      });
    }
  }
  if (rst7.box !== null && rst7.box.slice(0, 3).some((length) => length <= 0)) {
    issues.push({ code: "invalid_box", message: "Box lengths must be positive" });
  }
  if (rst7.box !== null && rst7.box.slice(3).some((angle) => angle <= 0 || angle >= 180)) {
    issues.push({ code: "invalid_box", message: "Box angles must be in the interval (0, 180)" });
  }
  if (requireVelocities && !rst7.hasVelocities) {
    issues.push({
      code: "missing_restart_velocities",
      message: "This restart consumer requires a complete velocity block",
    });
  }

  const topologyAtomCount = prmtop.atomCount;
  const indexes = atomMap.map((entry) => entry.topologyIndex);
  if (new Set(indexes).size !== indexes.length) {
    issues.push({
      code: "duplicate_atom_map_index",
      message: "Atom-map topology indexes must be unique",
    });
  }
  const identities = atomMap.map((entry) => `${entry.componentId}\0${entry.componentAtomIndex}`);
  if (new Set(identities).size !== identities.length) {
    issues.push({
      code: "duplicate_component_atom",
      message: "Component atom identities must be unique",
    });
  }
  if (indexes.some((index, position) => index !== position + 1)) {
    issues.push({
      code: "atom_map_order",
      message: "Atom-map entries must be ordered by their one-based topology index",
    });
  }
  if (
    topologyAtomCount !== null &&
    (atomMap.length !== topologyAtomCount ||
      new Set(indexes).size !== topologyAtomCount ||
      indexes.some((index) => index < 1 || index > topologyAtomCount))
  ) {
    issues.push({
      code: "atom_map_coverage",
      message: "Atom map must cover every topology index exactly once",
    });
  }
  if (
    topologyAtomCount !== null &&
    prmtop.atomNames.length === topologyAtomCount &&
    prmtop.atomResidues !== null &&
    atomMap.length === topologyAtomCount
  ) {
    for (let index = 0; index < topologyAtomCount; index += 1) {
      const entry = atomMap[index]!;
      if (
        entry.atomName !== prmtop.atomNames[index] ||
        entry.residueName !== prmtop.atomResidues[index]
      ) {
        issues.push({
          code: "atom_map_identity_mismatch",
          message: `Atom-map identity at topology index ${index + 1} does not match prmtop`,
        });
      }
    }
  }
  return {
    validationScope: "lightweight-structural-v2",
    amberConsumableCertified: false,
    valid: issues.length === 0,
    summary: {
      topologyAtomCount: prmtop.atomCount,
      coordinateAtomCount: rst7.atomCount,
      totalChargeElectrons: prmtop.totalCharge,
      periodicTopology: prmtop.periodic,
      hasVelocities: rst7.hasVelocities,
      minimumSectionsPresent: requiredFlags.every((flag) => prmtop.flags.has(flag)),
      topologyBox: prmtop.box,
      coordinateBox: rst7.box,
      atomMapViewDigest: atomMapView.viewDigest,
      atomMapDigest: mapDigest,
    },
    issues,
  };
}
