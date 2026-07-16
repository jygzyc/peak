/**
 * peak — public entry point.
 */

// Core types
export type {
  ProjectId, FactId, IntentId, HintId, DirectiveId, AgentId, EndFactId,
  SessionRole, RoleId, ISOTime,
  Project, ProjectStatus, Fact, FactStatus, EndFact, Intent, IntentStatus,
  Hint, HintKind, GraphEvent, Verdict, Progress,
  Directive, DirectiveInput, DirectiveKind,
  AgentRecord, AgentRecordStatus,
  WorkerName, WorkerKind, WorkerConfig, TaskConfig,
  SubagentProfile, RuntimeSpec, PromptSpec, ContextSpec, GraphView,
  PromptComponentKind, PromptManifestComponent, PromptManifest, ContextArtifact, RoleOutputArtifact,
  Permission, OutputContract, OutputSpec,
  BuiltinProfiles, ControlConfig,
  SchedulerConfig, MetacogTriggers, FederationConfig, BroadcastAssessment,
  AgentBackendId, ToolKind,
} from "./agent/types.js";
export { DEFAULT_SCHEDULER, DEFAULT_METACOG_TRIGGERS, BUILTIN_ROLES, BUILTIN_PERMISSIONS } from "./agent/types.js";

// Graph interface and helpers
export type {
  Graph, ProjectInput, FactInput, IntentInput, HintInput,
  FederationOutboxKind, FederationOutboxInput, FederationOutboxItem,
  MetacogCommitInput,
} from "./graph/graph.js";
export { routeHash, now, newProjectId } from "./graph/graph.js";

// Graph implementations
export { SqliteGraph } from "./graph/sqlite-graph.js";
export { SessionManager } from "./session/session-manager.js";
export type { SessionInfo } from "./session/session-manager.js";
export { FederatedGraph } from "./graph/federated-graph.js";
export type { FederatedFact, FederatedIntent, FederatedEvent, SearchOptions } from "./graph/federated-graph.js";

export { FederationBus } from "./graph/federation-bus.js";
export type {
  InsightKind, DeliveryStatus, GlobalInsight, GlobalInsightRef,
  GlobalInsightListener, FederationBusOptions,
} from "./graph/federation-bus.js";
export { defaultConfig } from "./config/default-config.js";
export { federationFile } from "./config/peak-home.js";
export { loadConfig } from "./config/task-config.js";
export type { LoadedConfig } from "./config/task-config.js";
export { normalizeProfile } from "./config/profile-loader.js";
export { PromptLoader, resolvePromptPaths } from "./config/prompt-loader.js";
export type { ResolvedPrompt, PromptLoaderOptions } from "./config/prompt-loader.js";
export {
  PromptBuilder,
  joinPromptSections,
  plannerExtra,
  explorerExtra,
  evaluatorExtra,
  broadcastEvaluatorExtra,
  metacogExtra,
} from "./agent/prompt-builder.js";
export type { BuildPromptInput, BuiltPrompt } from "./agent/prompt-builder.js";
export {
  BUILTIN_SYSTEM_PROMPTS,
  builtinPromptSource,
  isBuiltinPromptSource,
  resolveBuiltinPrompt,
} from "./agent/prompts/index.js";
export type { BuiltinPromptId } from "./agent/prompts/index.js";

export { HttpServer } from "./server/http-server.js";
export type { HttpServerOptions, HttpSessionBinding } from "./server/http-server.js";

// Worker layer
export type { WorkerPool, WorkerRequest, WorkerResult } from "./worker/worker-runtime.js";
export { MockWorker } from "./worker/mock-worker.js";
export { AgentDriverPool } from "./worker/agent-driver-pool.js";

// Agent protocol layer
export { StageError } from "./agent/parse-envelope.js";
export type { WorkerEnvelope } from "./agent/parse-envelope.js";
export { parseEnvelope, expectKind, asArray, asString, asOptionalString, asNumber } from "./agent/parse-envelope.js";
export { PermissionChecker, PermissionDeniedError } from "./agent/permissions.js";
export {
  validateMainDecision, validateCandidateFact, validateVerdict, validateBroadcastAssessment,
  validateHints, validateStop,
} from "./agent/contracts.js";
export type {
  MainDecision, MainDecisionIntent, MainDecisionFail, CandidateFact,
} from "./agent/contracts.js";
export { renderGraphView } from "./agent/graph-view.js";
export type { GraphViewInput, GraphViewOptions } from "./agent/graph-view.js";
export {
  createGraphContextSnapshot, HttpSessionGraphReader,
  materializeGraphContext, renderGraphContextArtifact,
  estimateContextTokens,
} from "./agent/context-builder.js";
export type {
  GraphSnapshotRequest, GraphContextSnapshot, SessionGraphReader,
} from "./agent/context-builder.js";
export { buildDynamicContext, ServerSessionGraphReader } from "./server/session-graph-reader.js";
export type { BuildContextOptions } from "./server/session-graph-reader.js";
export { GlobalResourceGovernor } from "./worker/resource-governor.js";
export { BaseAgent, selectProfileWorker } from "./agent/base-agent.js";
export type { BaseAgentContext, BaseAgentRunInput, BaseAgentResult, AgentOutput } from "./agent/base-agent.js";
export { ExplorerAgent, EvaluatorAgent, MetacogAgent } from "./agent/role-agents.js";
export { AgentRecordStore, newAgentId } from "./agent/agent-record-store.js";
export type { CreateAgentRecordInput, AgentRecordPatch } from "./agent/agent-record-store.js";
export { MainAgent } from "./agent/main-agent.js";
export type { MainAgentContext, MainAgentRunInput, MainAgentResult } from "./agent/main-agent.js";
export { applyMainDecision } from "./agent/decision-applier.js";
export type { DecisionApplierResult, ApplyDecisionContext } from "./agent/decision-applier.js";

// Session runtime
export { SessionLoop } from "./session/session-loop.js";
export type { StepResult, RunOptions } from "./session/session-loop.js";
export { MetacogSupervisor } from "./session/metacog-supervisor.js";
export { GlobalSupervisor } from "./session/supervisor.js";
export { SessionCoordinator } from "./session/session-coordinator.js";
export type {
  RegisteredSession, RegisterSessionOptions, GlobalTickResult, GlobalSupervisorOptions,
} from "./session/supervisor.js";

// Runtime
export { AgentRuntime } from "./app/agent-runtime.js";
export type { AgentRuntimeOptions } from "./app/agent-runtime.js";
export { SessionRuntimeFactory } from "./app/session-runtime-factory.js";
export type {
  SessionRuntimeFactoryOptions, CreatedSessionRuntime, CreateSessionOptions,
} from "./app/session-runtime-factory.js";
