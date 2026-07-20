/**
 * Registry for the four BaseWorker implementations.
 *
 * Resolves named workers from task configuration or built-ins, dispatches to the
 * appropriate driver kind, and exposes capability metadata for CLI/status
 * commands. This is the bridge from WorkerPool to concrete drivers.
 */

import type { WorkerType } from "../agent/types.js";
import { ClaudeCodeWorker } from "./backends/claude.js";
import { CodexWorker } from "./backends/codex.js";
import { OpenCodeWorker } from "./backends/opencode-cli.js";
import { PiWorker } from "./backends/pi.js";
import type { BaseWorker } from "./backends/subprocess.js";

const WORKERS = new Map<string, BaseWorker>();
for (const worker of [
  new OpenCodeWorker(),
  new CodexWorker(),
  new PiWorker(),
  new ClaudeCodeWorker(),
]) WORKERS.set(worker.type, worker);

export function getWorker(type: WorkerType): BaseWorker {
  const worker = WORKERS.get(type);
  if (!worker) throw new Error(`unsupported worker type: ${type}`);
  return worker;
}

/** Programmatic extension point; Task JSON remains limited to the four built-ins. */
export function registerWorker(worker: BaseWorker): () => void {
  const previous = WORKERS.get(worker.type);
  WORKERS.set(worker.type, worker);
  return () => {
    if (WORKERS.get(worker.type) !== worker) return;
    if (previous) WORKERS.set(worker.type, previous);
    else WORKERS.delete(worker.type);
  };
}

export function workerCapabilities(): Record<string, unknown> {
  return {
    workerTypes: ["opencode", "codex", "pi", "claude-code"] satisfies WorkerType[],
  };
}
