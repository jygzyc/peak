import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { placedSourceName, type ExecutionBackend, type WorkerWorkspace } from "./execution-backend.js";

/**
 * Gives workers a per-project `.tmp` scratch directory — the only execution
 * substrate. Workers run in-process through the pi SDK; the scratch dir is
 * the SDK session cwd, the permission boundary, and the pi session-file
 * location. Source Artifacts are materialized under `.tmp/sources/` so
 * workers read a private, verified copy instead of the canonical Server-side
 * body (the Runtime and the Server may live on different hosts or use
 * different Project roots).
 */
export class LocalBackend implements ExecutionBackend {
  readonly mode = "local" as const;

  async ensureWorkspace(_projectId: string, hostProjectDir: string): Promise<WorkerWorkspace> {
    const tmpDir = join(hostProjectDir, ".tmp");
    const sourcesDir = join(tmpDir, "sources");
    mkdirSync(sourcesDir, { recursive: true });
    return {
      tmpDir,
      cleanup: (dir) => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } },
      placeArtifact: async (artifact, content) => {
        const inputPath = join(sourcesDir, placedSourceName(artifact));
        try {
          if (readFileSync(inputPath).equals(content)) {
            return { inputPath, read: () => Promise.resolve(readFileSync(inputPath)) };
          }
        } catch { /* missing or stale: rewrite below */ }
        writeFileSync(inputPath, content);
        return { inputPath, read: () => Promise.resolve(readFileSync(inputPath)) };
      },
    };
  }

  async cleanupProject(_projectId: string, _status: "completed" | "stopped"): Promise<void> {
    // `.tmp` cleanup is owned by TaskExecutor via the workspace cleanup callback;
    // local mode keeps no other per-project state.
  }

  async close(): Promise<void> { /* nothing to stop */ }
}
