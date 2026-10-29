import type { SlurmJobState } from "./types";

const stateMap: Record<SlurmJobState, string> = {
  PENDING: "queued",
  RUNNING: "running",
  COMPLETING: "running",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
  FAILED: "failed",
  TIMEOUT: "failed",
  NODE_FAIL: "failed",
  PREEMPTED: "preempted",
  BOOT_FAIL: "failed",
  OUT_OF_MEMORY: "failed",
  SUSPENDED: "suspended",
  REQUEUED: "requeued",
  RESIZING: "running",
  CONFIGURING: "queued",
  SIGNALING: "running",
  STAGE_OUT: "running",
  STOPPED: "suspended",
  SPECIAL_EXIT: "failed",
  REVOKED: "revoked",
  DEADLINE: "failed",
  RESV_DEL_HOLD: "held",
  REQUEUE_HOLD: "held",
  REQUEUE_FED: "requeued",
  UNKNOWN: "unknown",
};

const terminalStates = new Set<SlurmJobState>([
  "COMPLETED",
  "CANCELLED",
  "FAILED",
  "TIMEOUT",
  "NODE_FAIL",
  "BOOT_FAIL",
  "OUT_OF_MEMORY",
  "PREEMPTED",
  "DEADLINE",
  "SPECIAL_EXIT",
  "REVOKED",
]);

export function mapSlurmState(slurmState: SlurmJobState): string {
  return stateMap[slurmState] ?? "unknown";
}

export function isSlurmTerminal(state: SlurmJobState): boolean {
  return terminalStates.has(state);
}

export function parseSbatchOutput(
  stdout: string,
): { slurmJobId: string; success: boolean } | { success: false; error: string } {
  const trimmed = stdout.trim();

  const parsableMatch = trimmed.match(/^(\d+)(?:;.*)?$/);
  if (parsableMatch?.[1]) {
    return { slurmJobId: parsableMatch[1], success: true };
  }

  const legacyMatch = trimmed.match(/^Submitted batch job\s+(\d+)$/);
  if (legacyMatch?.[1]) {
    return { slurmJobId: legacyMatch[1], success: true };
  }

  return { success: false, error: `Unable to parse sbatch output: ${trimmed || "<empty>"}` };
}

export function parseSqueueState(stdout: string): SlurmJobState {
  const state = stdout.trim().toUpperCase();

  switch (state) {
    case "PD":
      return "PENDING";
    case "R":
      return "RUNNING";
    case "CG":
      return "COMPLETING";
    case "CD":
      return "COMPLETED";
    case "CA":
      return "CANCELLED";
    case "F":
      return "FAILED";
    case "TO":
      return "TIMEOUT";
    case "NF":
      return "NODE_FAIL";
    case "PR":
      return "PREEMPTED";
    case "BF":
      return "BOOT_FAIL";
    case "OOM":
      return "OUT_OF_MEMORY";
    case "S":
      return "SUSPENDED";
    case "RS":
      return "RESIZING";
    case "CF":
      return "CONFIGURING";
    case "SI":
      return "SIGNALING";
    case "ST":
      return "STOPPED";
    case "SE":
      return "SPECIAL_EXIT";
    case "RV":
      return "REVOKED";
    case "DL":
      return "DEADLINE";
    case "RH":
      return "REQUEUE_HOLD";
    case "RF":
      return "REQUEUE_FED";
    case "CFG":
      return "CONFIGURING";
    case "RE":
      return "REQUEUED";
    default:
      return "UNKNOWN";
  }
}
