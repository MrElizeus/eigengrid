import type { MyrmexOperationReceipt, PublicSubject } from "@eigengrid/protocol";

import {
  type ApprovedAuthorityEvidence,
  type ApprovedMyrmexProfileCallOptions,
  type MyrmexProfile,
} from "./profile";
import { UpgradeTargetSchema, type UpgradeTarget } from "./operations";

export type UpgradeFlowStage =
  | "compatibility"
  | "backup"
  | "maintenance-enter"
  | "apply"
  | "verify"
  | "promote"
  | "rollback"
  | "maintenance-exit";

export interface UpgradeFlowReceipt {
  readonly stage: UpgradeFlowStage;
  readonly receipt: MyrmexOperationReceipt;
}

export interface UpgradeFlowRequest {
  readonly flowId: string;
  readonly runId: string;
  readonly subject: PublicSubject;
  readonly target: UpgradeTarget;
  readonly authorityEvidence: ApprovedAuthorityEvidence;
  readonly rollbackOnFailure?: boolean;
  readonly signal?: AbortSignal;
}

export interface UpgradeFlowResult {
  readonly outcome: "promoted" | "rolled_back" | "stopped";
  readonly receipts: readonly UpgradeFlowReceipt[];
}

export async function runApprovedUpgradeFlow(
  profile: MyrmexProfile,
  input: UpgradeFlowRequest,
): Promise<UpgradeFlowResult> {
  if (!input.flowId || input.flowId.length > 180) {
    throw new RangeError("Upgrade flowId must contain 1-180 characters");
  }
  const target = UpgradeTargetSchema.parse(input.target);
  const receipts: UpgradeFlowReceipt[] = [];
  const options = (stage: UpgradeFlowStage): ApprovedMyrmexProfileCallOptions => ({
    idempotencyKey: `${input.flowId}:${stage}`,
    runId: input.runId,
    authorityEvidence: input.authorityEvidence,
    signal: input.signal,
  });
  const record = (stage: UpgradeFlowStage, receipt: MyrmexOperationReceipt) => {
    receipts.push(Object.freeze({ stage, receipt }));
    return receipt.state === "confirmed";
  };

  if (
    !record(
      "compatibility",
      await profile.validateUpgrade(input.subject, target, options("compatibility")),
    )
  ) {
    return result("stopped", receipts);
  }
  if (
    !record(
      "backup",
      await profile.createBackup(
        input.subject,
        {
          restorePointId: target.restorePointId,
          purpose: "upgrade",
          targetArtifactDigest: target.artifactDigest,
        },
        options("backup"),
      ),
    )
  ) {
    return result("stopped", receipts);
  }
  if (
    !record(
      "maintenance-enter",
      await profile.setMaintenanceMode(
        input.subject,
        { mode: "enter", changeId: input.flowId },
        options("maintenance-enter"),
      ),
    )
  ) {
    return result("stopped", receipts);
  }

  const applied = await profile.applyUpgrade(input.subject, target, options("apply"));
  if (!record("apply", applied)) {
    return await stopAfterMaintenance(profile, input, target, receipts, applied.state);
  }

  const verified = await profile.verifyUpgrade(input.subject, target, options("verify"));
  if (!record("verify", verified)) {
    return await stopAfterMaintenance(profile, input, target, receipts, verified.state);
  }

  const promoted = await profile.promoteUpgrade(input.subject, target, options("promote"));
  if (!record("promote", promoted)) {
    return await stopAfterMaintenance(profile, input, target, receipts, promoted.state);
  }

  const maintenanceExit = await profile.setMaintenanceMode(
    input.subject,
    { mode: "exit", changeId: input.flowId },
    options("maintenance-exit"),
  );
  if (!record("maintenance-exit", maintenanceExit)) return result("stopped", receipts);
  return result("promoted", receipts);
}

async function stopAfterMaintenance(
  profile: MyrmexProfile,
  input: UpgradeFlowRequest,
  target: UpgradeTarget,
  receipts: UpgradeFlowReceipt[],
  failedState: MyrmexOperationReceipt["state"],
): Promise<UpgradeFlowResult> {
  if (failedState === "failed" && input.rollbackOnFailure) {
    const rollback = await profile.rollbackUpgrade(input.subject, target, {
      idempotencyKey: `${input.flowId}:rollback`,
      runId: input.runId,
      authorityEvidence: input.authorityEvidence,
      signal: input.signal,
    });
    receipts.push(Object.freeze({ stage: "rollback", receipt: rollback }));
    if (rollback.state !== "confirmed") return result("stopped", receipts);

    const exit = await profile.setMaintenanceMode(
      input.subject,
      { mode: "exit", changeId: input.flowId },
      {
        idempotencyKey: `${input.flowId}:maintenance-exit`,
        runId: input.runId,
        authorityEvidence: input.authorityEvidence,
        signal: input.signal,
      },
    );
    receipts.push(Object.freeze({ stage: "maintenance-exit", receipt: exit }));
    return result(exit.state === "confirmed" ? "rolled_back" : "stopped", receipts);
  }

  // Pending and ambiguous receipts are deliberately not followed by another effect.
  return result("stopped", receipts);
}

function result(
  outcome: UpgradeFlowResult["outcome"],
  receipts: UpgradeFlowReceipt[],
): UpgradeFlowResult {
  return Object.freeze({ outcome, receipts: Object.freeze([...receipts]) });
}
