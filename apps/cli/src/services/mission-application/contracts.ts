import {
  ContentAddressedArtifactStore,
  MdProjectionStore,
  ScientificStore,
} from "@eigengrid/mission-runtime";
import {
  ScientificMissionService,
  type CompilerPolicyProfile,
  type EnvironmentCapabilityProfile,
  type MdCompilerPolicy,
} from "@eigengrid/scientific-agent";
import {
  type ActorIdentity,
  type MdEnvironmentCapabilitySnapshot,
} from "@eigengrid/scientific-schema";
import { type AgentInferenceLease } from "./requests";

export type MissionApplicationErrorCode =
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INVALID_CANDIDATE"
  | "CANDIDATE_CHANGED"
  | "ENVIRONMENT_CHANGED"
  | "APPROVAL_REQUIRED"
  | "CONFLICT";

/** Stable application codes; transports expose their own fixed, safe messages. */
export class MissionApplicationError extends Error {
  readonly name = "MissionApplicationError";
  constructor(
    readonly code: MissionApplicationErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export const inaccessibleMissionMessages = new Set([
  "A production mission-project association requires its requesting human owner",
  "Production mission project membership is missing, revoked, ambiguous or insufficient",
  "Production mission planning requires its exact immutable project association",
]);

export interface MissionApplicationContext {
  authenticatedActor: ActorIdentity;
  authorizedRoles: readonly string[];
  compilerPolicy: CompilerPolicyProfile;
  environment: EnvironmentCapabilityProfile;
  mdCompilerPolicy?: MdCompilerPolicy;
  mdEnvironment?: MdEnvironmentCapabilitySnapshot;
}

export interface MissionApplicationAuthority<
  C extends MissionApplicationContext = MissionApplicationContext,
> {
  current(): Promise<C>;
  assertCurrent(context: C): Promise<void>;
}

export interface MissionApplicationState<C extends MissionApplicationContext> {
  readonly options: {
    store: ScientificStore;
    service: ScientificMissionService;
    authority: MissionApplicationAuthority<C>;
    artifacts: ContentAddressedArtifactStore;
    mdStore?: MdProjectionStore;
    now?: () => Date;
  };
  readonly now: () => Date;
  readonly inferenceLeases: WeakSet<AgentInferenceLease>;
}
