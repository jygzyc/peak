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
  supportsConclude?: boolean;
  /**
   * Extract a reusable session id from worker output, if the backend supports
   * session resume (e.g. codex --resume, claude --resume, opencode -s). Used by
   * the conclude-fallback path to re-invoke the worker with prior context.
   * Backends that cannot resume return undefined (default).
   */
  extractSession?(stdout: string, stderr: string): string | undefined;
  /**
   * Extract the assistant's response text from raw worker output. Most CLI
   * backends (codex, claude) print the response directly to stdout, so the
   * default is identity. Backends that emit structured output (e.g. opencode
   * --format json produces an NDJSON event stream) override this to parse out
   * the assistant message text.
   */
  extractResponseText(stdout: string, stderr: string): string;
}

export interface BackendInvokeInput {
  prompt: string;
  config: WorkerConfig;
  cwd?: string;
  conclude?: boolean;
  partialOutput?: string;
  /** Reusable worker session id (when the backend supports resume). */
  sessionId?: string;
}

export interface BackendInvokeResult {
  text: string;
  returncode: number;
  stderr?: string;
  sessionId?: string;
  timedOut?: boolean;
}
