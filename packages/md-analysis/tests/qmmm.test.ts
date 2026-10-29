import { describe, expect, test } from "bun:test";
import {
  MdArtifactReferenceSchema,
  MdStageResultSchemaVersion,
  QmmmProtocolSchemaVersion,
  QmmmRegionSelectionSchemaVersion,
  computeMdStageResultDigest,
  computeQmmmProtocolDigest,
  computeQmmmRegionSelectionDigest,
  digestBytes,
  digestCanonical,
  type MdArtifactReference,
  type QmmmDecisionCategory,
  type QmmmDecisionReference,
  type QmmmProtocol,
} from "@eigengrid/scientific-schema";
import {
  AmberQmmmParseSchemaVersion,
  AmberQmmmParserVersion,
  AmberQmmmQualifiedEngine,
  authorizeAmberQmmmParse,
  assertAmberQmmmParseResult,
  parseAmberQmmmMdout,
  type AmberQmmmParseRequest,
} from "../src/index";

const DIGEST = (character: string) => character.repeat(64);
const TIMESTAMP = "2026-08-30T12:00:00.000Z";

function decision(category: QmmmDecisionCategory): QmmmDecisionReference {
  const character = String(
    (["region", "charge_spin", "theory", "embedding", "boundary", "convergence"] as const).indexOf(
      category,
    ) + 1,
  );
  return {
    id: `decision-${category}`,
    revision: 1,
    category,
    decisionDigest: DIGEST(character),
    approvalRef: `approval-${category}`,
  };
}

function protocol(): QmmmProtocol {
  const system = {
    id: "system-water",
    revision: 1,
    systemClass: "soluble" as const,
    manifestDigest: DIGEST("a"),
    topologyDigest: DIGEST("b"),
    coordinateDigest: DIGEST("c"),
    atomMapDigest: DIGEST("d"),
  };
  const regionBase = {
    schemaVersion: QmmmRegionSelectionSchemaVersion,
    id: "qmmm-region-water",
    revision: 1,
    system,
    atomMap: {
      id: "atom-map-water",
      revision: 1,
      digest: system.atomMapDigest,
      atomCount: 3,
      indexBase: 1 as const,
    },
    selectionClass: "all_qm_engine_check" as const,
    atomIndices: [1, 2, 3],
    sourceEvidenceRefs: ["evidence-region-review"],
    decision: decision("region"),
  };
  const region = {
    ...regionBase,
    selectionDigest: computeQmmmRegionSelectionDigest(regionBase),
  };
  const decisionRefs = (
    ["region", "charge_spin", "theory", "embedding", "boundary", "convergence"] as const
  ).map(decision);
  const base = {
    schemaVersion: QmmmProtocolSchemaVersion,
    id: "qmmm-protocol-water-pm3",
    missionId: "mission-qmmm-water",
    revision: 1,
    status: "approved" as const,
    system,
    parentMdProtocol: { id: "md-protocol-water", revision: 2, digest: DIGEST("e") },
    appliedStageIds: ["stage-qmmm-minimization"],
    region,
    electronicState: {
      qmCharge: 0,
      spinMultiplicity: 1,
      decision: decision("charge_spin"),
    },
    theory: {
      provider: "amber-sqm" as const,
      theory: "PM3",
      qualificationEvidenceRef: "ambertools-26-pm3-water-module-smoke",
      decision: decision("theory"),
    },
    embedding: {
      mode: "electrostatic" as const,
      cutoffAngstrom: 999,
      longRangeTreatment: "direct_cutoff" as const,
      decision: decision("embedding"),
    },
    boundary: {
      mode: "no_covalent_boundary" as const,
      covalentBonds: [],
      decision: decision("boundary"),
    },
    convergence: {
      maximumScfIterations: 1000,
      scfConvergenceTolerance: 1e-8,
      failureDisposition: "stop_and_escalate" as const,
      automaticScientificCorrectionAttempts: 0 as const,
      escalationConditions: ["SCF failure", "minimization cycle limit"],
      decision: decision("convergence"),
    },
    decisionRefs,
    rendererCompatibilityVersion: "1.0.0",
    assumptions: ["This fixture checks the Amber QM module only"],
    limitations: ["All atoms are QM; no hybrid QM-MM coupling is exercised"],
    approvedByRef: "approval-qmmm-protocol-water-pm3",
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
  return {
    ...base,
    protocolDigest: computeQmmmProtocolDigest(base),
  };
}

function artifact(
  role: "restart" | "mdout" | "mdinfo",
  contentOrCharacter: string,
): MdArtifactReference {
  return MdArtifactReferenceSchema.parse({
    artifactId: `${role}-qmmm`,
    evidenceRef: `${role}-qmmm-evidence`,
    role,
    contentDigest: role === "mdout" ? digestBytes(contentOrCharacter) : DIGEST(contentOrCharacter),
    mediaType: role === "mdout" ? "text/plain" : "application/octet-stream",
  });
}

function request(
  content: string,
  overrides: {
    executionCompletion?: "confirmed" | "unconfirmed";
    exitCode?: number | null;
    signal?: string | null;
    terminalReason?: "completed" | "ambiguous" | "engine_failure" | "signal" | "cancelled";
    protocol?: QmmmProtocol;
  } = {},
): AmberQmmmParseRequest {
  const protocolValue = overrides.protocol ?? protocol();
  const source = artifact("mdout", content);
  const exitCode = overrides.exitCode === undefined ? 0 : overrides.exitCode;
  const signal = overrides.signal === undefined ? null : overrides.signal;
  const terminalReason =
    overrides.terminalReason ??
    (signal !== null
      ? "signal"
      : exitCode !== null && exitCode !== 0
        ? "engine_failure"
        : "completed");
  const errors =
    terminalReason === "engine_failure"
      ? [
          {
            code: "qmmm_fixture_engine_failure",
            severity: "error" as const,
            message: "Synthetic nonzero exit",
            sourceEvidenceRefs: [source.evidenceRef],
          },
        ]
      : [];
  const stageBase = {
    schemaVersion: MdStageResultSchemaVersion,
    id: "stage-result-qmmm",
    revision: 1,
    missionId: protocolValue.missionId,
    workUnitId: "work-unit-qmmm",
    operationId: "operation-qmmm",
    operationReceiptId: "operation-receipt-qmmm",
    protocolId: protocolValue.parentMdProtocol.id,
    protocolRevision: protocolValue.parentMdProtocol.revision,
    protocolDigest: protocolValue.parentMdProtocol.digest,
    stageId: "stage-qmmm-minimization",
    stageRevision: 1,
    stageDigest: DIGEST("f"),
    stageKind: "minimization" as const,
    terminalReason,
    exitCode,
    signal,
    startedAt: TIMESTAMP,
    finishedAt: "2026-08-30T12:01:00.000Z",
    startStep: 0,
    endStep: 5,
    startTimePs: 0,
    endTimePs: 0,
    engine: {
      engine: "amber" as const,
      executable: "sander",
      version: "AmberTools 26.0",
      buildDigest: DIGEST("8"),
      environmentDigest: DIGEST("9"),
      compatibilityVersion: "1.0.0",
    },
    artifacts: [artifact("restart", "7"), source, artifact("mdinfo", "6")],
    warnings: [],
    errors,
    validationStatus: "not_run" as const,
    validationRefs: [],
  };
  const stageResult = {
    ...stageBase,
    resultDigest: computeMdStageResultDigest(stageBase),
  };
  return {
    schemaVersion: AmberQmmmParseSchemaVersion,
    missionId: protocolValue.missionId,
    source,
    stageResult,
    protocol: protocolValue,
    parserVersion: "1.0.0",
    executionCompletion: overrides.executionCompletion ?? "confirmed",
    operationReceiptRef: "operation-receipt-qmmm",
  };
}

function authorityEvidence(requestValue: AmberQmmmParseRequest) {
  const actor = {
    id: "scientific-reviewer-qmmm",
    kind: "human" as const,
    displayName: "QM/MM reviewer fixture",
    role: "scientific-reviewer",
  };
  const policyDigest = DIGEST("4");
  const approval = {
    id: requestValue.protocol.approvedByRef!,
    missionId: requestValue.missionId,
    subjectType: "qmmm_protocol" as const,
    subjectId: requestValue.protocol.id,
    subjectVersion: 1,
    subjectRevision: requestValue.protocol.revision,
    state: "approved" as const,
    requestedFromRole: "scientific-reviewer",
    payloadDigest: requestValue.protocol.protocolDigest,
    policyDigest,
    editableFields: [],
    requestedBy: { ...actor, kind: "service" as const, id: "eigengrid-head" },
    requestedAt: TIMESTAMP,
    response: {
      id: "approval-response-qmmm",
      approvalRequestId: requestValue.protocol.approvedByRef!,
      decision: "approved" as const,
      actor,
      role: "scientific-reviewer",
      reason: "Fixture authority for deterministic parser qualification",
      subjectVersion: 1,
      subjectRevision: requestValue.protocol.revision,
      payloadDigest: requestValue.protocol.protocolDigest,
      policyDigest,
      decidedAt: TIMESTAMP,
    },
  };
  const externalIdentity = {
    stageResultId: requestValue.stageResult.id,
    stageResultDigest: requestValue.stageResult.resultDigest,
    sourceArtifactId: requestValue.source.artifactId,
    sourceContentDigest: requestValue.source.contentDigest,
  };
  const operationReceipt = {
    id: requestValue.stageResult.operationReceiptId,
    operationId: requestValue.stageResult.operationId,
    requestDigest: DIGEST("5"),
    status:
      requestValue.executionCompletion === "unconfirmed"
        ? ("ambiguous" as const)
        : requestValue.stageResult.terminalReason === "completed"
          ? ("confirmed" as const)
          : ("failed" as const),
    externalIdentity,
    detailDigest: digestCanonical(externalIdentity),
    recordedAt: TIMESTAMP,
  };
  return { approval, operationReceipt };
}

async function authorizedParse(content: string, requestValue: AmberQmmmParseRequest) {
  const authority = await authorizeAmberQmmmParse(requestValue, authorityEvidence(requestValue), {
    async verify() {
      return {
        approvalRecordDigest: DIGEST("a"),
        operationReceiptRecordDigest: DIGEST("b"),
      };
    },
  });
  return parseAmberQmmmMdout(content, requestValue, authority);
}

function qmmmOutput(
  options: {
    theory?: string;
    charge?: number;
    spin?: number;
    atomIndices?: number[];
    cycleLimit?: boolean;
    terminal?: boolean;
    extra?: string;
  } = {},
): string {
  const theory = options.theory ?? "PM3";
  const atomIndices = options.atomIndices ?? [1, 2, 3];
  const coordinateRows = atomIndices
    .map(
      (atomIndex, index) =>
        `  QMMM:     ${index + 1}        ${atomIndex}      H        0.0000    0.0000    0.0000`,
    )
    .join("\n");
  return [
    "QMMM options:",
    `             ifqnt = True       nquant =        ${atomIndices.length}`,
    `              qmgb =        0  qmcharge =        ${options.charge ?? 0}   adjust_q =        2`,
    `              spin =        ${options.spin ?? 1}     qmcut = 999.0000    qmshake =        1`,
    "          qmmm_int =        1",
    "     lnk_atomic_no =        1   lnk_dis =   1.0900 lnk_method =        1",
    `          qm_theory =     ${theory} verbosity =        0`,
    "            qmqmdx = Analytical",
    "      tight_p_conv = False (converge density to 0.05xSqrt[SCFCRT])",
    "           scfconv = 0.100E-07  itrmax =     1000",
    "      printcharges = False      printdipole = False      peptide_corr = False",
    "    qmmmrij_incore = True",
    "  qmqm_erep_incore = True",
    "       pseudo_diag = True pseudo_diag_criteria =   0.0500",
    "      diag_routine =        0",
    "          qm_ewald =        0 qm_pme = False",
    "--------------------------------------------------------------------------------",
    "QMMM: nlink =     0",
    "  QMMM: QM Region Cartesian Coordinates (*=link atom)",
    "  QMMM: QM_NO.   MM_NO.  ATOM         X         Y         Z",
    coordinateRows,
    "--------------------------------------------------------------------------------",
    "   4.  RESULTS",
    "   NSTEP       ENERGY          RMS            GMAX         NAME    NUMBER",
    "      1      -5.3164E+01     6.3760E+00     1.2344E+01     O           1",
    " PM3ESCF =      -53.1640",
    "      5      -5.3349E+01     7.1821E-01     1.2996E+00     H2          3",
    " PM3ESCF =      -53.3490",
    options.cycleLimit === false ? "" : "Maximum number of minimization cycles reached.",
    "FINAL RESULTS",
    "   NSTEP       ENERGY          RMS            GMAX         NAME    NUMBER",
    "      5      -5.3349E+01     7.1821E-01     1.2996E+00     H2          3",
    " PM3ESCF =      -53.3490",
    options.extra ?? "",
    options.terminal === false ? "" : "5. TIMINGS",
    "",
  ].join("\n");
}

describe("authority-bound AMBER QM/MM parsing", () => {
  test("labels the real all-QM module boundary and escalates a cycle-limited minimization", async () => {
    const content = qmmmOutput();
    const result = await authorizedParse(content, request(content));

    expect(result.regionSelectionClass).toBe("all_qm_engine_check");
    expect(result.status).toBe("nonconverged");
    expect(result.minimizationCycleLimit).toBe("reached");
    expect(result.qmScfStatus).toBe("no_failure_reported");
    expect(result.observations).toMatchObject({
      theory: "PM3",
      qmCharge: 0,
      spinMultiplicity: 1,
      qmAtomCount: 3,
      qmAtomIndices: [1, 2, 3],
      linkAtomCount: 0,
      scfConvergenceTolerance: 1e-8,
      maximumScfIterations: 1000,
    });
    expect(result.bindingChecks.every((item) => item.status === "matched")).toBe(true);
    expect(result.energySamples).toHaveLength(2);
    expect(result.energySamples[1]?.qmEnergyKcalMol).toBe(-53.349);
    expect(result.scientificAssessmentEligible).toBe(false);
    expect(result.requiresEscalation).toBe(true);
    expect(result.automaticScientificCorrectionAllowed).toBe(false);
    expect(assertAmberQmmmParseResult(result)).toEqual(result);
  });

  test("allows a separate assessment only after exact controls and normal completion", async () => {
    const content = qmmmOutput({ cycleLimit: false });
    const result = await authorizedParse(content, request(content));
    expect(result.status).toBe("completed");
    expect(result.minimizationCycleLimit).toBe("not_reached");
    expect(result.scientificAssessmentEligible).toBe(true);
    expect(result.requiresEscalation).toBe(false);
  });

  test("rejects forged charge, theory, atom mapping, and embedded-input decoys", async () => {
    const content = [
      "Here is the input file: qmcharge=0 qm_theory=PM3 nquant=3",
      qmmmOutput({ theory: "AM1", charge: 1, atomIndices: [1, 2] }),
    ].join("\n");
    const result = await authorizedParse(content, request(content));
    expect(result.status).toBe("authority_mismatch");
    expect(
      result.bindingChecks.filter((item) => item.status === "mismatched").map((item) => item.field),
    ).toEqual(expect.arrayContaining(["theory", "qm_charge", "qm_atom_count", "qm_atom_indices"]));
    expect(result.scientificAssessmentEligible).toBe(false);
  });

  test("fails closed on stale protocol authority, source bytes, and unconfirmed completion", async () => {
    const content = qmmmOutput({ cycleLimit: false });
    const valid = request(content);
    const draft = {
      ...valid,
      protocol: { ...valid.protocol, status: "draft" as const, approvedByRef: undefined },
    };
    await expect(
      authorizeAmberQmmmParse(draft, authorityEvidence(valid), {
        async verify() {
          throw new Error("must not reach host validator");
        },
      }),
    ).rejects.toThrow(/exactly approved/u);
    await expect(
      authorizeAmberQmmmParse(
        {
          ...valid,
          stageResult: { ...valid.stageResult, stageId: "stale-stage" },
        },
        authorityEvidence(valid),
        {
          async verify() {
            throw new Error("must not reach host validator");
          },
        },
      ),
    ).rejects.toThrow();

    const changedBytes = `${content}\nchanged`;
    const mismatched = await authorizedParse(changedBytes, valid);
    expect(mismatched.status).toBe("authority_mismatch");
    expect(mismatched.diagnostics.map((item) => item.code)).toContain("source_digest_mismatch");

    const unconfirmedRequest = request(content, {
      executionCompletion: "unconfirmed",
      exitCode: null,
      terminalReason: "ambiguous",
    });
    const unconfirmed = await authorizedParse(content, unconfirmedRequest);
    expect(unconfirmed.status).toBe("partial");
    expect(unconfirmed.scientificAssessmentEligible).toBe(false);
  });

  test("requires genuine durable approval and receipt authority plus the exact parser version", async () => {
    const content = qmmmOutput({ cycleLimit: false });
    const valid = request(content);
    const authority = await authorizeAmberQmmmParse(valid, authorityEvidence(valid), {
      async verify() {
        return {
          approvalRecordDigest: DIGEST("a"),
          operationReceiptRecordDigest: DIGEST("b"),
        };
      },
    });
    expect(() =>
      parseAmberQmmmMdout(content, valid, {
        bindingDigest: authority.bindingDigest,
        authorityDigest: authority.authorityDigest,
      }),
    ).toThrow(/genuine host-validated/u);

    const forgedApproval = authorityEvidence(valid);
    forgedApproval.approval.id = "approval-forged";
    await expect(
      authorizeAmberQmmmParse(valid, forgedApproval, {
        async verify() {
          throw new Error("must not reach host validator");
        },
      }),
    ).rejects.toThrow(/approval/u);
    const forgedReceipt = authorityEvidence(valid);
    forgedReceipt.operationReceipt.id = "receipt-forged";
    await expect(
      authorizeAmberQmmmParse(valid, forgedReceipt, {
        async verify() {
          throw new Error("must not reach host validator");
        },
      }),
    ).rejects.toThrow(/receipt/u);
    await expect(
      authorizeAmberQmmmParse({ ...valid, parserVersion: "99.0.0" }, authorityEvidence(valid), {
        async verify() {
          throw new Error("must not reach host validator");
        },
      }),
    ).rejects.toThrow();
    expect((await authorizedParse(content, valid)).parserVersion).toBe(AmberQmmmParserVersion);
    expect(AmberQmmmQualifiedEngine).toEqual({
      engine: "amber",
      executable: "sander",
      version: "AmberTools 26.0",
      compatibilityVersion: "1.0.0",
      rendererCompatibilityVersion: "1.0.0",
    });
  });

  test("rejects engines and renderers outside the exact qualified parser envelope", async () => {
    const content = qmmmOutput({ cycleLimit: false });
    const valid = request(content);
    for (const engine of [
      { ...valid.stageResult.engine, engine: "not-amber" },
      { ...valid.stageResult.engine, executable: "not-amber-at-all" },
      { ...valid.stageResult.engine, version: "Unqualified Engine 999" },
      { ...valid.stageResult.engine, compatibilityVersion: "99.0.0" },
    ]) {
      const stageBase = { ...valid.stageResult, engine };
      const stageResult = {
        ...stageBase,
        resultDigest: computeMdStageResultDigest(stageBase),
      };
      await expect(
        authorizeAmberQmmmParse(
          { ...valid, stageResult },
          authorityEvidence({ ...valid, stageResult }),
          {
            async verify() {
              throw new Error("must not reach host validator");
            },
          },
        ),
      ).rejects.toThrow(/qualified only/u);
    }

    const protocolBase = {
      ...valid.protocol,
      rendererCompatibilityVersion: "99.0.0",
    };
    const unqualifiedProtocol = {
      ...protocolBase,
      protocolDigest: computeQmmmProtocolDigest(protocolBase),
    };
    const staleStageBase = {
      ...valid.stageResult,
      protocolDigest: unqualifiedProtocol.parentMdProtocol.digest,
    };
    const staleStage = {
      ...staleStageBase,
      resultDigest: computeMdStageResultDigest(staleStageBase),
    };
    const unqualified = { ...valid, protocol: unqualifiedProtocol, stageResult: staleStage };
    await expect(
      authorizeAmberQmmmParse(unqualified, authorityEvidence(unqualified), {
        async verify() {
          throw new Error("must not reach host validator");
        },
      }),
    ).rejects.toThrow(/qualified only/u);

    const hybridRegionBase = {
      ...valid.protocol.region,
      selectionClass: "hybrid_qm_mm" as const,
      atomMap: { ...valid.protocol.region.atomMap, atomCount: 4 },
    };
    const hybridRegion = {
      ...hybridRegionBase,
      selectionDigest: computeQmmmRegionSelectionDigest(hybridRegionBase),
    };
    const hybridProtocolBase = { ...valid.protocol, region: hybridRegion };
    const hybridProtocol = {
      ...hybridProtocolBase,
      protocolDigest: computeQmmmProtocolDigest(hybridProtocolBase),
    };
    const hybridRequest = { ...valid, protocol: hybridProtocol };
    await expect(
      authorizeAmberQmmmParse(hybridRequest, authorityEvidence(hybridRequest), {
        async verify() {
          throw new Error("must not reach host validator");
        },
      }),
    ).rejects.toThrow(/hybrid coupling remains unqualified/u);
  });

  test("cannot replay ambiguous receipt authority as confirmed execution", async () => {
    const content = qmmmOutput({ cycleLimit: false });
    const ambiguousRequest = request(content, {
      executionCompletion: "unconfirmed",
      exitCode: null,
      terminalReason: "ambiguous",
    });
    const ambiguousAuthority = await authorizeAmberQmmmParse(
      ambiguousRequest,
      authorityEvidence(ambiguousRequest),
      {
        async verify() {
          return {
            approvalRecordDigest: DIGEST("a"),
            operationReceiptRecordDigest: DIGEST("b"),
          };
        },
      },
    );
    const forgedConfirmedRequest = request(content);
    expect(() => parseAmberQmmmMdout(content, forgedConfirmedRequest, ambiguousAuthority)).toThrow(
      /exact authority/u,
    );
    const ambiguous = parseAmberQmmmMdout(content, ambiguousRequest, ambiguousAuthority);
    expect(ambiguous.status).toBe("partial");
    expect(ambiguous.scientificAssessmentEligible).toBe(false);
  });

  test("binds terminal failures to failed receipts and rejects success receipts", async () => {
    const content = qmmmOutput({ cycleLimit: false });
    const failedRequest = request(content, {
      exitCode: 2,
      terminalReason: "engine_failure",
    });
    const evidence = authorityEvidence(failedRequest);
    expect(evidence.operationReceipt.status).toBe("failed");
    const parsed = await authorizedParse(content, failedRequest);
    expect(parsed.status).toBe("nonzero_exit");

    const forgedSuccess = authorityEvidence(failedRequest);
    forgedSuccess.operationReceipt.status = "confirmed";
    await expect(
      authorizeAmberQmmmParse(failedRequest, forgedSuccess, {
        async verify() {
          throw new Error("must not reach host validator");
        },
      }),
    ).rejects.toThrow(/operation receipt/u);
  });

  test("classifies SCF failure, nonzero exit, unsupported embedding, and missing output", async () => {
    const scfContent = qmmmOutput({
      cycleLimit: false,
      extra: "QMMM SCF convergence failure: Unable to achieve self consistency",
    });
    const scf = await authorizedParse(scfContent, request(scfContent));
    expect(scf.status).toBe("fatal");
    expect(scf.qmScfStatus).toBe("failed");

    const failedContent = qmmmOutput({ cycleLimit: false });
    const failed = await authorizedParse(
      failedContent,
      request(failedContent, { exitCode: 2, terminalReason: "engine_failure" }),
    );
    expect(failed.status).toBe("nonzero_exit");

    const baseProtocol = protocol();
    const mechanicalBase = {
      ...baseProtocol,
      embedding: { ...baseProtocol.embedding, mode: "mechanical" as const },
    };
    const mechanical = {
      ...mechanicalBase,
      protocolDigest: computeQmmmProtocolDigest(mechanicalBase),
    };
    const unsupported = await authorizedParse(
      failedContent,
      request(failedContent, { protocol: mechanical }),
    );
    expect(unsupported.status).toBe("unsupported_protocol");
    expect(unsupported.requiresEscalation).toBe(true);

    const empty = "";
    const emptyResult = await authorizedParse(empty, request(empty));
    expect(emptyResult.status).toBe("authority_mismatch");
    expect(emptyResult.bindingChecks.some((item) => item.status === "not_observed")).toBe(true);
  });

  test("rejects incomplete, duplicated, out-of-order, and malformed runtime evidence", async () => {
    const valid = qmmmOutput({ cycleLimit: false });

    const withoutResults = valid.replace(
      /\s*4\.\s+RESULTS[\s\S]*?FINAL RESULTS/u,
      "\nFINAL RESULTS",
    );
    const missingResults = await authorizedParse(withoutResults, request(withoutResults));
    expect(missingResults.status).toBe("authority_mismatch");
    expect(missingResults.terminalMarkerObserved).toBe(true);
    expect(missingResults.diagnostics.map((item) => item.code)).toContain("qmmm_section_integrity");

    const optionsEnd = valid.indexOf("QMMM: nlink");
    const duplicatedOptions = `${valid.slice(0, optionsEnd)}${valid}`;
    const duplicateResult = await authorizedParse(duplicatedOptions, request(duplicatedOptions));
    expect(duplicateResult.status).toBe("authority_mismatch");
    expect(duplicateResult.diagnostics.map((item) => item.code)).toContain(
      "qmmm_section_integrity",
    );
    expect(duplicateResult.diagnostics.map((item) => item.code)).toContain(
      "qmmm_duplicate_control",
    );

    const malformedBoolean = valid.replace("qm_pme = False", "qm_pme = BANANA");
    const invalidBoolean = await authorizedParse(malformedBoolean, request(malformedBoolean));
    expect(invalidBoolean.status).toBe("authority_mismatch");
    expect(invalidBoolean.observations.qmPme).toBeNull();
    expect(invalidBoolean.diagnostics.map((item) => item.code)).toContain("qmmm_invalid_control");

    const duplicateFinal = valid.replace("FINAL RESULTS", "FINAL RESULTS\nFINAL RESULTS");
    const invalidOrder = await authorizedParse(duplicateFinal, request(duplicateFinal));
    expect(invalidOrder.status).toBe("authority_mismatch");
    expect(invalidOrder.scientificAssessmentEligible).toBe(false);
  });

  test("rejects duplicate numeric, token, and boolean controls on one physical line", async () => {
    const valid = qmmmOutput({ cycleLimit: false });
    const variants = [
      valid.replace("ifqnt = True", "ifqnt = True ifqnt = False"),
      valid.replace("ifqnt = True", "ifqnt = True ifqnt ="),
      valid.replace("qmgb =        0", "qmgb = 0 qmgb = 9"),
      valid.replace("qmgb =        0", "qmgb = 0 qmgb ="),
      valid.replace("qmcharge =        0", "qmcharge = 0 qmcharge = 1"),
      valid.replace("qmcharge =        0", "qmcharge = 0 qmcharge ="),
      valid.replace("qm_theory =     PM3", "qm_theory = PM3 qm_theory = AM1"),
      valid.replace("qm_theory =     PM3", "qm_theory = PM3 qm_theory = ''"),
      valid.replace("qm_pme = False", "qm_pme = False qm_pme = True"),
      valid.replace("qm_pme = False", "qm_pme = False qm_pme ="),
    ];
    for (const content of variants) {
      const result = await authorizedParse(content, request(content));
      expect(result.status).toBe("authority_mismatch");
      expect(result.scientificAssessmentEligible).toBe(false);
      expect(result.diagnostics.map((item) => item.code)).toContain("qmmm_duplicate_control");
    }
  });

  test("rejects non-Fortran numeric spellings even when JavaScript would coerce them", async () => {
    const valid = qmmmOutput({ cycleLimit: false });
    for (const [decimal, hostile] of [
      [/nquant\s*=\s*3/u, "nquant = 0x3"],
      [/qmgb\s*=\s*0/u, "qmgb = 0x0"],
      [/qmcharge\s*=\s*0/u, "qmcharge = 0x0"],
      [/spin\s*=\s*1/u, "spin = 0x1"],
      [/qmcut\s*=\s*999\.0000/u, "qmcut = 0x3e7"],
      [/qmmm_int\s*=\s*1/u, "qmmm_int = 0x1"],
      [/itrmax\s*=\s*1000/u, "itrmax = 0x3e8"],
      [/qm_ewald\s*=\s*0/u, "qm_ewald = 0x0"],
    ] as const) {
      const hostileContent = valid.replace(decimal, hostile);
      const parsed = await authorizedParse(hostileContent, request(hostileContent));
      expect(parsed.status).toBe("authority_mismatch");
      expect(parsed.scientificAssessmentEligible).toBe(false);
      expect(parsed.diagnostics.map((item) => item.code)).toContain("qmmm_invalid_control");
    }
  });

  test("rejects malformed quoted controls, link counts, coordinates, and duplicate energies", async () => {
    const valid = qmmmOutput({ cycleLimit: false });
    for (const hostileContent of [
      valid.replace("qm_theory =     PM3", "qm_theory =     'PM3"),
      valid.replace("qm_theory =     PM3", "qm_theory =     PM3'"),
      `${valid.replace("QMMM: nlink =     0", "QMMM: nlink = 0\nQMMM: nlink = BANANA")}`,
      `${valid.replace("QMMM: nlink =     0", "QMMM: nlink = 0\nQMMM: nlink =")}`,
      valid.replace("PM3ESCF =      -53.1640", "PM3ESCF = -53.164 PM3ESCF = -999"),
      valid.replace("PM3ESCF =      -53.1640", "PM3ESCF = -53.164 AM1ESCF = -999"),
      valid.replace(
        "      1      -5.3164E+01     6.3760E+00     1.2344E+01     O           1",
        "      1      -5.3164E+01     6.3760E+00     1.2344E+01     O           1\n" +
          "      2      NaN             1.0000E+00     1.0000E+00     H           2",
      ),
      valid.replace(
        "  QMMM:     3        3      H        0.0000    0.0000    0.0000",
        "  QMMM:     3        3      H        0.0000    0.0000    0.0000\n" +
          "  QMMM:     4        4      H        NaN       0.0000    0.0000",
      ),
      valid.replace(/FINAL RESULTS\n[\s\S]*?\n PM3ESCF =      -53\.3490/u, "FINAL RESULTS"),
      valid.replace(
        "      5      -5.3349E+01     7.1821E-01     1.2996E+00     H2          3\n" +
          " PM3ESCF =      -53.3490\n\n5. TIMINGS",
        "      5       9.9999E+99     7.1821E-01     1.2996E+00     H2        999\n" +
          " AM1ESCF =       9.9999E+99\n\n5. TIMINGS",
      ),
    ]) {
      const parsed = await authorizedParse(hostileContent, request(hostileContent));
      expect(parsed.status).toBe("authority_mismatch");
      expect(parsed.scientificAssessmentEligible).toBe(false);
    }
  });

  test("refuses assessment when durable stage validation or normalized errors failed", async () => {
    const content = qmmmOutput({ cycleLimit: false });
    const valid = request(content);
    for (const stageUpdates of [
      { validationStatus: "failed" as const },
      {
        errors: [
          {
            code: "durable_stage_fatal",
            severity: "fatal" as const,
            message: "Durable stage validation recorded a fatal condition",
            sourceEvidenceRefs: [valid.source.evidenceRef],
          },
        ],
      },
    ]) {
      const { resultDigest: _resultDigest, ...stageWithoutDigest } = valid.stageResult;
      const stageBase = { ...stageWithoutDigest, ...stageUpdates };
      const stageResult = {
        ...stageBase,
        resultDigest: computeMdStageResultDigest(stageBase),
      };
      const hostileRequest = { ...valid, stageResult };
      const parsed = await authorizedParse(content, hostileRequest);
      expect(parsed.status).toBe("fatal");
      expect(parsed.scientificAssessmentEligible).toBe(false);
      expect(parsed.diagnostics.map((item) => item.code)).toContain("qmmm_stage_result_failure");
    }
  });

  test("binds the complete AmberTools 26 all-QM calculation-control envelope", async () => {
    const valid = qmmmOutput({ cycleLimit: false });
    for (const hostileContent of [
      valid.replace("qmshake =        1", "qmshake =        0"),
      valid.replace("tight_p_conv = False", "tight_p_conv = True"),
      valid.replace(
        "pseudo_diag = True pseudo_diag_criteria =   0.0500",
        "pseudo_diag = False pseudo_diag_criteria =   0.9990",
      ),
      valid.replace("peptide_corr = False", "peptide_corr = True"),
      valid.replace("qmqmdx = Analytical", "qmqmdx = Numerical"),
      valid.replace("adjust_q =        2", "adjust_q =        1"),
      valid.replace("diag_routine =        0", "diag_routine =        1"),
      valid.replace("      tight_p_conv = False (converge density to 0.05xSqrt[SCFCRT])\n", ""),
    ]) {
      const parsed = await authorizedParse(hostileContent, request(hostileContent));
      expect(parsed.status).toBe("authority_mismatch");
      expect(parsed.scientificAssessmentEligible).toBe(false);
      expect(parsed.bindingChecks.some((check) => check.status !== "matched")).toBe(true);
    }
  });

  test("binds the QM enable flag, energy method, exact steps, and finite coordinates", async () => {
    const valid = qmmmOutput({ cycleLimit: false });
    const variants = [
      valid.replace("ifqnt = True", "ifqnt = False"),
      valid.replace("ifqnt = True", "ifqnt = BANANA"),
      valid.replace("qmgb =        0", "qmgb = 9"),
      valid.replace("qmgb =        0", "qmgb = BANANA"),
      valid.replaceAll("PM3ESCF", "AM1ESCF"),
      valid.replace("PM3ESCF =      -53.1640", "PM3ESCF = -53.1640\n PM3ESCF = -999"),
      valid.replace("      5      -5.3349E+01", "    999      -5.3349E+01"),
      valid.replace("      5      -5.3349E+01", "      1      -5.3349E+01"),
      valid.replace("H2          3", "H2        999"),
      valid.replace("H        0.0000", "H        E"),
    ];
    for (const content of variants) {
      const result = await authorizedParse(content, request(content));
      expect(result.status).toBe("authority_mismatch");
      expect(result.scientificAssessmentEligible).toBe(false);
      expect(result.diagnostics.some((item) => item.severity === "fatal")).toBe(true);
    }
  });

  test("rejects self-digested completed objects that lack completion evidence", async () => {
    const content = qmmmOutput({ cycleLimit: false });
    const valid = await authorizedParse(content, request(content));
    const forgedBase = {
      ...valid,
      terminalMarkerObserved: false,
      qmScfStatus: "failed" as const,
      minimizationCycleLimit: "reached" as const,
      observations: {
        ...valid.observations,
        theory: null,
        qmAtomIndices: [],
      },
      energySamples: [],
      diagnostics: [],
    };
    expect(() =>
      assertAmberQmmmParseResult({
        ...forgedBase,
        parseDigest: digestCanonical(
          Object.fromEntries(Object.entries(forgedBase).filter(([key]) => key !== "parseDigest")),
        ),
      }),
    ).toThrow(/Completed QM\/MM parsing requires/u);

    const duplicateBindingBase = {
      ...valid,
      bindingChecks: valid.bindingChecks.map((check) =>
        check.field === "qm_charge" ? { ...check, field: "theory" as const } : check,
      ),
    };
    expect(() =>
      assertAmberQmmmParseResult({
        ...duplicateBindingBase,
        parseDigest: digestCanonical(
          Object.fromEntries(
            Object.entries(duplicateBindingBase).filter(([key]) => key !== "parseDigest"),
          ),
        ),
      }),
    ).toThrow(/each exact material binding check once/u);

    const hybridResultBase = {
      ...valid,
      regionSelectionClass: "hybrid_qm_mm",
    };
    expect(() =>
      assertAmberQmmmParseResult({
        ...hybridResultBase,
        parseDigest: digestCanonical(
          Object.fromEntries(
            Object.entries(hybridResultBase).filter(([key]) => key !== "parseDigest"),
          ),
        ),
      }),
    ).toThrow();
  });

  test("uses fail-closed status precedence for contradictory evidence", async () => {
    const normal = qmmmOutput({ cycleLimit: false });
    const baseProtocol = protocol();
    const unsupportedBase = {
      ...baseProtocol,
      embedding: { ...baseProtocol.embedding, mode: "mechanical" as const },
    };
    const unsupportedProtocol = {
      ...unsupportedBase,
      protocolDigest: computeQmmmProtocolDigest(unsupportedBase),
    };
    const nonzero = await authorizedParse(
      normal,
      request(normal, {
        protocol: unsupportedProtocol,
        exitCode: 9,
        terminalReason: "engine_failure",
      }),
    );
    expect(nonzero.status).toBe("nonzero_exit");

    const fatalContent = qmmmOutput({
      cycleLimit: false,
      extra: "QMMM SCF convergence failure: Unable to achieve self consistency",
    });
    const fatal = await authorizedParse(
      fatalContent,
      request(fatalContent, { protocol: unsupportedProtocol }),
    );
    expect(fatal.status).toBe("fatal");

    const sourceBound = request(normal);
    const changedBytes = `${normal}\nforged trailing output`;
    const sourceMismatch = await authorizedParse(changedBytes, sourceBound);
    expect(sourceMismatch.status).toBe("authority_mismatch");
  });
});
