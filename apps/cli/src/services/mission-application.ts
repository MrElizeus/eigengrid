import {
  ContentAddressedArtifactStore,
  MdProjectionStore,
  ScientificStore,
} from "@eigengrid/mission-runtime";
import { ScientificMissionService } from "@eigengrid/scientific-agent";
import { z } from "zod";
import {
  type MissionApplicationAuthority,
  type MissionApplicationContext,
} from "./mission-application/contracts";
import {
  Address,
  AgentInferenceAdmission,
  type AgentInferenceLease,
  Approve,
  Cancel,
  Create,
  ExactCandidate,
  Import,
  PlanAddress,
  ReplanUnstarted,
} from "./mission-application/requests";

import { missionApprove } from "./mission-application/approvals";
import { missionAssertProjectAccess } from "./mission-application/authority";
import { missionImportCandidate } from "./mission-application/candidate-import";
import { listApplicationProjects, listApplicationMissions } from "./mission-application/discovery";
import type { MissionApplicationState } from "./mission-application/contracts";
import {
  missionBeginAgentInference,
  missionObserveAgentInference,
} from "./mission-application/inference";
import {
  missionCompile,
  missionCreate,
  missionReconcileStart,
  missionReplanUnstarted,
  missionRequestCancel,
  missionStart,
} from "./mission-application/lifecycle";
import { missionRead, missionReview, missionStatus } from "./mission-application/queries";
export { approvalBelongsToMissionCandidate } from "./mission-application/approval-binding";
export { MissionApplicationError } from "./mission-application/contracts";
export type {
  MissionApplicationAuthority,
  MissionApplicationContext,
  MissionApplicationErrorCode,
} from "./mission-application/contracts";
export { assertCompletedMdPredecessor } from "./mission-application/md-predecessor";
export {
  computeMissionCandidateDigest,
  Address as MissionAddressSchema,
  Approve as MissionApproveRequestSchema,
  Cancel as MissionCancelRequestSchema,
  MissionCandidateSchema,
  ExactCandidate as MissionCompileRequestSchema,
  Create as MissionCreateRequestSchema,
  Import as MissionImportRequestSchema,
  ReplanUnstarted as MissionReplanUnstartedRequestSchema,
  PlanAddress as MissionReviewRequestSchema,
  ExactCandidate as MissionStartRequestSchema,
} from "./mission-application/requests";
export type { AgentInferenceLease, MissionCandidate } from "./mission-application/requests";

/** Stable application facade; domain modules retain authority and lifecycle checks. */
/** Human application boundary. Authority comes from composition, never request JSON.
 * Every mutation remains durable; this object has no scheduler or execution-loop API. */
export class MissionApplication<C extends MissionApplicationContext = MissionApplicationContext> {
  private readonly state: MissionApplicationState<C>;
  constructor(options: {
    store: ScientificStore;
    service: ScientificMissionService;
    authority: MissionApplicationAuthority<C>;
    artifacts: ContentAddressedArtifactStore;
    mdStore?: MdProjectionStore;
    now?: () => Date;
  }) {
    this.state = {
      options,
      now: options.now ?? (() => new Date()),
      inferenceLeases: new WeakSet(),
    };
  }

  async assertProjectAccess(projectId: string): Promise<void> {
    return missionAssertProjectAccess(this.state, projectId);
  }

  listProjects(projectIds: readonly string[], page: { after?: string; limit?: number } = {}) {
    return listApplicationProjects(this.state, projectIds, page);
  }

  listMissions(input: { projectId: string; after?: string; limit?: number }) {
    return listApplicationMissions(this.state, input);
  }

  /** Host-only inference admission using the mission runtime's existing atomic mission budget ledger. */
  async beginAgentInference(
    value: z.input<typeof AgentInferenceAdmission>,
  ): Promise<AgentInferenceLease> {
    return missionBeginAgentInference(this.state, value);
  }

  /** Account an already admitted call even if a client disconnects or loses permission.
   * This host-issued lease cannot authorize a scientific effect or a new model call. */
  async observeAgentInference(
    lease: AgentInferenceLease,
    observation: {
      responseDigest?: string;
      inputTokens?: number;
      outputTokens?: number;
      cost?: number;
      ambiguous?: boolean;
    },
  ): Promise<void> {
    return missionObserveAgentInference(this.state, lease, observation);
  }

  async create(value: z.input<typeof Create>) {
    return missionCreate(this.state, value);
  }

  async importCandidate(value: z.input<typeof Import>) {
    return missionImportCandidate(this.state, value);
  }

  async read(value: z.input<typeof Address>) {
    return missionRead(this.state, value);
  }

  async status(value: z.input<typeof Address>) {
    return missionStatus(this.state, value);
  }

  async review(value: z.input<typeof PlanAddress>) {
    return missionReview(this.state, value);
  }

  async approve(value: z.input<typeof Approve>) {
    return missionApprove(this.state, value);
  }

  async compile(value: z.input<typeof ExactCandidate>) {
    return missionCompile(this.state, value);
  }

  async start(value: z.input<typeof ExactCandidate>) {
    return missionStart(this.state, value);
  }

  /** Read back the mission runtime's exact mission-start transition after a lost acknowledgement.
   * This is proof of durable admission only; it never certifies a Slurm/MD effect. */
  async reconcileStart(value: z.input<typeof ExactCandidate>) {
    return missionReconcileStart(this.state, value);
  }

  /** Versioned durable cancellation request. Never invents a scheduler kill receipt. */
  async requestCancel(value: z.input<typeof Cancel>) {
    return missionRequestCancel(this.state, value);
  }

  /** Withdraw only an unstarted MD phase. Never touches a live or acknowledged effect. */
  async replanUnstarted(value: z.input<typeof ReplanUnstarted>) {
    return missionReplanUnstarted(this.state, value);
  }
}
