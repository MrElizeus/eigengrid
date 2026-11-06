import type { MissionApplication } from "../../cli/src/services/mission-application";
import type { MissionProvenance } from "@eigengrid/mission-runtime";
import type { AgentSession, AgentRecord } from "@eigengrid/agent-runtime";
import type {
  ScientificMissionSummary,
  ScientificProjectSummary,
} from "../../../packages/mission-runtime/src/scientific-catalog";

export type {
  MissionProvenance,
  AgentSession,
  AgentRecord,
  ScientificMissionSummary,
  ScientificProjectSummary,
};
export type Review = Awaited<ReturnType<MissionApplication["review"]>>;
export type CreateRequest = Parameters<MissionApplication["create"]>[0];
export interface Session {
  actor: { id: string; kind: string; displayName?: string };
  roles: string[];
  csrfToken: string;
}
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
export interface PendingRequest {
  actorId: string;
  projectId: string;
  missionId: string;
  operation: string;
  key: string;
  createdAt: string;
  responseReceived?: boolean;
}
export interface MutationResult {
  operationId: string;
  result: unknown;
}
export interface Recovery {
  operationId: string;
  status: "complete" | "pending" | "not_recorded";
  result?: unknown;
}
export interface MissionView {
  projectId: string;
  missionId: string;
  provenance: MissionProvenance;
  signal: AbortSignal;
  refresh: () => Promise<void>;
  mutate: (
    operation: string,
    request: unknown,
    expectedRevision?: number,
    suffix?: string,
  ) => Promise<MutationResult>;
}
