import { assertAmberPilotCandidateDigest, type AtomMap } from "@eigengrid/scientific-schema";
import { z } from "zod";
import { assertCanonicalAtomMapDigest, deriveAmberAtomMapView } from "./atom-map";
import { sha256Bytes, sha256Canonical } from "./canonical";
import { LogicalPathSchema, Sha256Schema } from "./contracts";
import { renderLeapAssembly } from "./leap";
import { parseLeapOutput } from "./leap-diagnostics";
import { validateAmberTopology } from "./validation";

export const AmberPilotPreparationOptionsSchema = z
  .object({
    workspace: LogicalPathSchema,
    environmentDigest: Sha256Schema,
    parameterLibraryDigest: Sha256Schema,
  })
  .strict();
export type AmberPilotPreparationOptions = z.infer<typeof AmberPilotPreparationOptionsSchema>;

/** Pure review compiler. A command description grants no scientific or site authority. */
export function renderAmberPilotPreparation(
  candidateValue: unknown,
  optionsValue: AmberPilotPreparationOptions,
) {
  const candidate = assertAmberPilotCandidateDigest(candidateValue);
  const options = AmberPilotPreparationOptionsSchema.parse(optionsValue);
  const root = options.workspace;
  const assembly = renderLeapAssembly({
    forceFields: ["leaprc.protein.ff14SB", "leaprc.water.tip3p"],
    frcmods: [],
    components: [],
    peptideTemplate: {
      identity: candidate.system.solute.identity,
      stereochemistry: candidate.system.solute.stereochemistry,
    },
    solvation: {
      waterModel: candidate.system.forceFields.water,
      boxShape: candidate.system.solvation.boxShape,
      paddingAngstrom: candidate.system.solvation.paddingAngstrom,
    },
    ions: { kind: "none", soluteNetCharge: candidate.system.solvation.netCharge },
    scriptPath: `${root}/tleap.in`,
    topologyPath: `${root}/system.prmtop`,
    coordinatesPath: `${root}/system.rst7`,
    snapshotPdbPath: `${root}/system.pdb`,
    logPath: `${root}/tleap.log`,
    cwd: root,
  });
  const material = {
    schemaVersion: "eigengrid.amber-pilot-preparation/v1" as const,
    rendererVersion: "1.0.0" as const,
    executionEligibility: "requires_exact_scientific_and_site_authority" as const,
    candidate: {
      id: candidate.id,
      revision: candidate.revision,
      digest: candidate.candidateDigest,
    },
    environmentDigest: options.environmentDigest,
    parameterLibraryDigest: options.parameterLibraryDigest,
    solute: candidate.system.solute,
    forceFields: ["leaprc.protein.ff14SB", "leaprc.water.tip3p"],
    solvation: candidate.system.solvation,
    ionPolicy: { kind: "none" as const, soluteNetCharge: 0 },
    expectedTotalCharge: 0,
    maximumAtomCount: candidate.system.solvation.maximumAtomCount,
    command: assembly.command,
    scriptDigest: assembly.input.sha256,
  };
  return { ...assembly, manifest: { ...material, preparationDigest: sha256Canonical(material) } };
}

export type RenderedAmberPilotPreparation = ReturnType<typeof renderAmberPilotPreparation>;

export interface AmberPilotPreparationEvidence {
  prmtop: string;
  rst7: string;
  snapshotPdb: string;
  leapLog: string;
  exitCode: number;
  atomMap: AtomMap;
}

/**
 * Structural evidence only, never an approval, engine qualification or a
 * stereochemistry certificate. Bind the exact output bytes before projection.
 */
export function inspectAmberPilotPreparation(
  candidateValue: unknown,
  options: AmberPilotPreparationOptions,
  evidence: AmberPilotPreparationEvidence,
) {
  const prepared = renderAmberPilotPreparation(candidateValue, options);
  const atomMap = assertCanonicalAtomMapDigest(evidence.atomMap);
  const topologyDigest = sha256Bytes(evidence.prmtop);
  const coordinateDigest = sha256Bytes(evidence.rst7);
  if (atomMap.topologyDigest !== topologyDigest || atomMap.coordinateDigest !== coordinateDigest) {
    throw new Error("Preparation AtomMap must bind the exact topology and coordinate bytes");
  }
  const exitCode = z.number().int().parse(evidence.exitCode);
  const log = parseLeapOutput(evidence.leapLog, exitCode);
  const topology = validateAmberTopology({
    prmtop: evidence.prmtop,
    rst7: evidence.rst7,
    atomMapView: deriveAmberAtomMapView(atomMap, atomMap.mapDigest),
    expectedCanonicalAtomMapDigest: atomMap.mapDigest,
    expectedAtomCount: atomMap.atomCount,
    expectedTotalCharge: 0,
    chargeTolerance: 1e-4,
    requirePeriodicBox: true,
  });
  const issues = [...topology.issues];
  if (!log.completed || log.errors.length > 0)
    issues.push({
      code: "leap_incomplete",
      message: "LEaP must complete with no missing parameters or reported errors",
    });
  if (log.warnings.length > 0)
    issues.push({
      code: "leap_warning_requires_review",
      message: "Preparation warnings require explicit review",
    });
  if (atomMap.atomCount > prepared.manifest.maximumAtomCount)
    issues.push({
      code: "atom_limit_exceeded",
      message: "Preparation exceeds the candidate atom-count envelope",
    });
  const residues: Array<{ index: number; name: string; atoms: string[] }> = [];
  for (const atom of atomMap.entries) {
    const previous = residues.at(-1);
    if (previous?.index === atom.residueIndex) {
      if (previous.name !== atom.residueName)
        issues.push({
          code: "residue_identity_mismatch",
          message: "One residue index has conflicting residue names",
        });
      previous.atoms.push(atom.atomName);
    } else
      residues.push({ index: atom.residueIndex, name: atom.residueName, atoms: [atom.atomName] });
  }
  const expectedSolute = [
    { name: "ACE", atoms: ["CH3", "HH31", "HH32", "HH33", "C", "O"] },
    { name: "ALA", atoms: ["N", "H", "CA", "HA", "CB", "HB1", "HB2", "HB3", "C", "O"] },
    { name: "NME", atoms: ["N", "H", "CH3", "HH31", "HH32", "HH33"] },
  ];
  const names = (atoms: string[]) => [...atoms].sort().join("\0");
  if (
    residues.length < 4 ||
    new Set(residues.map((residue) => residue.index)).size !== residues.length ||
    expectedSolute.some(
      (expected, index) =>
        residues[index]?.name !== expected.name ||
        names(residues[index]!.atoms) !== names(expected.atoms),
    ) ||
    residues
      .slice(3)
      .some(
        (residue) => residue.name !== "WAT" || names(residue.atoms) !== names(["O", "H1", "H2"]),
      )
  ) {
    issues.push({
      code: "pilot_composition_mismatch",
      message:
        "Pilot requires exactly ACE–ALA–NME followed by TIP3P waters, with no ions or additional solutes",
    });
  }
  const box = topology.summary.coordinateBox;
  if (box !== null && box.slice(3).some((angle) => Math.abs(angle - 90) > 1e-4))
    issues.push({
      code: "pilot_box_shape_mismatch",
      message: "Pilot requires an orthorhombic box",
    });
  const lineage = {
    preparationDigest: prepared.manifest.preparationDigest,
    scriptDigest: prepared.input.sha256,
    topologyDigest,
    coordinateDigest,
    snapshotPdbDigest: sha256Bytes(evidence.snapshotPdb),
    leapLogDigest: sha256Bytes(evidence.leapLog),
    atomMapDigest: atomMap.mapDigest,
    exitCode,
  };
  return {
    schemaVersion: "eigengrid.amber-pilot-preparation-inspection/v1" as const,
    validationScope: "lightweight-structural-v1" as const,
    amberConsumableCertified: false as const,
    scientificApprovalGranted: false as const,
    valid: issues.length === 0,
    issues,
    lineage,
    evidenceDigest: sha256Canonical(lineage),
  };
}
