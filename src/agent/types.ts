/**
 * Core data model for peak.
 *
 * The model is intentionally graph-first and domain-neutral: facts, intents,
 * hints, directives, links, events, subagent runs, workers, and workflow
 * limits describe analysis structure while domain meaning stays in
 * descriptions, evidence, and prompts.
 *
 * Roles are plain strings; source code does not encode role names beyond the
 * built-in defaults used by SessionLoop wiring. Custom profiles can introduce
 * arbitrary role identifiers (e.g. "android-source-finder").
 */

export type ProjectId = string;
export type FactId = string;
export type IntentId = string;
export type HintId = string;
export type DirectiveId = string;
export type RunId = string;

/**
 * Role identifiers are free-form strings. A small set of built-in defaults is
 * exported for convenience, but custom SubagentProfiles may use any role name
 * without touching source code.
 */
export type RoleId = string;

export const BUILTIN_ROLES = {
  planner: "planner",
  explorer: "explorer",
  evaluator: "evaluator",
  metacog: "metacog",
  system: "system",
} as const;

export type AgentBackendId = "opencode" | "codex" | "claude-code" | string;
export type ToolKind = "tool" | "skill";

export type ISOTime = string;

export type ProjectStatus = "active" | "paused" | "completed" | "failed" | "stopped";

export interface Project {
  id: ProjectId;
  session: string;
  name: string;
  target: string;
  goal: string;
  status: ProjectStatus;
  worker: string;
  sessionDir: string;
  configPath: string;
  taskConfig: TaskConfig;
  createdAt: ISOTime;
  updatedAt: ISOTime;
}

export type FactStatus = "pending" | "pass" | "deny";

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

export type IntentStatus = "open" | "claimed" | "pass" | "deny";

export interface Intent {
  id: IntentId;
  projectId: ProjectId;
  description: string;
  creator: RoleId | "workflow" | "human";
  parentFactIds: FactId[];
  status: IntentStatus;
  parentIntentId?: IntentId;
  lease?: {
    workerId: string;
    claimedAt: ISOTime;
    expiresAt: ISOTime;
  };
  priority: number;
  createdAt: ISOTime;
  concludedAt?: ISOTime;
  concludedFactId?: FactId;
  failureReason?: string;
  killedBy?: "planner" | "directive" | "lease-expired";
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

export interface Progress {
  totalFacts: number;
  passFacts: number;
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

// ─── Subagent runs (first-class trackable, cancellable executions) ───

export type RunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

/**
 * A SubagentRun tracks one execution of a SubagentProfile against the graph.
 *
 * Explorer, evaluator, and metacog executions are all modeled as runs so they
 * can be observed, cancelled, and quota-limited uniformly. The graph is the
 * source of truth for run state; in-flight process handles live in the worker
 * layer and are correlated back via runId.
 */
export interface SubagentRun {
  id: RunId;
  projectId: ProjectId;
  profileId: string;
  role: RoleId;
  workerName: WorkerName;
  status: RunStatus;
  intentId?: IntentId;
  factId?: FactId;
  parentRunId?: RunId;
  inputSummary?: string;
  outputSummary?: string;
  errorMessage?: string;
  rotateOf?: RunId;
  usedDelta?: boolean;
  /** True when the run's output came from a conclude-fallback retry. */
  usedConclude?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  createdAt: ISOTime;
  startedAt?: ISOTime;
  finishedAt?: ISOTime;
}

export interface SubagentRunInput {
  profileId: string;
  role: RoleId;
  workerName: WorkerName;
  intentId?: IntentId;
  factId?: FactId;
  parentRunId?: RunId;
  inputSummary?: string;
  rotateOf?: RunId;
  usedDelta?: boolean;
}

// ─── Workers ───

export type WorkerName = string;
export type WorkerKind = "agent" | "api" | "mock";

export interface WorkerConfig {
  kind: WorkerKind;
  backend?: string;
  transport?: "subprocess" | "http";
  command?: string;
  args?: string[];
  model?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  apiKey?: string;
  password?: string;
  provider?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

// ─── Subagent profiles (configuration-driven role binding) ───

/**
 * Runtime selection for a subagent: which worker, optional model override,
 * and optional direct provider (for `api` workers).
 */
export interface RuntimeSpec {
  worker: WorkerName;
  workers?: WorkerName[];
  model?: string;
  provider?: string;
}

/**
 * Prompt assembly specification. The role preamble may come from a file, raw
 * text, optional rules/knowledge appendices, and optional instructions block.
 * At runtime, ContextBuilder prepends dynamic graph context per `context`.
 */
export interface PromptSpec {
  file: string;
  rules?: string[];
  knowledge?: string[];
  instructions?: string;
  /**
   * Optional conclude-phase prompt file. When set, a profile enables conclude
   * fallback: if the worker's first output fails to parse into a valid envelope,
   * the worker is re-invoked (in the same session when the backend supports
   * resume) with this prompt, which forces it to summarize already-confirmed
   * findings into the required JSON shape. Modeled on Cairn's conclude phase.
   */
  concludeFile?: string;
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
  rotateOnContextFull?: boolean;
  relevanceScope?: "linked" | "all";
}

/**
 * Capability tokens. A profile's permissions declare which graph mutations
 * its output may trigger. The decision applier enforces this.
 */
export type Permission =
  | "create_intent"
  | "fail_intent"
  | "spawn_subagent"
  | "cancel_subagent"
  | "resolve_fact"
  | "write_candidate_fact"
  | "write_hint"
  | "conclude_run";

/**
 * Output contract identifier. The contracts module validates worker output
 * against the named shape before the decision applier applies any side effects.
 */
export type OutputContract =
  | "main_decision"
  | "candidate_fact"
  | "verdict"
  | "hints"
  | "stop";

export interface OutputSpec {
  contract: OutputContract;
}

/**
 * A SubagentProfile fully describes one configurable subagent: runtime, prompt,
 * context policy, permissions, output contract, and concurrency bounds.
 *
 * Per-agent tuning knobs (no global "workflow" concept):
 *   - maxActive: concurrent run cap for this profile.
 *   - cooldownSteps: (planner) min steps between planner runs.
 *   - triggers: (metacog) when the wall-clock metacog loop fires.
 */
export interface SubagentProfile {
  role: RoleId;
  runtime: RuntimeSpec;
  prompt: PromptSpec;
  context: ContextSpec;
  permissions: Permission[];
  output: OutputSpec;
  maxActive?: number;
  intervalSeconds?: number;
  /** Planner-only: min steps between planner runs (default 3). */
  cooldownSteps?: number;
  /** Metacog-only: when the metacog wall-clock loop fires. */
  triggers?: MetacogTriggers;
  sessionReuse?: boolean;
  maxOutputTokens?: number;
  promptCache?: boolean;
}

/** Metacog firing triggers (per-metacog-profile, not global). */
export interface MetacogTriggers {
  everySteps?: number;
  everySeconds?: number;
  stagnationLevel?: number;
}

/**
 * Built-in profile slots used by SessionLoop and MetacogSupervisor wiring.
 * Custom profiles live in `profiles` under arbitrary keys and are dispatched
 * explicitly via SubagentManager.
 */
export interface BuiltinProfiles {
  planner: SubagentProfile;
  explorer: SubagentProfile;
  evaluator: SubagentProfile;
  metacog?: SubagentProfile;
}

export interface TaskConfig {
  task: {
    target: string;
    goal: string;
    session?: string;
    name?: string;
  };
  profiles: BuiltinProfiles & Record<string, SubagentProfile>;
  workers: Record<WorkerName, WorkerConfig>;
  /** Scheduler resource knobs (optional; defaults suffice). Not a "workflow". */
  scheduler?: SchedulerConfig;
  control?: ControlConfig;
}

export interface ControlConfig {
  mainProfile?: string;
  metacogProfile?: string;
  metacogIntervalSeconds?: number;
  globalMaxConcurrent?: number;
}

/**
 * Scheduler resource parameters — low-level execution knobs only
 * (concurrency, refill rate, intent-claim lease). These are NOT a workflow:
 * there is no depth limit, no stop gate, no forced termination. Termination is
 * natural (planner produces no new intent) with metacog hints as the course-
 * correction mechanism.
 */
export interface SchedulerConfig {
  maxConcurrent?: number;
  refillPerTick?: number;
  workerLeaseMs?: number;
}

/** Default scheduler values (used when TaskConfig.scheduler is absent). */
export const DEFAULT_SCHEDULER = {
  maxConcurrent: 3,
  refillPerTick: 1,
  workerLeaseMs: 300_000,
} as const;

/** Default metacog triggers (used when the metacog profile omits `triggers`). */
export const DEFAULT_METACOG_TRIGGERS: MetacogTriggers = {
  everySteps: 5,
  everySeconds: 30,
  stagnationLevel: 3,
};

/**
 * Permission sets for the built-in roles. Custom profiles declare their own.
 * Exported so the default config and tests share one source of truth.
 */
export const BUILTIN_PERMISSIONS: Record<string, Permission[]> = {
  planner: [
    "create_intent", "fail_intent", "spawn_subagent", "cancel_subagent",
    "write_hint", "conclude_run",
  ],
  explorer: ["write_candidate_fact"],
  evaluator: ["resolve_fact"],
  metacog: ["write_hint"],
};
