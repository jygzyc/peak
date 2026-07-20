/**
 * WorkerPool — the execution abstraction for peak.
 *
 * Agent protocol code never calls subprocesses directly. It calls
 * WorkerPool.execute(), which keeps execution replaceable in tests.
 *
 * Two implementations:
 *   - MockWorker: testing, returns canned responses by regex match
 *   - AgentDriverPool: production, wraps the four Agent CLI backends
 */

import type { TaskConfig, WorkerConfig, WorkerName } from "../agent/types.js";

export interface WorkerRequest {
  prompt: string;
  config: WorkerConfig;
  workerName: WorkerName;
  cwd: string;
  /** Cancels the underlying HTTP request or process tree. */
  signal?: AbortSignal;
}

export interface WorkerResult {
  text: string;
  returncode: number;
  stderr?: string;
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
  pickWorker(config: TaskConfig, candidates?: WorkerName[]): WorkerName;
}
