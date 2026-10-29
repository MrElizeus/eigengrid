import type { Job, RemoteProcessStatus, RunnerResult, StartedProcess } from "@eigengrid/core";
import type { RunnerKind } from "@eigengrid/core";

export interface Runner {
  kind: RunnerKind;
  stage(job: Job): Promise<RunnerResult>;
  start(job: Job): Promise<StartedProcess>;
  status(job: Job): Promise<RemoteProcessStatus>;
  stop(job: Job): Promise<RunnerResult>;
  fetch(job: Job): Promise<RunnerResult>;
}
