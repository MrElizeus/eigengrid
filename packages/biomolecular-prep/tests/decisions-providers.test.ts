import { describe, expect, test } from "bun:test";
import {
  createScientificProposal,
  sha256Digest,
  validateConformerGenerationSpec,
  type ImportedPoseProvider,
  type PoseProviderRequest,
} from "../src/index";

const encoder = new TextEncoder();
const digest = sha256Digest(encoder.encode("fixture"));

describe("scientific proposals and provider boundaries", () => {
  test("proposal construction can only produce proposed, approval-required state", () => {
    const proposal = createScientificProposal({
      proposalId: "construct-proposal-1",
      revision: 1,
      kind: "construct_policy",
      evidenceRefs: [{ evidenceId: "evidence-1", digest }],
      rationale: "Synthetic test proposal; a reviewer must decide.",
      payload: { preserveFusion: true },
    });

    expect(proposal.status).toBe("proposed");
    expect(proposal.approvalRequired).toBe(true);
    expect(proposal).not.toHaveProperty("approvedBy");
  });

  test("conformer specs require an explicit deterministic seed and software version", () => {
    expect(
      validateConformerGenerationSpec({
        componentId: "ligand",
        algorithm: "fixture-embedder",
        software: "fixture",
        softwareVersion: "1.0.0",
        seed: 42,
        requestedConformerCount: 10,
        inputMicrostateRef: { evidenceId: "microstate-1", digest },
      }),
    ).toEqual([]);
    expect(
      validateConformerGenerationSpec({
        componentId: "ligand",
        algorithm: "fixture-embedder",
        software: "fixture",
        softwareVersion: "",
        seed: Number.NaN,
        requestedConformerCount: 0,
        inputMicrostateRef: { evidenceId: "microstate-1", digest },
      }),
    ).toHaveLength(3);
  });

  test("pose generation is an injected interface and selection remains approval-gated", async () => {
    const provider: ImportedPoseProvider = {
      method: "imported",
      providerId: "synthetic-import-provider",
      providerVersion: "1.0.0",
      async propose(request: PoseProviderRequest) {
        return {
          requestId: request.requestId,
          providerId: this.providerId,
          providerVersion: this.providerVersion,
          candidates: [
            {
              candidateId: "pose-1",
              method: "imported",
              coordinateDigest: digest,
              atomMapDigest: digest,
              parentRefs: [request.receptorRef],
              scoreClaims: {},
              warnings: ["synthetic test candidate"],
            },
          ],
          selectionRequiresApproval: true,
        };
      },
    };
    const request: PoseProviderRequest = {
      requestId: "request-1",
      expectedSystemRevision: 1,
      receptorRef: { evidenceId: "receptor", digest },
      ligandConformerRefs: [{ evidenceId: "ligand", digest }],
      pocketDefinitionRef: { evidenceId: "pocket", digest },
      maximumCandidates: 1,
    };

    const result = await provider.propose(request);
    expect(result.selectionRequiresApproval).toBe(true);
    expect(result.candidates[0]?.method).toBe("imported");
  });
});
