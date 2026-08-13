export type WorkerType = "pi";

/**
 * Permission policy enforced on the pi SDK session of one Worker. All limits
 * are applied inside the worker module at tool level (path confinement,
 * command policy, env scrubbing); see permissions.ts.
 */
export interface WorkerPermissions {
  /** Allow the write/edit tools. `false` reduces the session to a read-only tool set. */
  write: boolean;
  /** Allow the bash tool. */
  bash: boolean;
  /** Command prefixes allowed to run; empty means "any command not denied". */
  bashAllow: string[];
  /** Substring patterns that deny a command outright; wins over `bashAllow`. */
  bashDeny: string[];
  /** Per-command streamed output cap in bytes. */
  bashMaxOutputBytes: number;
}

export interface WorkerDefinition {
  type: WorkerType;
  model?: string;
  /**
   * Extra environment variables applied to the SDK host process before the
   * model runtime resolves provider auth (e.g. API keys). These are never
   * forwarded into the bash tool's scrubbed environment.
   */
  env: Record<string, string>;
  permissions: WorkerPermissions;
}

/** Minimal configuration owned by WorkerRuntime. */
export interface WorkerRuntimeConfig { workers: Record<string, WorkerDefinition> }

/**
 * Resumable session handle. For the pi SDK worker `value` is the absolute
 * path of the session JSONL file inside the per-Project scratch directory.
 */
export interface SessionRef { workerType: WorkerType; value: string }

/**
 * Uniform execution outcome consumed by WorkerPool and TaskExecutor. The
 * field names deliberately mirror the former subprocess result so phase
 * logic (cooldown on non-zero returncode, finalize retry on
 * started/cancelled) is unchanged by the SDK migration.
 */
export interface WorkerResult {
  stdout: string;
  stderr: string;
  returncode: number;
  timedOut: boolean;
  cancelled: boolean;
  started: boolean;
  /** Final assistant text (the worker's only output contract payload). */
  text: string;
  session?: SessionRef;
}

/**
 * Inputs handed to the worker driver. `tmpDir` exposes the per-Project
 * scratch directory (`.tmp`) so the SDK session can keep its session files
 * inside it. The prompt is the worker's only input payload.
 */
export interface WorkerCall {
  config: WorkerDefinition;
  prompt: string;
  session?: SessionRef;
  tmpDir?: string;
}
