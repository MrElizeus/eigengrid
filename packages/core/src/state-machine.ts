import { VALID_TRANSITIONS } from "./constants";
import type { JobStatus } from "./types";

export function canTransitionJobStatus(from: JobStatus, to: JobStatus): boolean {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}
