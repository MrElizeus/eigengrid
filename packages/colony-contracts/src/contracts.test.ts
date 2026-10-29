import { describe, expect, test } from "bun:test";
import {
  AgentWorkResultSchema,
  ContextPackSchema,
  CorrectionOrderSchema,
  VerificationRequestSchema,
  validateCorrectionBinding,
  validateVerificationBinding,
  validateWorkOrderContextBinding,
  validateWorkResultBinding,
} from "./contracts";
import { DIGEST_FIELDS, sealContract, verifyContractDigest } from "./digest";
import { parseColonyContract, parseVerifiedColonyContract } from "./registry";
import {
  SpeciesContractSchema,
  SpeciesIdentitySchema,
  validateSpeciesIdentityBinding,
} from "./species";
import {
  ZERO_DIGEST,
  everyValidContract,
  validContextPack,
  validCorrectionOrder,
  validFailedVerificationResult,
  validSpeciesContract,
  validSpeciesIdentity,
  validVerificationRequest,
  validVerificationResult,
  validWorkOrder,
  validWorkResult,
} from "./test-fixtures";

describe("colony contract runtime schemas", () => {
  test("strictly parses every V1 contract and verifies every self-digest", () => {
    for (const contract of everyValidContract()) {
      const parsed = parseVerifiedColonyContract(contract);
      expect(parsed).toEqual(contract);
      const schema = (contract as { schema: keyof typeof DIGEST_FIELDS }).schema;
      if (DIGEST_FIELDS[schema]) expect(verifyContractDigest(contract)).toBe(true);
    }
  });

  test("rejects unknown properties on every authority-boundary envelope", () => {
    for (const contract of everyValidContract()) {
      expect(() =>
        parseColonyContract({ ...(contract as object), inventedAuthority: true }),
      ).toThrow();
    }
  });

  test("rejects stale canonical digests after otherwise valid content changes", () => {
    for (const contract of everyValidContract()) {
      const schema = (contract as { schema: keyof typeof DIGEST_FIELDS }).schema;
      const digestField = DIGEST_FIELDS[schema];
      if (!digestField) continue;
      const tampered = { ...(contract as Record<string, unknown>), [digestField]: ZERO_DIGEST };
      expect(() => parseVerifiedColonyContract(tampered)).toThrow("Canonical digest mismatch");
    }
  });

  test("keeps trust classes structural and evidence allow-lists closed", () => {
    const pack = validContextPack();
    const mislabeled = {
      ...pack,
      authoritativeFacts: [{ ...pack.authoritativeFacts[0]!, trustClass: "model_hypothesis" }],
    };
    expect(ContextPackSchema.safeParse(mislabeled).success).toBe(false);

    const unknownEvidence = { ...pack, allowedEvidenceIds: [...pack.allowedEvidenceIds, "absent"] };
    expect(ContextPackSchema.safeParse(unknownEvidence).success).toBe(false);
  });

  test("does not accept evidence-free or criterion-failing success", () => {
    const result = validWorkResult();
    expect(AgentWorkResultSchema.safeParse({ ...result, evidence: [] }).success).toBe(false);
    expect(
      AgentWorkResultSchema.safeParse({
        ...result,
        criteria: [{ ...result.criteria[0]!, verdict: "fail" }, ...result.criteria.slice(1)],
      }).success,
    ).toBe(false);
  });

  test("requires effect-free independent verification and exact binding", () => {
    const request = validVerificationRequest();
    const result = validVerificationResult();
    expect(validateVerificationBinding(request, result)).toEqual({ request, result });
    expect(
      VerificationRequestSchema.safeParse({
        ...request,
        budget: { ...request.budget, effects: 1 },
      }).success,
    ).toBe(false);
    expect(() =>
      validateVerificationBinding(
        request,
        sealContract({
          ...result,
          verifierInvocationId: request.writerInvocationId,
          verifierIdentity: {
            ...result.verifierIdentity,
            invocationId: request.writerInvocationId,
          },
        }),
      ),
    ).toThrow("independentInvocation");
  });

  test("binds context, work, result, verification, and correction envelopes fail closed", () => {
    const context = validContextPack();
    const workOrder = validWorkOrder();
    const workResult = validWorkResult();
    const verificationRequest = validVerificationRequest();
    const verificationResult = validVerificationResult();
    const failedVerification = validFailedVerificationResult();
    const correction = validCorrectionOrder();

    expect(validateWorkOrderContextBinding(context, workOrder)).toEqual({ context, workOrder });
    expect(validateWorkResultBinding(workOrder, workResult)).toEqual({
      workOrder,
      result: workResult,
    });
    expect(validateVerificationBinding(verificationRequest, verificationResult)).toEqual({
      request: verificationRequest,
      result: verificationResult,
    });
    expect(
      validateCorrectionBinding(correction, workOrder, workResult, failedVerification),
    ).toEqual({
      correction,
      workOrder,
      workResult,
      verificationResult: failedVerification,
    });

    const staleResult = sealContract({
      ...workResult,
      observedBaseIdentity: { ...workResult.observedBaseIdentity, revision: 8 },
    });
    expect(() => validateWorkResultBinding(workOrder, staleResult)).toThrow("observedBaseIdentity");
    const escapedResult = sealContract({
      ...workResult,
      affectedResources: [
        {
          kind: "mission_object" as const,
          selector: "authoritative:mission",
          access: "candidate_write" as const,
        },
      ],
    });
    expect(() => validateWorkResultBinding(workOrder, escapedResult)).toThrow("notAllowed");
    const overBudgetResult = sealContract({
      ...workResult,
      usage: { ...workResult.usage, inputTokens: workOrder.budget.inputTokens + 1 },
    });
    expect(() => validateWorkResultBinding(workOrder, overBudgetResult)).toThrow(
      "budget:inputTokens",
    );
  });

  test("bounds correction and preserves successful criteria without overlap", () => {
    const correction = validCorrectionOrder();
    expect(
      CorrectionOrderSchema.safeParse({
        ...correction,
        remainingBudget: { ...correction.remainingBudget, corrections: 0 },
      }).success,
    ).toBe(true);
    expect(
      CorrectionOrderSchema.safeParse({
        ...correction,
        preservedSuccess: [
          {
            ...correction.preservedSuccess[0]!,
            criterionId: correction.failedCriteria[0]!.criterionId,
          },
        ],
      }).success,
    ).toBe(false);
  });

  test("binds stable species IDs to their exact major and declared capabilities", () => {
    const identity = validSpeciesIdentity();
    const contract = validSpeciesContract();
    expect(validateSpeciesIdentityBinding(identity, contract)).toEqual({ identity, contract });
    expect(
      SpeciesIdentitySchema.safeParse({
        ...identity,
        coordinate: { ...identity.coordinate, version: "2.0.0" },
      }).success,
    ).toBe(false);
    expect(
      SpeciesContractSchema.safeParse({
        ...contract,
        castes: [
          {
            ...contract.castes[0]!,
            allowedCapabilities: ["undeclared.capability"],
          },
          ...contract.castes.slice(1),
        ],
      }).success,
    ).toBe(false);
    const changedContract = sealContract({ ...contract, displayName: "Changed species" });
    expect(() => validateSpeciesIdentityBinding(identity, changedContract)).toThrow(
      "exact species contract digest",
    );
  });

  test("re-sealing is deterministic and never imports an authorization decision", () => {
    const result = validWorkResult();
    const resealed = sealContract({ ...result, summary: "Updated candidate-only summary" });
    expect(verifyContractDigest(resealed)).toBe(true);
    expect((resealed as typeof result).status).toBe("success");
    expect("approved" in resealed).toBe(false);
  });
});
