import {
  assertMdStageResultDigest,
  assertQmmmProtocolDigest,
  digestBytes,
} from "@eigengrid/scientific-schema";
import { type AnalysisDiagnostic, analysisDiagnostic, cleanDiagnosticLine } from "../contracts";
import { type AmberQmmmParseAuthority, assertIssuedParseAuthority } from "./authority";
import { bindingChecks, numericValue, valuesMatch } from "./bindings";
import {
  type AmberQmmmEnergySample,
  AmberQmmmEnergySampleSchema,
  type AmberQmmmObservation,
  AmberQmmmObservationSchema,
} from "./observations";
import { AmberQmmmParseRequestSchema } from "./request";
import {
  type AmberQmmmParseResult,
  AmberQmmmParseResultSchema,
  computeAmberQmmmParseDigest,
} from "./result";
import { AmberQmmmParseSchemaVersion, AmberQmmmParserVersion } from "./versions";

/**
 * Parse stable AMBER 26 QM/MM control and result observations. The parser never
 * changes scientific controls: any missing, unsupported, or contradictory
 * observation stops assessment and requires external review.
 */
export function parseAmberQmmmMdout(
  content: string,
  requestValue: unknown,
  authority: AmberQmmmParseAuthority,
): AmberQmmmParseResult {
  const request = AmberQmmmParseRequestSchema.parse(requestValue);
  assertMdStageResultDigest(request.stageResult);
  assertQmmmProtocolDigest(request.protocol);
  assertIssuedParseAuthority(request, authority);
  const diagnostics: AnalysisDiagnostic[] = [];
  const energySamples: AmberQmmmEnergySample[] = [];
  const observation: AmberQmmmObservation = {
    qmmmEnabled: null,
    qmGeneralizedBornMode: null,
    chargeAdjustmentMode: null,
    theory: null,
    qmCharge: null,
    spinMultiplicity: null,
    qmAtomCount: null,
    qmAtomIndices: [],
    linkAtomCount: null,
    cutoffAngstrom: null,
    scfConvergenceTolerance: null,
    maximumScfIterations: null,
    qmInteractionMode: null,
    qmEwaldMode: null,
    qmPme: null,
    qmShakeMode: null,
    linkAtomicNumber: null,
    linkDistanceAngstrom: null,
    linkMethod: null,
    gradientMethod: null,
    tightDensityConvergence: null,
    verbosity: null,
    printCharges: null,
    printDipole: null,
    peptideCorrection: null,
    qmmmRijIncore: null,
    qmqmErepIncore: null,
    pseudoDiagonalization: null,
    pseudoDiagonalizationCriteria: null,
    diagonalizationRoutine: null,
  };

  if (digestBytes(content) !== request.source.contentDigest) {
    diagnostics.push(
      analysisDiagnostic({
        code: "source_digest_mismatch",
        severity: "fatal",
        message: "Injected QM/MM mdout bytes do not match the exact source artifact digest",
        evidenceRefs: [request.source.evidenceRef],
      }),
    );
  }

  let inQmmmOptions = false;
  let inQmCoordinates = false;
  let inResults = false;
  let inFinalResults = false;
  let terminalMarkerObserved = false;
  let scfFailureObserved = false;
  let cycleLimitObserved = false;
  let qmmmOptionsCount = 0;
  let coordinateSectionCount = 0;
  let resultsSectionCount = 0;
  let finalResultsCount = 0;
  let timingsSectionCount = 0;
  let qmmmOptionsIndex = -1;
  let coordinateSectionIndex = -1;
  let resultsSectionIndex = -1;
  let finalResultsIndex = -1;
  let timingsSectionIndex = -1;
  let finalEnergySample: AmberQmmmEnergySample | null = null;
  const observedControlFields = new Set<string>();

  const addDiagnostic = (code: string, line: number, message: string): void => {
    diagnostics.push(
      analysisDiagnostic({
        code,
        severity: "fatal",
        line,
        message,
        evidenceRefs: [request.source.evidenceRef],
      }),
    );
  };
  const controlAssignmentCount = (raw: string, field: string): number =>
    [...raw.matchAll(new RegExp(`\\b${field}\\s*=`, "giu"))].length;
  const observeNumber = (
    raw: string,
    line: number,
    field: string,
    current: number | null,
    valid: (value: number) => boolean,
  ): number | null => {
    const assignments = controlAssignmentCount(raw, field);
    if (assignments === 0) return current;
    const matches = [...raw.matchAll(new RegExp(`\\b${field}\\s*=\\s*([^\\s,]+)`, "giu"))];
    if (observedControlFields.has(field) || assignments !== 1 || matches.length !== 1) {
      addDiagnostic(
        "qmmm_duplicate_control",
        line,
        `QM/MM runtime control ${field} was observed more than once`,
      );
      observedControlFields.add(field);
      return null;
    }
    observedControlFields.add(field);
    const value = numericValue(matches[0]![1]!);
    if (value === null || !valid(value)) {
      addDiagnostic(
        "qmmm_invalid_control",
        line,
        `QM/MM runtime control ${field} is malformed or outside its contract`,
      );
      return null;
    }
    return value;
  };
  const observeToken = (
    raw: string,
    line: number,
    field: string,
    current: string | null,
  ): string | null => {
    const assignments = controlAssignmentCount(raw, field);
    if (assignments === 0) return current;
    const matches = [...raw.matchAll(new RegExp(`\\b${field}\\s*=\\s*([^\\s,]+)`, "giu"))];
    if (observedControlFields.has(field) || assignments !== 1 || matches.length !== 1) {
      addDiagnostic(
        "qmmm_duplicate_control",
        line,
        `QM/MM runtime control ${field} was observed more than once`,
      );
      observedControlFields.add(field);
      return null;
    }
    observedControlFields.add(field);
    const rawValue = matches[0]![1]!;
    const value =
      rawValue.startsWith("'") && rawValue.endsWith("'") && rawValue.length > 2
        ? rawValue.slice(1, -1)
        : rawValue;
    if (rawValue.includes("'") && rawValue !== `'${value}'`) {
      addDiagnostic("qmmm_invalid_control", line, `QM/MM runtime control ${field} is malformed`);
      return null;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9+_.-]*$/u.test(value)) {
      addDiagnostic("qmmm_invalid_control", line, `QM/MM runtime control ${field} is malformed`);
      return null;
    }
    return value;
  };
  const observeBoolean = (
    raw: string,
    line: number,
    field: string,
    current: boolean | null,
  ): boolean | null => {
    const assignments = controlAssignmentCount(raw, field);
    if (assignments === 0) return current;
    const matches = [...raw.matchAll(new RegExp(`\\b${field}\\s*=\\s*([^\\s,]+)`, "giu"))];
    if (observedControlFields.has(field) || assignments !== 1 || matches.length !== 1) {
      addDiagnostic(
        "qmmm_duplicate_control",
        line,
        `QM/MM runtime control ${field} was observed more than once`,
      );
      observedControlFields.add(field);
      return null;
    }
    observedControlFields.add(field);
    const value = matches[0]![1]!;
    if (!/^(?:True|False)$/u.test(value)) {
      addDiagnostic(
        "qmmm_invalid_control",
        line,
        `QM/MM runtime control ${field} must be exactly True or False`,
      );
      return null;
    }
    return value === "True";
  };

  const lines = content.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]!;
    const line = index + 1;
    if (/^\s*QMMM options:\s*$/u.test(raw)) {
      qmmmOptionsCount += 1;
      qmmmOptionsIndex = qmmmOptionsIndex < 0 ? index : qmmmOptionsIndex;
      inQmmmOptions = true;
    } else if (inQmmmOptions && /^\s*(?:-{8,}|\d+\.\s+)/u.test(raw)) {
      inQmmmOptions = false;
    }
    if (/QMMM:\s+QM Region Cartesian Coordinates/iu.test(raw)) {
      coordinateSectionCount += 1;
      coordinateSectionIndex = coordinateSectionIndex < 0 ? index : coordinateSectionIndex;
      inQmCoordinates = true;
    }
    if (inQmCoordinates && /^\s*-{8,}/u.test(raw)) inQmCoordinates = false;
    if (/^\s*4\.\s+RESULTS\s*$/u.test(raw)) {
      resultsSectionCount += 1;
      resultsSectionIndex = resultsSectionIndex < 0 ? index : resultsSectionIndex;
      inResults = true;
    }
    if (/^\s*FINAL RESULTS\s*$/u.test(raw)) {
      finalResultsCount += 1;
      finalResultsIndex = finalResultsIndex < 0 ? index : finalResultsIndex;
      inFinalResults = true;
    }
    if (/^\s*5\.\s+TIMINGS\s*$/iu.test(raw)) {
      timingsSectionCount += 1;
      timingsSectionIndex = timingsSectionIndex < 0 ? index : timingsSectionIndex;
      if (finalResultsIndex >= 0 && index > finalResultsIndex) terminalMarkerObserved = true;
    }
    if (
      inResults &&
      !inFinalResults &&
      /Maximum number of minimization cycles reached/iu.test(raw)
    ) {
      cycleLimitObserved = true;
    }
    if (
      /(?:QMMM.*(?:SCF|self[- ]consisten).*(?:failed|failure|not converge)|Unable to achieve self consistency)/iu.test(
        raw,
      )
    ) {
      scfFailureObserved = true;
      addDiagnostic("qmmm_scf_failure", line, cleanDiagnosticLine(raw));
    } else if (/SANDER BOMB|PMEMD BOMB|\bFATAL\b|segmentation fault/iu.test(raw)) {
      addDiagnostic("engine_fatal", line, cleanDiagnosticLine(raw));
    }

    if (inQmmmOptions) {
      observation.qmmmEnabled = observeBoolean(raw, line, "ifqnt", observation.qmmmEnabled);
      observation.qmAtomCount = observeNumber(
        raw,
        line,
        "nquant",
        observation.qmAtomCount,
        (value) => Number.isInteger(value) && value > 0,
      );
      observation.qmGeneralizedBornMode = observeNumber(
        raw,
        line,
        "qmgb",
        observation.qmGeneralizedBornMode,
        Number.isInteger,
      );
      observation.chargeAdjustmentMode = observeNumber(
        raw,
        line,
        "adjust_q",
        observation.chargeAdjustmentMode,
        Number.isInteger,
      );
      observation.qmCharge = observeNumber(
        raw,
        line,
        "qmcharge",
        observation.qmCharge,
        Number.isInteger,
      );
      observation.spinMultiplicity = observeNumber(
        raw,
        line,
        "spin",
        observation.spinMultiplicity,
        (value) => Number.isInteger(value) && value > 0,
      );
      observation.cutoffAngstrom = observeNumber(
        raw,
        line,
        "qmcut",
        observation.cutoffAngstrom,
        (value) => value > 0,
      );
      observation.qmShakeMode = observeNumber(
        raw,
        line,
        "qmshake",
        observation.qmShakeMode,
        Number.isInteger,
      );
      observation.linkAtomicNumber = observeNumber(
        raw,
        line,
        "lnk_atomic_no",
        observation.linkAtomicNumber,
        Number.isInteger,
      );
      observation.linkDistanceAngstrom = observeNumber(
        raw,
        line,
        "lnk_dis",
        observation.linkDistanceAngstrom,
        (value) => value > 0,
      );
      observation.linkMethod = observeNumber(
        raw,
        line,
        "lnk_method",
        observation.linkMethod,
        Number.isInteger,
      );
      observation.maximumScfIterations = observeNumber(
        raw,
        line,
        "itrmax",
        observation.maximumScfIterations,
        (value) => Number.isInteger(value) && value > 0,
      );
      observation.scfConvergenceTolerance = observeNumber(
        raw,
        line,
        "scfconv",
        observation.scfConvergenceTolerance,
        (value) => value > 0 && value < 1,
      );
      observation.qmInteractionMode = observeNumber(
        raw,
        line,
        "qmmm_int",
        observation.qmInteractionMode,
        Number.isInteger,
      );
      observation.qmEwaldMode = observeNumber(
        raw,
        line,
        "qm_ewald",
        observation.qmEwaldMode,
        Number.isInteger,
      );
      observation.theory = observeToken(raw, line, "qm_theory", observation.theory);
      observation.gradientMethod = observeToken(raw, line, "qmqmdx", observation.gradientMethod);
      observation.tightDensityConvergence = observeBoolean(
        raw,
        line,
        "tight_p_conv",
        observation.tightDensityConvergence,
      );
      observation.verbosity = observeNumber(
        raw,
        line,
        "verbosity",
        observation.verbosity,
        Number.isInteger,
      );
      observation.printCharges = observeBoolean(
        raw,
        line,
        "printcharges",
        observation.printCharges,
      );
      observation.printDipole = observeBoolean(raw, line, "printdipole", observation.printDipole);
      observation.peptideCorrection = observeBoolean(
        raw,
        line,
        "peptide_corr",
        observation.peptideCorrection,
      );
      observation.qmmmRijIncore = observeBoolean(
        raw,
        line,
        "qmmmrij_incore",
        observation.qmmmRijIncore,
      );
      observation.qmqmErepIncore = observeBoolean(
        raw,
        line,
        "qmqm_erep_incore",
        observation.qmqmErepIncore,
      );
      observation.pseudoDiagonalization = observeBoolean(
        raw,
        line,
        "pseudo_diag",
        observation.pseudoDiagonalization,
      );
      observation.pseudoDiagonalizationCriteria = observeNumber(
        raw,
        line,
        "pseudo_diag_criteria",
        observation.pseudoDiagonalizationCriteria,
        (value) => value > 0,
      );
      observation.diagonalizationRoutine = observeNumber(
        raw,
        line,
        "diag_routine",
        observation.diagonalizationRoutine,
        Number.isInteger,
      );
      observation.qmPme = observeBoolean(raw, line, "qm_pme", observation.qmPme);
    }

    if (inQmCoordinates) {
      const row = raw.match(
        /^\s*QMMM:\s+(\d+)\s+(\d+)\s+\S+\s+([-+0-9.EeDd]+)\s+([-+0-9.EeDd]+)\s+([-+0-9.EeDd]+)\s*$/u,
      );
      if (row?.[2] !== undefined) {
        const qmIndex = Number(row[1]);
        if (qmIndex !== observation.qmAtomIndices.length + 1) {
          addDiagnostic(
            "qmmm_atom_mapping_invalid",
            line,
            "QM atom rows must have a unique contiguous QM index",
          );
        }
        const coordinates = row.slice(3, 6).map(numericValue);
        if (coordinates.some((value) => value === null)) {
          addDiagnostic("qmmm_coordinate_invalid", line, cleanDiagnosticLine(raw));
        }
        observation.qmAtomIndices.push(Number(row[2]));
      } else if (
        /^\s*QMMM:/u.test(raw) &&
        !/QM Region Cartesian Coordinates|QM_NO\.\s+MM_NO\./u.test(raw)
      ) {
        addDiagnostic(
          "qmmm_coordinate_invalid",
          line,
          "Malformed row was present in the QM coordinate section",
        );
      }
    }
    if (/\bnlink\s*=/iu.test(raw)) {
      observation.linkAtomCount = observeNumber(
        raw,
        line,
        "nlink",
        observation.linkAtomCount,
        (value) => Number.isInteger(value) && value >= 0,
      );
    }

    if (inResults) {
      const row = raw.match(
        /^\s*(\d+)\s+([-+0-9.EeDd]+)\s+([-+0-9.EeDd]+)\s+([-+0-9.EeDd]+)\s+(\S+)\s+(\d+)\s*$/u,
      );
      if (row !== null) {
        const values = row.slice(2, 5).map(numericValue);
        if (values.some((value) => value === null)) {
          addDiagnostic("qmmm_numeric_overflow", line, cleanDiagnosticLine(raw));
        } else {
          const sample = {
            sourceLine: line,
            step: Number(row[1]),
            totalEnergyKcalMol: values[0]!,
            rmsGradient: values[1]!,
            maximumGradient: values[2]!,
            maximumGradientAtomName: row[5]!,
            maximumGradientAtomIndex: Number(row[6]),
            qmEnergyKcalMol: null,
          };
          if (inFinalResults) {
            if (finalEnergySample !== null) {
              addDiagnostic(
                "qmmm_final_result_mismatch",
                line,
                "FINAL RESULTS contains more than one energy row",
              );
            } else finalEnergySample = AmberQmmmEnergySampleSchema.parse(sample);
          } else energySamples.push(sample);
        }
      } else if (/^\s*\d+\s+/u.test(raw)) {
        addDiagnostic("qmmm_numeric_overflow", line, "Malformed minimization energy row");
      }
      const energyAssignments = [...raw.matchAll(/\b([A-Za-z0-9+_.-]+)ESCF\s*=/gu)];
      if (energyAssignments.length > 1) {
        addDiagnostic(
          "qmmm_duplicate_energy",
          line,
          "A physical output line contains more than one QM energy assignment",
        );
      }
      const qmEnergy =
        energyAssignments.length === 1
          ? raw.match(/^\s*([A-Za-z0-9+_.-]+)ESCF\s*=\s*([^\s]+)\s*$/u)
          : null;
      if (energyAssignments.length === 1 && qmEnergy === null) {
        addDiagnostic("qmmm_numeric_overflow", line, "Malformed QM energy observation");
      }
      if (qmEnergy?.[2] !== undefined) {
        const value = numericValue(qmEnergy[2]);
        const target = inFinalResults ? finalEnergySample : energySamples.at(-1);
        if (value === null || target == null) {
          addDiagnostic("qmmm_numeric_overflow", line, cleanDiagnosticLine(raw));
        } else if (
          observation.theory === null ||
          qmEnergy[1]!.toUpperCase() !== observation.theory.toUpperCase()
        ) {
          addDiagnostic(
            "qmmm_energy_theory_mismatch",
            line,
            `QM energy label ${qmEnergy[1]} does not match runtime theory ${observation.theory ?? "unobserved"}`,
          );
        } else if (target.qmEnergyKcalMol !== null) {
          addDiagnostic(
            "qmmm_duplicate_energy",
            line,
            "A minimization sample has more than one QM energy observation",
          );
        } else {
          target.qmEnergyKcalMol = value;
        }
      }
    }
  }

  const sectionCounts = [
    qmmmOptionsCount,
    coordinateSectionCount,
    resultsSectionCount,
    finalResultsCount,
    timingsSectionCount,
  ];
  const sectionOrder = [
    qmmmOptionsIndex,
    coordinateSectionIndex,
    resultsSectionIndex,
    finalResultsIndex,
    timingsSectionIndex,
  ];
  if (
    sectionCounts.some((count) => count !== 1) ||
    sectionOrder.some((position) => position < 0) ||
    sectionOrder.some((position, index) => index > 0 && position <= sectionOrder[index - 1]!)
  ) {
    diagnostics.push(
      analysisDiagnostic({
        code: "qmmm_section_integrity",
        severity: "fatal",
        message:
          "QM/MM mdout requires exactly one ordered control, coordinate, result, final, and timing section",
        evidenceRefs: [request.source.evidenceRef],
      }),
    );
  }
  if (
    energySamples.length === 0 ||
    energySamples.some((sample) => sample.qmEnergyKcalMol === null)
  ) {
    diagnostics.push(
      analysisDiagnostic({
        code: "qmmm_result_incomplete",
        severity: "fatal",
        message: "QM/MM minimization requires at least one complete total/QM energy observation",
        evidenceRefs: [request.source.evidenceRef],
      }),
    );
  }
  if (
    energySamples.some(
      (sample, index) =>
        sample.step < request.stageResult.startStep ||
        sample.step > request.stageResult.endStep ||
        sample.maximumGradientAtomIndex > request.protocol.region.atomMap.atomCount ||
        (index > 0 && sample.step <= energySamples[index - 1]!.step),
    ) ||
    (energySamples.length > 0 && energySamples.at(-1)!.step !== request.stageResult.endStep)
  ) {
    diagnostics.push(
      analysisDiagnostic({
        code: "qmmm_step_sequence_mismatch",
        severity: "fatal",
        message:
          "QM/MM minimization steps and maximum-gradient atoms must stay within the exact stage and atom-map bounds",
        evidenceRefs: [request.source.evidenceRef],
      }),
    );
  }

  const checks = bindingChecks(request.protocol, AmberQmmmObservationSchema.parse(observation));
  for (const check of checks) {
    if (check.status === "matched") continue;
    diagnostics.push(
      analysisDiagnostic({
        code:
          check.status === "unsupported"
            ? "qmmm_protocol_control_unsupported"
            : "qmmm_protocol_binding_mismatch",
        severity: "fatal",
        message: `${check.field} expected ${check.expected} but observed ${check.observed ?? "nothing"}`,
        evidenceRefs: [request.source.evidenceRef, request.protocol.approvedByRef!],
      }),
    );
  }

  const stageKindUnsupported = request.stageResult.stageKind !== "minimization";
  if (stageKindUnsupported) {
    diagnostics.push(
      analysisDiagnostic({
        code: "qmmm_stage_kind_unsupported",
        severity: "fatal",
        message: `QM/MM parser v${AmberQmmmParserVersion} supports exact minimization output only`,
        evidenceRefs: [request.source.evidenceRef],
      }),
    );
  }
  if (
    request.stageResult.validationStatus === "failed" ||
    request.stageResult.errors.length > 0 ||
    ["engine_failure", "validation_failure"].includes(request.stageResult.terminalReason)
  ) {
    diagnostics.push(
      analysisDiagnostic({
        code: "qmmm_stage_result_failure",
        severity: "fatal",
        message:
          "The durable stage result records a validation, engine, or normalized execution failure",
        evidenceRefs: [
          request.source.evidenceRef,
          ...request.stageResult.errors.flatMap((error) => error.sourceEvidenceRefs),
        ],
      }),
    );
  }

  const hasUnsupported = checks.some((check) => check.status === "unsupported");
  const hasMismatch = checks.some((check) => ["mismatched", "not_observed"].includes(check.status));
  const hasSourceMismatch = diagnostics.some(
    (diagnostic) => diagnostic.code === "source_digest_mismatch",
  );
  const hasEngineFatal = diagnostics.some((diagnostic) =>
    ["engine_fatal", "qmmm_scf_failure", "qmmm_stage_result_failure"].includes(diagnostic.code),
  );
  const lastIterativeSample = energySamples.at(-1);
  if (
    finalEnergySample === null ||
    finalEnergySample.qmEnergyKcalMol === null ||
    lastIterativeSample === undefined
  ) {
    diagnostics.push(
      analysisDiagnostic({
        code: "qmmm_final_result_mismatch",
        severity: "fatal",
        message: "QM/MM minimization requires one complete FINAL RESULTS energy observation",
        evidenceRefs: [request.source.evidenceRef],
      }),
    );
  } else if (
    finalEnergySample.step !== lastIterativeSample.step ||
    !valuesMatch(finalEnergySample.totalEnergyKcalMol, lastIterativeSample.totalEnergyKcalMol) ||
    !valuesMatch(finalEnergySample.rmsGradient, lastIterativeSample.rmsGradient) ||
    !valuesMatch(finalEnergySample.maximumGradient, lastIterativeSample.maximumGradient) ||
    finalEnergySample.maximumGradientAtomName !== lastIterativeSample.maximumGradientAtomName ||
    finalEnergySample.maximumGradientAtomIndex !== lastIterativeSample.maximumGradientAtomIndex ||
    !valuesMatch(finalEnergySample.qmEnergyKcalMol, lastIterativeSample.qmEnergyKcalMol)
  ) {
    diagnostics.push(
      analysisDiagnostic({
        code: "qmmm_final_result_mismatch",
        severity: "fatal",
        message: "FINAL RESULTS does not agree with the last iterative minimization sample",
        evidenceRefs: [request.source.evidenceRef],
      }),
    );
  }
  const hasStructuralFailure = diagnostics.some((diagnostic) =>
    [
      "qmmm_duplicate_control",
      "qmmm_invalid_control",
      "qmmm_atom_mapping_invalid",
      "qmmm_coordinate_invalid",
      "qmmm_section_integrity",
      "qmmm_result_incomplete",
      "qmmm_numeric_overflow",
      "qmmm_energy_theory_mismatch",
      "qmmm_duplicate_energy",
      "qmmm_final_result_mismatch",
      "qmmm_step_sequence_mismatch",
    ].includes(diagnostic.code),
  );
  let status: AmberQmmmParseResult["status"];
  if (hasSourceMismatch) status = "authority_mismatch";
  else if (request.stageResult.exitCode !== null && request.stageResult.exitCode !== 0) {
    status = "nonzero_exit";
  } else if (request.stageResult.signal !== null || hasEngineFatal || scfFailureObserved) {
    status = "fatal";
  } else if (hasStructuralFailure || hasMismatch) status = "authority_mismatch";
  else if (stageKindUnsupported || hasUnsupported) status = "unsupported_protocol";
  else if (content.trim().length === 0) status = "no_data";
  else if (
    request.executionCompletion !== "confirmed" ||
    request.stageResult.terminalReason !== "completed" ||
    !terminalMarkerObserved
  ) {
    status = "partial";
  } else if (request.stageResult.stageKind === "minimization" && cycleLimitObserved) {
    status = "nonconverged";
  } else status = "completed";

  const unsigned = {
    schemaVersion: AmberQmmmParseSchemaVersion,
    missionId: request.missionId,
    protocol: {
      id: request.protocol.id,
      revision: request.protocol.revision,
      protocolDigest: request.protocol.protocolDigest,
      approvalRef: request.protocol.approvedByRef!,
    },
    // Request validation above admits only this qualified envelope. Keep the
    // emitted evidence type equally narrow rather than mirroring the wider
    // protocol union.
    regionSelectionClass: "all_qm_engine_check" as const,
    stageResult: {
      id: request.stageResult.id,
      revision: request.stageResult.revision,
      resultDigest: request.stageResult.resultDigest,
    },
    source: request.source,
    operationReceiptRef: request.operationReceiptRef,
    parserVersion: request.parserVersion,
    authorityDigest: authority.authorityDigest,
    status,
    terminalMarkerObserved,
    qmScfStatus: scfFailureObserved
      ? ("failed" as const)
      : observation.theory === null
        ? ("not_observed" as const)
        : ("no_failure_reported" as const),
    minimizationCycleLimit:
      request.stageResult.stageKind !== "minimization"
        ? ("not_applicable" as const)
        : cycleLimitObserved
          ? ("reached" as const)
          : terminalMarkerObserved
            ? ("not_reached" as const)
            : ("unknown" as const),
    observations: AmberQmmmObservationSchema.parse(observation),
    bindingChecks: checks,
    energySamples: energySamples.map((sample) => AmberQmmmEnergySampleSchema.parse(sample)),
    diagnostics,
    scientificAssessmentEligible: status === "completed",
    requiresEscalation: status !== "completed",
    automaticScientificCorrectionAllowed: false as const,
  };
  return AmberQmmmParseResultSchema.parse({
    ...unsigned,
    parseDigest: computeAmberQmmmParseDigest(unsigned),
  });
}
