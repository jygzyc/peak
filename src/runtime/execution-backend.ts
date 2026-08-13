/** A source Artifact body placed inside the execution substrate. */
export interface PlacedSource {
  /** The path the worker sees. */
  inputPath: string;
  /** Re-reads the placed file's current bytes from the host for integrity checks. */
  read: () => Promise<Buffer>;
}

/** Per-project worker execution target resolved by an ExecutionBackend. */
export interface WorkerWorkspace {
  /** SDK session working directory, permission boundary, and transient/session-cache dir. */
  tmpDir: string;
  /** Per-project tmpDir cleanup. */
  cleanup: (dir: string) => void;
  /**
   * Materializes one source Artifact body into the substrate (`.tmp/sources`)
   * and returns the worker-visible path plus a host-side read handle for
   * pre/post-run integrity checks. Idempotent per (sha256, filename).
   */
  placeArtifact: (artifact: { sha256: string; filename: string | null }, content: Buffer) => Promise<PlacedSource>;
}

/**
 * Deterministic worker-visible filename for a placed source Artifact:
 * short sha256 prefix plus the sanitized original filename (or the full
 * sha256 when the Fact has no filename).
 */
export function placedSourceName(artifact: { sha256: string; filename: string | null }): string {
  const suffix = artifact.filename
    ? artifact.filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(-48)
    : artifact.sha256;
  return `${artifact.sha256.slice(0, 12)}-${suffix}`;
}

/**
 * The execution substrate for worker sessions. Workers run in-process through
 * the pi SDK, so the only implementation is LocalBackend: one scratch
 * directory per project. The Runtime, TaskExecutor and WorkerPool depend only
 * on this surface.
 */
export interface ExecutionBackend {
  readonly mode: "local";
  /** Ensure the execution target exists for a project; idempotent. */
  ensureWorkspace(projectId: string, hostProjectDir: string): Promise<WorkerWorkspace>;
  /**
   * Release per-project resources when it leaves active state. `status` is
   * the state the Project entered (completed or stopped).
   */
  cleanupProject(projectId: string, status: "completed" | "stopped"): Promise<void>;
  /** Stop every managed target at Runtime shutdown. */
  close(): Promise<void>;
}
