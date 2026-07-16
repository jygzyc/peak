/**
 * Agent backend contract.
 *
 * A backend is the bottom adapter for an interactive or one-shot agent runtime
 * such as OpenCode, Codex, Claude Code, or a custom command. It receives a
 * prompt plus WorkerConfig and returns raw text output with process metadata.
 */

import type { WorkerConfig } from "../../agent/types.js";

export interface AgentBackend {
  readonly id: string;
  invoke(input: BackendInvokeInput): Promise<BackendInvokeResult> | BackendInvokeResult;
  /**
   * Extract a reusable session id from worker output, if the backend supports
   * session resume (Codex exec resume, Claude --resume, OpenCode --session). Used by
   * the conclude-fallback path to re-invoke the worker with prior context.
   * Backends that cannot resume return undefined (default).
   */
  extractSession?(stdout: string, stderr: string): string | undefined;
  /**
   * Extract the assistant's response text from raw worker output. Structured
   * CLI backends parse their declared JSON/NDJSON contract; custom subprocess
   * backends use the base identity implementation.
   */
  extractResponseText(stdout: string, stderr: string): string;
}

export interface BackendInvokeInput {
  prompt: string;
  config: WorkerConfig;
  cwd?: string;
  conclude?: boolean;
  /** Reusable worker session id (when the backend supports resume). */
  sessionId?: string;
  signal?: AbortSignal;
}

export interface BackendInvokeResult {
  text: string;
  returncode: number;
  stderr?: string;
  sessionId?: string;
  timedOut?: boolean;
  aborted?: boolean;
}
