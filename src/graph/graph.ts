/**
 * Graph interface shared by all peak storage backends.
 *
 * Defines the state protocol for projects, facts, intents, hints, directives,
 * events, leases, and progress. SessionLoops and stages depend on this
 * interface instead of a specific in-memory or SQLite implementation.
 */

import type {
  Directive,
  BroadcastAssessment,
  DirectiveId,
  DirectiveInput,
  Fact,
  FactId,
  FactStatus,
  EndFact,
  GraphEvent,
  Hint,
  HintId,
  Intent,
  IntentId,
  IntentStatus,
  ISOTime,
  Progress,
  Project,
  ProjectId,
  ProjectStatus,
  RunId,
  RunStatus,
  SubagentRun,
  SubagentRunInput,
  TaskConfig,
  Verdict,
  WorkerName,
} from "../agent/types.js";

export interface HintInput {
  content: string;
  creator: Hint["creator"];
  kind?: Hint["kind"];
  targetIntentId?: IntentId;
  expiresAt?: ISOTime;
}

export interface ProjectInput {
  session: string;
  name: string;
  target: string;
  goal: string;
  worker: WorkerName;
  sessionDir: string;
  workspaceDir?: string;
  configPath: string;
  taskConfig: TaskConfig;
}

export interface FactInput {
  description: string;
  evidence?: string[];
  source: Fact["source"];
  confidence?: number;
  parentIntentId?: IntentId;
}

export interface IntentInput {
  description: string;
  creator: Intent["creator"];
  parentFactIds?: FactId[];
  parentIntentId?: IntentId;
  priority?: number;
  /** Raw graph calls do not dispatch unless explicitly requested. */
  dispatchRequested?: boolean;
}

export interface IntentLeaseClaim {
  workerId: string;
  epoch: number;
}

/** Fencing token for one claimed SubagentRun attempt. All worker-originated
 * graph commits must present it; expiry/requeue increments the epoch. */
export interface RunLeaseClaim {
  ownerId: string;
  epoch: number;
  attempt: number;
}

export type FederationOutboxKind = "fact" | "session_summary";

export interface FederationOutboxInput {
  eventId: string;
  scope: string;
  kind: FederationOutboxKind;
  sourceFactId?: FactId;
  summary: string;
  confidence: number;
}

export interface FederationOutboxItem extends FederationOutboxInput {
  projectId: ProjectId;
  status: "pending" | "published";
  createdAt: ISOTime;
  publishedAt?: ISOTime;
  broadcastId?: string;
  broadcastSeq?: number;
}

export interface MetacogCommitInput {
  hints: HintInput[];
  outputSummary: string;
  reviewedFactId?: FactId;
  broadcast?: FederationOutboxInput;
  finalReviewCompleted?: boolean;
}

export interface Graph {
  /** Release backend resources after all session work has stopped. */
  close?(): void;
  createProject(input: ProjectInput): Project;
  getProject(idOrSession: string): Project | undefined;
  listProjects(status?: ProjectStatus): Project[];
  updateProjectStatus(id: ProjectId, status: ProjectStatus): void;
  touchProject(id: ProjectId): void;

  addFact(projectId: ProjectId, input: FactInput): Fact;
  getFact(projectId: ProjectId, factId: FactId): Fact | undefined;
  facts(projectId: ProjectId, status?: FactStatus): Fact[];
  candidateFacts(projectId: ProjectId): Fact[];
  resolveFact(projectId: ProjectId, factId: FactId, verdict: Verdict): void;
  /** Clear requiredConditions on a deferred pending fact, returning it to the
   * candidateFacts queue for re-evaluation. No-op if the fact is not deferred. */
  clearFactConditions(projectId: ProjectId, factId: FactId): void;

  addIntent(projectId: ProjectId, input: IntentInput): Intent;
  getIntent(projectId: ProjectId, intentId: IntentId): Intent | undefined;
  intents(projectId: ProjectId, status?: IntentStatus): Intent[];
  requestExplorerDispatch(projectId: ProjectId, intentId: IntentId): void;
  stopExplorer(projectId: ProjectId, intentId: IntentId, reason: string): void;
  claimIntent(projectId: ProjectId, intentId: IntentId, workerId: string, leaseMs: number): Intent;
  renewIntentLease(projectId: ProjectId, intentId: IntentId, expected: IntentLeaseClaim, leaseMs: number): void;
  releaseIntent(projectId: ProjectId, intentId: IntentId, expected?: IntentLeaseClaim): void;
  concludeIntent(projectId: ProjectId, intentId: IntentId, factId?: FactId): void;
  failIntent(projectId: ProjectId, intentId: IntentId, reason: string, recordDeadEnd?: boolean, killedBy?: Intent["killedBy"]): void;
  /** Record a dead-end route by description, independent of intent lifecycle
   * (e.g. when an evaluator rejects a fact whose intent already concluded). */
  recordDeadEnd(projectId: ProjectId, description: string, reason: string): void;
  isDeadEnd(projectId: ProjectId, description: string): boolean;
  sweepExpiredLeases(): number;

  createEndFact(projectId: ProjectId, description: string, fromFactIds: FactId[]): EndFact;
  activeEndFact(projectId: ProjectId): EndFact | undefined;
  endFacts(projectId: ProjectId): EndFact[];

  /** Atomic explorer protocol commit: candidate Fact + Intent pass + Run terminal. */
  commitExplorerResult(
    projectId: ProjectId,
    intentId: IntentId,
    runId: RunId,
    input: FactInput,
    expected: IntentLeaseClaim,
    expectedRun?: RunLeaseClaim,
  ): Fact;
  /** Atomic evaluator protocol commit: Fact verdict + Run terminal. */
  commitEvaluatorResult(
    projectId: ProjectId,
    factId: FactId,
    runId: RunId,
    verdict: Verdict,
    expectedRun?: RunLeaseClaim,
  ): void;
  /** Atomic broadcast evaluator commit. External broadcasts remain references;
   * this records the assessment and may only reactivate an existing pending Fact. */
  commitBroadcastAssessment(
    projectId: ProjectId,
    broadcastId: string,
    runId: RunId,
    assessment: BroadcastAssessment,
    broadcastKind?: string,
    expectedRun?: RunLeaseClaim,
  ): void;
  /** Atomically commits metacog hints/run state and a durable federation outbox item. */
  commitMetacogResult(
    projectId: ProjectId,
    runId: RunId,
    input: MetacogCommitInput,
    expectedRun?: RunLeaseClaim,
  ): void;
  federationOutbox(projectId: ProjectId, status?: FederationOutboxItem["status"]): FederationOutboxItem[];
  markFederationOutboxPublished(
    projectId: ProjectId,
    eventId: string,
    broadcastId: string,
    broadcastSeq: number,
  ): void;

  addHint(projectId: ProjectId, input: HintInput): Hint;
  unconsumedHints(projectId: ProjectId): Hint[];
  consumeHint(projectId: ProjectId, hintId: HintId): void;

  addDirective(projectId: ProjectId, input: DirectiveInput): Directive;
  unconsumedDirectives(projectId: ProjectId): Directive[];
  consumeDirective(projectId: ProjectId, directiveId: DirectiveId): void;

  createSubagentRun(projectId: ProjectId, input: SubagentRunInput): SubagentRun;
  claimSubagentRun(
    projectId: ProjectId,
    runId: RunId,
    ownerId: string,
    leaseMs: number,
  ): RunLeaseClaim | undefined;
  heartbeatSubagentRun(
    projectId: ProjectId,
    runId: RunId,
    expected: RunLeaseClaim,
    leaseMs: number,
  ): void;
  assertSubagentRunClaim(projectId: ProjectId, runId: RunId, expected: RunLeaseClaim): void;
  updateSubagentRun(projectId: ProjectId, runId: RunId, patch: Partial<Pick<SubagentRun,
    "status" | "outputSummary" | "errorMessage" | "factId" | "startedAt" | "finishedAt"
    | "usedConclude" | "inputTokens" | "outputTokens"
    | "promptHash" | "promptManifest" | "contextArtifact" | "outputArtifact" | "workerSessionId">>,
    expected?: RunLeaseClaim,
  ): void;
  getSubagentRun(projectId: ProjectId, runId: RunId): SubagentRun | undefined;
  subagentRuns(projectId: ProjectId, filter?: { profileId?: string; status?: RunStatus }): SubagentRun[];

  logEvent(projectId: ProjectId, type: string, payload?: Record<string, unknown>): GraphEvent;
  events(projectId: ProjectId, sinceSeq?: number, limit?: number): GraphEvent[];

  progress(projectId: ProjectId): Progress;

  transaction<T>(fn: () => T): T;
}

export function routeHash(description: string): string {
  const normalized = description.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 120);
  let h = 5381;
  for (let i = 0; i < normalized.length; i++) {
    h = ((h << 5) + h + normalized.charCodeAt(i)) | 0;
  }
  return `rh_${(h >>> 0).toString(16)}`;
}

export function now(): ISOTime {
  return new Date().toISOString();
}

export function newProjectId(): ProjectId {
  return `proj_${Math.random().toString(16).slice(2, 10)}`;
}

export function newRunId(): RunId {
  return `run_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 6)}`;
}
