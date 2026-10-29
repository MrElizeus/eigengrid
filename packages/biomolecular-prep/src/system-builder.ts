import {
  AtomMapSchema,
  assertAtomMapDigest,
  type AtomMap,
  type AtomMapEntry,
} from "@eigengrid/scientific-schema";

export type BiomolecularComponentKind =
  | "protein"
  | "ligand"
  | "lipid"
  | "water"
  | "ion"
  | "cofactor";

export type Vector3 = readonly [number, number, number];

export interface SystemComponent {
  readonly componentId: string;
  readonly kind: BiomolecularComponentKind;
  readonly moleculeCount: number;
  readonly declaredNetCharge?: number;
}

export interface SystemAtom {
  readonly atomId: string;
  readonly componentId: string;
  readonly componentAtomIndex: number;
  readonly chainId?: string;
  readonly residueIndex: number;
  readonly residueName: string;
  readonly atomName: string;
  readonly residueId: string;
  readonly element: string;
  readonly charge: number;
  readonly positionAngstrom: Vector3;
}

/** @deprecated Use the canonical scientific-schema AtomMapEntry identity. */
export type SystemAtomMapEntry = AtomMapEntry;

export interface PeriodicBox {
  readonly originAngstrom?: Vector3;
  readonly vectorsAngstrom: readonly [Vector3, Vector3, Vector3];
}

export interface CompositionExpectation {
  readonly kind: BiomolecularComponentKind;
  readonly moleculeCount: number;
}

export interface SystemAssemblyInput {
  readonly systemId: string;
  readonly revision: number;
  readonly components: readonly SystemComponent[];
  readonly atoms: readonly SystemAtom[];
  readonly atomMap: AtomMap;
  readonly topologyDigest: string;
  readonly coordinateDigest: string;
  readonly box: PeriodicBox;
  readonly expectedTotalCharge: number;
  readonly expectedComposition: readonly CompositionExpectation[];
}

export type SystemValidationIssueCode =
  | "invalid_identifier"
  | "invalid_revision"
  | "invalid_component"
  | "duplicate_component"
  | "invalid_atom"
  | "duplicate_atom"
  | "unknown_component"
  | "empty_component"
  | "invalid_charge"
  | "component_charge_mismatch"
  | "total_charge_mismatch"
  | "non_integral_expected_charge"
  | "invalid_box"
  | "atom_outside_box"
  | "atom_overlap"
  | "overlap_pair_limit_exceeded"
  | "composition_mismatch"
  | "duplicate_composition_kind"
  | "atom_map_length_mismatch"
  | "atom_map_schema_invalid"
  | "atom_map_digest_mismatch"
  | "atom_map_system_mismatch"
  | "atom_map_index_invalid"
  | "atom_map_index_duplicate"
  | "atom_map_index_not_contiguous"
  | "atom_map_order_mismatch"
  | "atom_map_atom_identity_mismatch"
  | "atom_map_component_mismatch"
  | "atom_map_element_mismatch";

export interface SystemValidationIssue {
  readonly code: SystemValidationIssueCode;
  readonly path: string;
  readonly message: string;
}

export interface AtomOverlap {
  readonly leftAtomId: string;
  readonly rightAtomId: string;
  readonly distanceAngstrom: number;
}

export interface SystemValidationOptions {
  readonly chargeTolerance?: number;
  readonly overlapThresholdAngstrom?: number;
  readonly coordinateTolerance?: number;
  readonly maximumPairChecks?: number;
}

export interface SystemBuildValidation {
  readonly valid: boolean;
  readonly errors: readonly SystemValidationIssue[];
  readonly warnings: readonly SystemValidationIssue[];
  readonly metrics: {
    readonly atomCount: number;
    readonly componentCount: number;
    readonly totalCharge: number;
    readonly boxVolumeAngstrom3?: number;
    readonly minimumInteratomicDistanceAngstrom?: number;
    readonly pairChecks: number;
  };
  readonly overlaps: readonly AtomOverlap[];
}

export interface ValidatedSystemAssembly {
  readonly input: SystemAssemblyInput;
  readonly validation: SystemBuildValidation & { readonly valid: true };
}

export interface BiomolecularSystemBuilder {
  validate(input: SystemAssemblyInput, options?: SystemValidationOptions): SystemBuildValidation;
  build(input: SystemAssemblyInput, options?: SystemValidationOptions): ValidatedSystemAssembly;
}

export class InvalidSystemAssemblyError extends Error {
  constructor(readonly validation: SystemBuildValidation) {
    super(
      `Biomolecular system assembly failed with ${validation.errors.length} validation error(s)`,
    );
    this.name = "InvalidSystemAssemblyError";
  }
}

function finiteVector(value: Vector3): boolean {
  return value.length === 3 && value.every(Number.isFinite);
}

function subtract(left: Vector3, right: Vector3): Vector3 {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function addScaled(left: Vector3, right: Vector3, scale: number): Vector3 {
  return [left[0] + right[0] * scale, left[1] + right[1] * scale, left[2] + right[2] * scale];
}

function dot(left: Vector3, right: Vector3): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function cross(left: Vector3, right: Vector3): Vector3 {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function norm(value: Vector3): number {
  return Math.sqrt(dot(value, value));
}

function determinant(vectors: PeriodicBox["vectorsAngstrom"]): number {
  return dot(vectors[0], cross(vectors[1], vectors[2]));
}

function fractionalCoordinates(
  position: Vector3,
  vectors: PeriodicBox["vectorsAngstrom"],
  determinantValue: number,
): Vector3 {
  return [
    dot(position, cross(vectors[1], vectors[2])) / determinantValue,
    dot(position, cross(vectors[2], vectors[0])) / determinantValue,
    dot(position, cross(vectors[0], vectors[1])) / determinantValue,
  ];
}

function cartesianCoordinates(
  fractional: Vector3,
  vectors: PeriodicBox["vectorsAngstrom"],
): Vector3 {
  let result: Vector3 = [0, 0, 0];
  result = addScaled(result, vectors[0], fractional[0]);
  result = addScaled(result, vectors[1], fractional[1]);
  return addScaled(result, vectors[2], fractional[2]);
}

function periodicDistance(
  left: Vector3,
  right: Vector3,
  vectors: PeriodicBox["vectorsAngstrom"],
  determinantValue: number,
): number {
  const deltaFractional = fractionalCoordinates(subtract(left, right), vectors, determinantValue);
  const minimumImage: Vector3 = [
    deltaFractional[0] - Math.round(deltaFractional[0]),
    deltaFractional[1] - Math.round(deltaFractional[1]),
    deltaFractional[2] - Math.round(deltaFractional[2]),
  ];
  return norm(cartesianCoordinates(minimumImage, vectors));
}

function issue(
  code: SystemValidationIssueCode,
  path: string,
  message: string,
): SystemValidationIssue {
  return { code, path, message };
}

function rounded(value: number): number {
  return Number(value.toFixed(12));
}

export class DeterministicSystemBuilder implements BiomolecularSystemBuilder {
  validate(
    input: SystemAssemblyInput,
    options: SystemValidationOptions = {},
  ): SystemBuildValidation {
    const errors: SystemValidationIssue[] = [];
    const warnings: SystemValidationIssue[] = [];
    const overlaps: AtomOverlap[] = [];
    const chargeTolerance = options.chargeTolerance ?? 1e-4;
    const overlapThreshold = options.overlapThresholdAngstrom ?? 0.6;
    const coordinateTolerance = options.coordinateTolerance ?? 1e-8;
    const maximumPairChecks = options.maximumPairChecks ?? 5_000_000;

    if (!Number.isFinite(chargeTolerance) || chargeTolerance < 0) {
      errors.push(
        issue("invalid_charge", "options.chargeTolerance", "chargeTolerance must be non-negative"),
      );
    }
    if (!Number.isFinite(overlapThreshold) || overlapThreshold <= 0) {
      errors.push(
        issue(
          "invalid_atom",
          "options.overlapThresholdAngstrom",
          "overlap threshold must be positive",
        ),
      );
    }
    if (!Number.isFinite(coordinateTolerance) || coordinateTolerance < 0) {
      errors.push(
        issue(
          "invalid_box",
          "options.coordinateTolerance",
          "coordinate tolerance must be non-negative",
        ),
      );
    }

    if (input.systemId.trim() === "") {
      errors.push(issue("invalid_identifier", "systemId", "systemId must not be empty"));
    }
    if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
      errors.push(issue("invalid_revision", "revision", "revision must be a positive integer"));
    }
    if (!Number.isFinite(input.expectedTotalCharge)) {
      errors.push(
        issue("invalid_charge", "expectedTotalCharge", "expected total charge must be finite"),
      );
    } else if (
      Math.abs(input.expectedTotalCharge - Math.round(input.expectedTotalCharge)) > chargeTolerance
    ) {
      errors.push(
        issue(
          "non_integral_expected_charge",
          "expectedTotalCharge",
          "expected system charge must be integral within the configured tolerance",
        ),
      );
    }

    const components = new Map<string, SystemComponent>();
    if (input.components.length === 0) {
      errors.push(issue("invalid_component", "components", "at least one component is required"));
    }
    for (const [index, component] of input.components.entries()) {
      const path = `components[${index}]`;
      if (component.componentId.trim() === "") {
        errors.push(
          issue("invalid_component", `${path}.componentId`, "componentId must not be empty"),
        );
        continue;
      }
      if (components.has(component.componentId)) {
        errors.push(
          issue(
            "duplicate_component",
            `${path}.componentId`,
            `duplicate component ${component.componentId}`,
          ),
        );
      } else {
        components.set(component.componentId, component);
      }
      if (!Number.isSafeInteger(component.moleculeCount) || component.moleculeCount < 1) {
        errors.push(
          issue(
            "invalid_component",
            `${path}.moleculeCount`,
            "moleculeCount must be a positive integer",
          ),
        );
      }
      if (
        component.declaredNetCharge !== undefined &&
        !Number.isFinite(component.declaredNetCharge)
      ) {
        errors.push(
          issue(
            "invalid_charge",
            `${path}.declaredNetCharge`,
            "declared component charge must be finite",
          ),
        );
      }
    }

    const atoms = new Map<string, SystemAtom>();
    const atomsByComponent = new Map<string, SystemAtom[]>();
    let totalCharge = 0;
    if (input.atoms.length === 0) {
      errors.push(issue("invalid_atom", "atoms", "at least one atom is required"));
    }
    for (const [index, atom] of input.atoms.entries()) {
      const path = `atoms[${index}]`;
      if (
        atom.atomId.trim() === "" ||
        atom.residueId.trim() === "" ||
        atom.residueName.trim() === "" ||
        atom.atomName.trim() === "" ||
        !/^[A-Z][a-z]?$/u.test(atom.element) ||
        !Number.isSafeInteger(atom.componentAtomIndex) ||
        atom.componentAtomIndex < 1 ||
        !Number.isSafeInteger(atom.residueIndex) ||
        (atom.chainId !== undefined && atom.chainId.trim() === "")
      ) {
        errors.push(
          issue(
            "invalid_atom",
            path,
            "atom canonical identity fields must be valid and component indices one-based",
          ),
        );
      }
      if (atoms.has(atom.atomId)) {
        errors.push(issue("duplicate_atom", `${path}.atomId`, `duplicate atom ${atom.atomId}`));
      } else {
        atoms.set(atom.atomId, atom);
      }
      if (!components.has(atom.componentId)) {
        errors.push(
          issue(
            "unknown_component",
            `${path}.componentId`,
            `unknown component ${atom.componentId}`,
          ),
        );
      } else {
        const componentAtoms = atomsByComponent.get(atom.componentId) ?? [];
        componentAtoms.push(atom);
        atomsByComponent.set(atom.componentId, componentAtoms);
      }
      if (!Number.isFinite(atom.charge)) {
        errors.push(issue("invalid_charge", `${path}.charge`, "atom charge must be finite"));
      } else {
        totalCharge += atom.charge;
      }
      if (!finiteVector(atom.positionAngstrom)) {
        errors.push(
          issue("invalid_atom", `${path}.positionAngstrom`, "atom position must be finite"),
        );
      }
    }

    for (const component of input.components) {
      const componentAtoms = atomsByComponent.get(component.componentId) ?? [];
      if (componentAtoms.length === 0) {
        errors.push(
          issue(
            "empty_component",
            `components.${component.componentId}`,
            "component has no mapped atoms",
          ),
        );
      }
      if (component.declaredNetCharge !== undefined) {
        const observed = componentAtoms.reduce((sum, atom) => sum + atom.charge, 0);
        if (Math.abs(observed - component.declaredNetCharge) > chargeTolerance) {
          errors.push(
            issue(
              "component_charge_mismatch",
              `components.${component.componentId}.declaredNetCharge`,
              `declared charge ${component.declaredNetCharge} differs from atom sum ${rounded(observed)}`,
            ),
          );
        }
      }
    }
    if (
      Number.isFinite(input.expectedTotalCharge) &&
      Math.abs(totalCharge - input.expectedTotalCharge) > chargeTolerance
    ) {
      errors.push(
        issue(
          "total_charge_mismatch",
          "expectedTotalCharge",
          `expected charge ${input.expectedTotalCharge} differs from atom sum ${rounded(totalCharge)}`,
        ),
      );
    }

    const expectedComposition = new Map<BiomolecularComponentKind, number>();
    for (const [index, expectation] of input.expectedComposition.entries()) {
      if (expectedComposition.has(expectation.kind)) {
        errors.push(
          issue(
            "duplicate_composition_kind",
            `expectedComposition[${index}].kind`,
            `duplicate composition kind ${expectation.kind}`,
          ),
        );
      }
      if (!Number.isSafeInteger(expectation.moleculeCount) || expectation.moleculeCount < 0) {
        errors.push(
          issue(
            "composition_mismatch",
            `expectedComposition[${index}].moleculeCount`,
            "expected molecule count must be a non-negative integer",
          ),
        );
      }
      expectedComposition.set(expectation.kind, expectation.moleculeCount);
    }
    const observedComposition = new Map<BiomolecularComponentKind, number>();
    for (const component of input.components) {
      observedComposition.set(
        component.kind,
        (observedComposition.get(component.kind) ?? 0) + component.moleculeCount,
      );
    }
    const allKinds = new Set([...expectedComposition.keys(), ...observedComposition.keys()]);
    for (const kind of allKinds) {
      const expected = expectedComposition.get(kind) ?? 0;
      const observed = observedComposition.get(kind) ?? 0;
      if (expected !== observed) {
        errors.push(
          issue(
            "composition_mismatch",
            `expectedComposition.${kind}`,
            `expected ${expected} ${kind} molecule(s), observed ${observed}`,
          ),
        );
      }
    }

    const parsedAtomMap = AtomMapSchema.safeParse(input.atomMap);
    if (!parsedAtomMap.success) {
      errors.push(
        issue(
          "atom_map_schema_invalid",
          "atomMap",
          `canonical atom map failed schema validation: ${parsedAtomMap.error.issues[0]?.message ?? "invalid"}`,
        ),
      );
    } else {
      const atomMap = parsedAtomMap.data;
      try {
        assertAtomMapDigest(atomMap);
      } catch {
        errors.push(
          issue(
            "atom_map_digest_mismatch",
            "atomMap.mapDigest",
            "canonical atom map content does not match mapDigest",
          ),
        );
      }
      if (
        atomMap.systemManifestId !== input.systemId ||
        atomMap.systemManifestRevision !== input.revision ||
        atomMap.topologyDigest !== input.topologyDigest ||
        atomMap.coordinateDigest !== input.coordinateDigest
      ) {
        errors.push(
          issue(
            "atom_map_system_mismatch",
            "atomMap",
            "canonical atom map does not bind the exact assembly identity and artifacts",
          ),
        );
      }
      if (
        atomMap.atomCount !== input.atoms.length ||
        atomMap.entries.length !== input.atoms.length
      ) {
        errors.push(
          issue(
            "atom_map_length_mismatch",
            "atomMap",
            `atom map has ${atomMap.entries.length} entries for ${input.atoms.length} atoms`,
          ),
        );
      }
      const mappedIndexes = new Set<number>();
      for (const [index, entry] of atomMap.entries.entries()) {
        const path = `atomMap.entries[${index}]`;
        if (
          !Number.isSafeInteger(entry.systemAtomIndex) ||
          entry.systemAtomIndex < 1 ||
          entry.systemAtomIndex > input.atoms.length
        ) {
          errors.push(
            issue(
              "atom_map_index_invalid",
              `${path}.systemAtomIndex`,
              "atom index must address one assembly atom",
            ),
          );
          continue;
        }
        if (mappedIndexes.has(entry.systemAtomIndex)) {
          errors.push(
            issue(
              "atom_map_index_duplicate",
              `${path}.systemAtomIndex`,
              `duplicate system atom index ${entry.systemAtomIndex}`,
            ),
          );
        }
        mappedIndexes.add(entry.systemAtomIndex);
        if (entry.systemAtomIndex !== index + 1) {
          errors.push(
            issue(
              "atom_map_order_mismatch",
              `${path}.systemAtomIndex`,
              "canonical map entries must preserve topology order",
            ),
          );
        }
        const atom = input.atoms[entry.systemAtomIndex - 1];
        if (atom === undefined) continue;
        if (atom.componentId !== entry.componentId) {
          errors.push(
            issue(
              "atom_map_component_mismatch",
              `${path}.componentId`,
              `assembly atom ${atom.atomId} belongs to ${atom.componentId}, not ${entry.componentId}`,
            ),
          );
        }
        if (
          atom.componentAtomIndex !== entry.componentAtomIndex ||
          atom.chainId !== entry.chainId ||
          atom.residueIndex !== entry.residueIndex ||
          atom.residueName !== entry.residueName ||
          atom.atomName !== entry.atomName
        ) {
          errors.push(
            issue(
              "atom_map_atom_identity_mismatch",
              path,
              `canonical identity does not match assembly atom ${atom.atomId}`,
            ),
          );
        }
        if (atom.element !== entry.element) {
          errors.push(
            issue(
              "atom_map_element_mismatch",
              `${path}.element`,
              `canonical element ${entry.element} differs from assembly atom ${atom.element}`,
            ),
          );
        }
      }
      for (let index = 1; index <= input.atoms.length; index += 1) {
        if (!mappedIndexes.has(index)) {
          errors.push(
            issue(
              "atom_map_index_not_contiguous",
              "atomMap.entries",
              `system atom index ${index} is missing`,
            ),
          );
        }
      }
    }

    const origin = input.box.originAngstrom ?? ([0, 0, 0] as const);
    const vectors = input.box.vectorsAngstrom;
    const determinantValue = determinant(vectors);
    const validBox =
      finiteVector(origin) &&
      vectors.every(finiteVector) &&
      Number.isFinite(determinantValue) &&
      determinantValue > 1e-9;
    if (!validBox) {
      errors.push(
        issue("invalid_box", "box", "box vectors must be finite and span a non-zero volume"),
      );
    }

    if (validBox) {
      for (const [index, atom] of input.atoms.entries()) {
        if (!finiteVector(atom.positionAngstrom)) continue;
        const fractional = fractionalCoordinates(
          subtract(atom.positionAngstrom, origin),
          vectors,
          determinantValue,
        );
        if (
          fractional.some(
            (coordinate) =>
              coordinate < -coordinateTolerance || coordinate >= 1 + coordinateTolerance,
          )
        ) {
          errors.push(
            issue(
              "atom_outside_box",
              `atoms[${index}].positionAngstrom`,
              `atom ${atom.atomId} lies outside the declared periodic box`,
            ),
          );
        }
      }
    }

    const requestedPairChecks = (input.atoms.length * (input.atoms.length - 1)) / 2;
    let pairChecks = 0;
    let minimumDistance: number | undefined;
    if (!Number.isSafeInteger(maximumPairChecks) || maximumPairChecks < 0) {
      errors.push(
        issue(
          "overlap_pair_limit_exceeded",
          "options.maximumPairChecks",
          "maximumPairChecks must be non-negative",
        ),
      );
    } else if (requestedPairChecks > maximumPairChecks) {
      errors.push(
        issue(
          "overlap_pair_limit_exceeded",
          "atoms",
          `exhaustive overlap validation requires ${requestedPairChecks} pairs, above limit ${maximumPairChecks}`,
        ),
      );
    } else if (validBox) {
      for (let leftIndex = 0; leftIndex < input.atoms.length; leftIndex += 1) {
        const left = input.atoms[leftIndex]!;
        if (!finiteVector(left.positionAngstrom)) continue;
        for (let rightIndex = leftIndex + 1; rightIndex < input.atoms.length; rightIndex += 1) {
          const right = input.atoms[rightIndex]!;
          if (!finiteVector(right.positionAngstrom)) continue;
          pairChecks += 1;
          const distance = periodicDistance(
            left.positionAngstrom,
            right.positionAngstrom,
            vectors,
            determinantValue,
          );
          minimumDistance =
            minimumDistance === undefined ? distance : Math.min(minimumDistance, distance);
          if (distance < overlapThreshold) {
            overlaps.push({
              leftAtomId: left.atomId,
              rightAtomId: right.atomId,
              distanceAngstrom: rounded(distance),
            });
            errors.push(
              issue(
                "atom_overlap",
                `atoms[${leftIndex}],atoms[${rightIndex}]`,
                `atoms ${left.atomId} and ${right.atomId} are ${rounded(distance)} Å apart`,
              ),
            );
          }
        }
      }
    }

    const validation: SystemBuildValidation = {
      valid: errors.length === 0,
      errors,
      warnings,
      metrics: {
        atomCount: input.atoms.length,
        componentCount: input.components.length,
        totalCharge: rounded(totalCharge),
        ...(validBox ? { boxVolumeAngstrom3: rounded(Math.abs(determinantValue)) } : {}),
        ...(minimumDistance === undefined
          ? {}
          : { minimumInteratomicDistanceAngstrom: rounded(minimumDistance) }),
        pairChecks,
      },
      overlaps,
    };
    return validation;
  }

  build(
    input: SystemAssemblyInput,
    options: SystemValidationOptions = {},
  ): ValidatedSystemAssembly {
    const validation = this.validate(input, options);
    if (!validation.valid) throw new InvalidSystemAssemblyError(validation);
    return {
      input,
      validation: validation as SystemBuildValidation & { readonly valid: true },
    };
  }
}
