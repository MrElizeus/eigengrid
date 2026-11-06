import { VALID_TRANSITIONS, type JobStatus } from "@eigengrid/core";
export function isJobStatus(value: string): value is JobStatus {
  return value in VALID_TRANSITIONS;
}
