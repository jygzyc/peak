/**
 * WorkerPool — the execution abstraction for peak.
 *
 * Agent protocol code never calls subprocesses directly. It calls
 * WorkerPool.execute(), which keeps execution replaceable in tests.
 *
 * Two implementations:
 *   - MockWorker: testing, returns canned responses by regex match
 *   - AgentDriverPool: production, wraps AgentDriver + AgentBackend + ModelProvider
 */

import type { SessionRole, TaskConfig, WorkerConfig, WorkerName } from "../agent/types.js";
import type { ProjectId } from "../agent/types.js";

export interface WorkerRequest {
  prompt: string;
  config: WorkerConfig;
  workerName: WorkerName;
  /** Protocol role issuing this request. */
  role: SessionRole;
  projectId: ProjectId;
  cwd: string;
  maxOutputTokens?: number;
  sessionId?: string;
  /** Marks this invocation as a conclude-phase call (force-summarize, no further work). */
  conclude?: boolean;
  /** Cancels the underlying HTTP request or process tree. */
  signal?: AbortSignal;
}

export interface WorkerResult {
  workerId: string;
  text: string;
  returncode: number;
  stderr?: string;
  sessionId?: string;
  timedOut?: boolean;
  aborted?: boolean;
}

export interface WorkerPool {
  /**
   * Execute a worker synchronously (from the caller's perspective).
   * Returns the worker's text output. Non-zero returncode means failure.
   */
  execute(request: WorkerRequest): Promise<WorkerResult>;

  /**
   * Pick a worker for the given project. Should prefer heterogeneous engines
   * (an engine not currently running for this project) when possible.
   */
  pickWorker(projectId: ProjectId, config: TaskConfig, candidates?: WorkerName[]): WorkerName;

  /**
   * Number of workers currently executing for the given project.
   */
  runningCount(projectId: ProjectId): number;
}
