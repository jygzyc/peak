/**
 * Graph interface shared by all peak storage backends.
 *
 * Defines the persistent task-state protocol for projects, facts, intents,
 * hints, directives, events, and progress. SessionLoops depend on this
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

export interface MetacogCommitInput {
  hints: HintInput[];
  reviewedFactId?: FactId;
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
  claimIntent(projectId: ProjectId, intentId: IntentId): Intent;
  releaseIntent(projectId: ProjectId, intentId: IntentId): void;
  concludeIntent(projectId: ProjectId, intentId: IntentId, factId?: FactId): void;
  failIntent(projectId: ProjectId, intentId: IntentId, reason: string, recordDeadEnd?: boolean, killedBy?: Intent["killedBy"]): void;
  /** Record a dead-end route by description, independent of intent lifecycle
   * (e.g. when an evaluator rejects a fact whose intent already concluded). */
  recordDeadEnd(projectId: ProjectId, description: string, reason: string): void;
  isDeadEnd(projectId: ProjectId, description: string): boolean;

  createEndFact(projectId: ProjectId, description: string, fromFactIds: FactId[]): EndFact;
  activeEndFact(projectId: ProjectId): EndFact | undefined;
  endFacts(projectId: ProjectId): EndFact[];

  /** Atomic explorer protocol commit: candidate Fact + Intent pass. */
  commitExplorerResult(
    projectId: ProjectId,
    intentId: IntentId,
    input: FactInput,
  ): Fact;
  /** Atomic evaluator protocol commit: Fact verdict. */
  commitEvaluatorResult(
    projectId: ProjectId,
    factId: FactId,
    verdict: Verdict,
  ): void;
  /** Atomic broadcast evaluator commit. External broadcasts remain references;
   * this records the assessment and may only reactivate an existing pending Fact. */
  commitBroadcastAssessment(
    projectId: ProjectId,
    broadcastId: string,
    assessment: BroadcastAssessment,
    broadcastKind?: string,
  ): void;
  /** Atomically commits metacog-produced task state. */
  commitMetacogResult(
    projectId: ProjectId,
    input: MetacogCommitInput,
  ): void;
  addHint(projectId: ProjectId, input: HintInput): Hint;
  unconsumedHints(projectId: ProjectId): Hint[];
  consumeHint(projectId: ProjectId, hintId: HintId): void;

  addDirective(projectId: ProjectId, input: DirectiveInput): Directive;
  unconsumedDirectives(projectId: ProjectId): Directive[];
  consumeDirective(projectId: ProjectId, directiveId: DirectiveId): void;

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
