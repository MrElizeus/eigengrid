export { runAgent, runAgentStream, DEFAULT_OPERATOR_MAXIMUM_STEPS } from "./agent-loop";
export type { AgentInput, AgentOutput, AgentEvent } from "./agent-loop";
export { createPlan } from "./planner";
export { getToolPolicy, requiresApproval, isToolDenied } from "./approvals";
export { AgentMemory, type StoreOpts } from "./memory";
export {
  AgentAuthorityLevel,
  type AgentAuthorityLevel as AgentAuthorityLevelName,
  type AgentContextBlock,
} from "./authority";
export { getDefaultPolicies, getDefaultPermissionRules } from "./policies";
export {
  askLlm,
  askLlmStream,
  chatCompletion,
  chatStream,
  configureLlm,
  getLlmConfig,
  resolveConfiguredModel,
} from "./llm-client";
export type { LlmConfig } from "./llm-client";
export { configuredModelVariants, selectConfiguredVariant } from "./model-discovery";
export { modelVariants, assertModelVariant } from "./model-variants";
export type { ModelVariant } from "./model-variants";
export type { ReasoningEffort, ReasoningLevel } from "@eigengrid/model-gateway";
export {
  discoverConfiguredModels,
  selectConfiguredModel,
  ModelConnectionRequiredError,
} from "./model-discovery";
export type { DiscoveredModels } from "./model-discovery";
export { ChatGptAuth, ChatGptAuthError, CHATGPT_RESOURCE, CHATGPT_USAGE_URL } from "./chatgpt-auth";
export type { ChatGptAccount, ChatGptModel } from "./chatgpt-auth";
export {
  fetchCatalog,
  isConversationalModel,
  getProvider,
  formatProviderSummary,
  formatProviderModels,
} from "./model-catalog";
export type { CatalogProvider, CatalogModel } from "./model-catalog";
export {
  saveLlmConfig,
  loadLlmConfig,
  getStoredApiKeyHint,
  findLlmConfigPath,
  forgetStoredLlmApiKey,
} from "./llm-config-store";
export { adaptMaterializedToolsForAI } from "./tool-adapter";
export {
  SqliteProposalStore,
  makeDiagnosisStartedEvent,
  makeDiagnosisCompletedEvent,
  makeDecisionProposedEvent,
  makeDecisionApprovedEvent,
  makeActionExecutedEvent,
} from "./proposals";
export type { Proposal, ProposalStatus, CreateProposalInput, ProposalStore } from "./proposals";
