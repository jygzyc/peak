export type WorkerType = "opencode" | "codex" | "pi" | "claude-code";

export interface WorkerDefinition {
  type: WorkerType;
  model?: string;
  /** Per-worker environment variables merged into the CLI subprocess env. */
  env: Record<string, string>;
}

/** Minimal configuration owned by WorkerRuntime. */
export interface WorkerRuntimeConfig { workers: Record<string, WorkerDefinition> }

export interface SessionRef { workerType: WorkerType; value: string }
/**
 * Subprocess specification. `argv` is driven through cmd.exe on Windows so
 * npm-installed CLIs resolve; `input` is piped via stdin (never on the
 * command line). An optional `stdoutFilter` lets a protocol discard
 * high-volume streaming noise (e.g. token deltas) line by line so a long
 * streaming run is not misread as runaway output: the byte budget counts
 * only retained lines, and each line is matched without its trailing newline.
 */
export interface ProcessSpec {
  argv: string[];
  input?: string;
  env?: Record<string, string>;
  stdoutFilter?: (line: string) => boolean;
}
export interface ProcessResult {
  stdout: string; stderr: string; returncode: number; timedOut: boolean; cancelled: boolean; started: boolean;
}
export interface WorkerResult extends ProcessResult { text: string; session?: SessionRef }

/**
 * Inputs handed to a CLI protocol builder. `tmpDir` exposes the per-Project
 * scratch directory (`.tmp`) to protocols that need an explicit transient/
 * session-cache path. The prompt is always piped via stdin by the
 * ProcessRunner; it never appears on the command line.
 */
export interface WorkerCall {
  config: WorkerDefinition;
  prompt: string;
  session?: SessionRef;
  tmpDir?: string;
}

/**
 * Stateless per-tool CLI protocol. Each backend describes only how to build
 * the subprocess argv from a {@link WorkerCall}, how to derive a resumable
 * session before the run, and how to parse stdout into the final text and an
 * optional resumable session. Protocols never implement scheduling, process
 * management, or Graph access; {@link WorkerRuntime} drives the single shared
 * ProcessRunner uniformly for every protocol.
 */
export interface WorkerProtocol {
  readonly type: WorkerType;
  readonly canResume: boolean;
  build(call: WorkerCall, session: SessionRef | undefined): ProcessSpec;
  /** Seed or carry a resumable session before the run. Defaults to `call.session`. */
  prepareSession?(call: WorkerCall): SessionRef | undefined;
  parse(result: ProcessResult): { text: string; session?: SessionRef };
}
