/**
 * Core data model for peak.
 *
 * The model is intentionally graph-first and domain-neutral: facts, intents,
 * hints, directives, links, events, workers, and scheduling
 * limits describe analysis structure while domain meaning stays in
 * descriptions, evidence, and prompts.
 *
 * The protocol has four fixed session roles. Domain specialization belongs in
 * arbitrary profile ids, prompts, knowledge, skills, and workers; a
 * profile binds to one of the four roles and cannot invent new capabilities.
 */

export type ProjectId = string;
export type FactId = string;
export type IntentId = string;
export type HintId = string;
export type DirectiveId = string;
export type EndFactId = string;

export type SessionRole = "planner" | "explorer" | "evaluator" | "metacog";
export type RoleId = SessionRole | "system";

export const BUILTIN_ROLES = {
  planner: "planner",
  explorer: "explorer",
  evaluator: "evaluator",
  metacog: "metacog",
  system: "system",
} as const;

export type ToolKind = "tool" | "skill";

export type ISOTime = string;

export type ProjectStatus =
  | "active"
  | "paused"
  | "finish_proposed"
  | "exhausted"
  | "completed"
  | "failed"
  | "stopped";

export interface Project {
  id: ProjectId;
  /** Stable UUID used for the persistent Session directory and Server route. */
  sessionId: string;
  /** Human-readable Session name. */
  session: string;
  name: string;
  target: string;
  goal: string;
  status: ProjectStatus;
  worker: string;
  sessionDir: string;
  /** User/task workspace inspected by coding-agent workers; distinct from state. */
  workspaceDir: string;
  configPath: string;
  taskConfig: TaskConfig;
  createdAt: ISOTime;
  updatedAt: ISOTime;
}

/**
 * candidate: produced by an explorer and awaiting evaluator review.
 * pending: reviewed, but blocked on explicit requiredConditions.
 */
export type FactStatus = "candidate" | "pass" | "deny" | "pending";

export interface Fact {
  id: FactId;
  projectId: ProjectId;
  description: string;
  evidence: string[];
  source: RoleId;
  confidence: number;
  status: FactStatus;
  parentIntentId?: IntentId;
  reviewerReason?: string;
  requiredConditions?: string[];
  stepDiscovered?: number;
  createdAt: ISOTime;
}

/** Planner-authored, provisional proof that a session may finish. */
export interface EndFact {
  id: EndFactId;
  projectId: ProjectId;
  description: string;
  fromFactIds: FactId[];
  status: "active" | "superseded";
  createdAt: ISOTime;
  supersededAt?: ISOTime;
  supersededReason?: string;
}

export type IntentStatus = "open" | "claimed" | "pass" | "deny";

export interface Intent {
  id: IntentId;
  projectId: ProjectId;
  description: string;
  creator: RoleId | "human";
  parentFactIds: FactId[];
  status: IntentStatus;
  /** Planner-authored dispatch gate. An open Intent is not executable until
   * create_subagent_explorer has explicitly requested an explorer. */
  dispatchRequested: boolean;
  parentIntentId?: IntentId;
  priority: number;
  createdAt: ISOTime;
  concludedAt?: ISOTime;
  concludedFactId?: FactId;
  failureReason?: string;
  killedBy?: "planner" | "directive";
}

export type HintKind = "direction" | "warning" | "stop-explorer";

export interface Hint {
  id: HintId;
  projectId: ProjectId;
  content: string;
  creator: RoleId | "human";
  kind: HintKind;
  targetIntentId?: IntentId;
  consumedAt?: ISOTime;
  createdAt: ISOTime;
  expiresAt?: ISOTime;
}

export interface GraphEvent {
  seq: number;
  projectId: ProjectId;
  type: string;
  payload: Record<string, unknown>;
  timestamp: ISOTime;
}

export interface Verdict {
  decision: "pass" | "deny" | "pending";
  reason: string;
  confidence?: number;
  requiredConditions?: string[];
}

/** Evaluator result for a cross-session FactBroadcast. It is deliberately
 * unable to create local Facts, Intents, or Hints. */
export interface BroadcastAssessment {
  decision: "relevant" | "irrelevant" | "condition_satisfied";
  reason: string;
  /** Existing local pending Fact whose condition the broadcast satisfies. */
  targetFactId?: FactId;
}

export interface Progress {
  totalFacts: number;
  passFacts: number;
  candidateFacts: number;
  pendingFacts: number;
  denyFacts: number;
  openIntents: number;
  claimedIntents: number;
  stepsExecuted: number;
  lastActivityAt: ISOTime;
  stagnationLevel: number;
}

export type DirectiveKind = "stop" | "pause" | "resume" | "hint" | "kill-intent" | "spawn-intent";

export interface Directive {
  id: DirectiveId;
  projectId: ProjectId;
  kind: DirectiveKind;
  payload: string;
  consumedAt?: ISOTime;
  createdAt: ISOTime;
}

export interface DirectiveInput {
  kind: DirectiveKind;
  payload: string;
}

// ─── Workers ───

export type WorkerName = string;
export type WorkerType = "opencode" | "codex" | "pi" | "claude-code";

export interface WorkerConfig {
  type: WorkerType;
  /** Optional model understood by the selected Agent CLI. */
  model?: string;
  /** Extra arguments passed to the selected CLI before Peak's prompt input. */
  args?: string[];
  timeoutMs?: number;
}

// ─── Subagent profiles (configuration-driven role binding) ───

/**
 * Runtime selection for a subagent. Model selection and authentication belong
 * to the selected Agent CLI's own configuration.
 */
export interface RuntimeSpec {
  worker: WorkerName;
  workers?: WorkerName[];
}

/**
 * Prompt assembly specification. `file` accepts a `builtin:<id>` source or an
 * external file path. Rules, knowledge, configured Skill names, and
 * instructions are appended to that system prompt. ContextBuilder supplies
 * runtime graph context.
 */
export interface PromptSpec {
  file: string;
  rules?: string[];
  knowledge?: string[];
  /** Names of task-local Skills preinstalled for the selected Agent CLI. */
  skills?: string[];
  instructions?: string;
}

export type PromptComponentKind =
  | "primary"
  | "rule"
  | "knowledge"
  | "skill"
  | "instructions"
  | "graph-context"
  | "assignment"
  | "output-contract";

export interface PromptManifestComponent {
  kind: PromptComponentKind;
  index: number;
  source: string;
  resolvedPath?: string;
  sha256: string;
  bytes: number;
  graphSeq?: number;
  artifactSha256?: string;
  delivery?: "reference";
}

export interface PromptManifest {
  version: 1;
  /** Hash of the normalized, fully assembled static preamble. */
  hash: string;
  components: PromptManifestComponent[];
}

export interface ContextArtifact {
  version: 1;
  sessionId: string;
  projectId: ProjectId;
  graphSeq: number;
  view: GraphView;
  relativePath: string;
  resolvedPath: string;
  sha256: string;
  bytes: number;
  delivery: "reference";
  createdAt: ISOTime;
}

export interface RoleOutputArtifact {
  version: 1;
  sessionId: string;
  projectId: ProjectId;
  /** Configured role id, e.g. explorer_gather. */
  role: string;
  relativePath: string;
  resolvedPath: string;
  sha256: string;
  bytes: number;
  createdAt: ISOTime;
}

/**
 * Context policy for a subagent. `graphView` controls how much of the graph
 * is rendered into the prompt; `maxFacts` caps the rendered fact count.
 */
export type GraphView = "full" | "focused" | "evidence-only" | "summary";

export interface ContextSpec {
  graphView: GraphView;
  maxFacts?: number;
  includeDeadEnds?: boolean;
  includeProgress?: boolean;
  relevanceScope?: "linked" | "all";
}

/**
 * Capability tokens. A profile's permissions declare which graph mutations
 * its output may trigger. The decision applier enforces this.
 */
export type Permission =
  | "create_intent"
  | "fail_intent"
  | "handle_hint"
  | "create_subagent_explorer"
  | "stop_subagent_explorer"
  | "create_end_fact"
  | "handle_intent"
  | "write_candidate_fact"
  | "change_fact"
  | "receive_fact_broadcast"
  | "create_hint"
  | "send_fact_broadcast";

/**
 * Output contract identifier. The contracts module validates worker output
 * against the named shape before the decision applier applies any side effects.
 */
export type OutputContract =
  | "main_decision"
  | "candidate_fact"
  | "verdict"
  | "broadcast_assessment"
  | "hints"
  | "stop";

export interface OutputSpec {
  contract: OutputContract;
}

export interface RetryPolicy {
  /** Consecutive transport/parse/contract failures before the project fails. */
  maxAttempts?: number;
  /** Reserved scheduling delay between attempts; zero means next eligible tick. */
  backoffMs?: number;
}

/**
 * A SubagentProfile fully describes one configurable subagent: runtime, prompt,
 * context policy, permissions, output contract, and concurrency bounds.
 *
 * Per-agent tuning knobs (no global "workflow" concept):
 *   - maxActive: concurrent execution cap for this profile.
 *   - cooldownSteps: (planner) min steps between planner executions.
 */
export interface SubagentProfile {
  role: SessionRole;
  runtime: RuntimeSpec;
  prompt: PromptSpec;
  /** Worker tool names made available to this configured role. */
  tools?: string[];
  context: ContextSpec;
  permissions: Permission[];
  output: OutputSpec;
  maxActive?: number;
  /** Planner-only: min steps between planner runs (default 3). */
  cooldownSteps?: number;
  retry?: RetryPolicy;
}

/**
 * Effective role configuration assembled from the selected Agent bundle.
 * It is internal runtime state; Task JSON does not declare profiles directly.
 */
export interface TaskConfig {
  task: {
    target: string;
    goal: string;
    name?: string;
    /** Worker cwd, resolved relative to the task config file. */
    workspace?: string;
  };
  /** Task-local role bundle loaded from <task-dir>/<name>.json. */
  agent?: string;
  /** Effective role profiles loaded from the selected reusable Agent bundle. */
  profiles: Record<string, SubagentProfile>;
  workers: Record<WorkerName, WorkerConfig>;
  /** Scheduler resource knobs (optional; defaults suffice). Not a "workflow". */
  scheduler?: SchedulerConfig;
  federation?: FederationConfig;
}

export interface FederationConfig {
  /** Related-session completion and broadcast visibility boundary. */
  scope?: string;
}

/**
 * Scheduler resource parameters — low-level execution knobs only
 * (concurrency and refill rate). These are NOT a workflow:
 * there is no depth limit, no stop gate, no forced termination. Termination is
 * natural (planner produces no new intent) with metacog hints as the course-
 * correction mechanism.
 */
export interface SchedulerConfig {
  maxConcurrent?: number;
  refillPerTick?: number;
}

/**
 * Default scheduler values (used when TaskConfig.scheduler is absent).
 *
 * maxConcurrent/refillPerTick default to 10 so the explorer pool can fan out to
 * many parallel intents in a single step. This pairs with the planner's fan-out
 * guidance (see agent/prompts/planner.ts): the planner is asked to produce many
 * small independent intents, and these defaults ensure the scheduler dispatches
 * them concurrently rather than throttling to one explorer per tick.
 */
export const DEFAULT_SCHEDULER = {
  maxConcurrent: 10,
  refillPerTick: 10,
} as const;

/**
 * Permission sets for the built-in roles. Custom profiles declare their own.
 * Exported so the default config and tests share one source of truth.
 */
export const BUILTIN_PERMISSIONS: Record<SessionRole, Permission[]> = {
  planner: [
    "create_intent", "fail_intent", "handle_hint", "create_subagent_explorer",
    "stop_subagent_explorer", "create_end_fact",
  ],
  explorer: ["handle_intent", "write_candidate_fact"],
  evaluator: ["change_fact", "receive_fact_broadcast"],
  metacog: ["create_hint", "send_fact_broadcast"],
};
