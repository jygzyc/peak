/**
 * AgentDriverPool — production WorkerPool backed by BaseWorker implementations.
 *
 * Stages call WorkerPool.execute(); this pool selects the configured BaseWorker.
 *   - Worker selection across the configured role Worker list
 *   - Dispatch to the matching BaseWorker
 */

import type { TaskConfig, WorkerName } from "../agent/types.js";
import type { WorkerPool, WorkerRequest, WorkerResult } from "./worker-runtime.js";
import { getWorker } from "./registry.js";

export class AgentDriverPool implements WorkerPool {
  private workerPickCounter = 0;

  async execute(request: WorkerRequest): Promise<WorkerResult> {
    if (!request.workerName || !request.cwd) {
      throw new Error("worker request requires workerName and cwd");
    }
    return getWorker(request.config.type).execute(request);
  }

  pickWorker(config: TaskConfig, allowed?: WorkerName[]): WorkerName {
    const candidates = (allowed?.length ? allowed : Object.keys(config.workers))
      .filter((name) => config.workers[name]);
    if (candidates.length === 0) return "noop";

    return candidates[this.workerPickCounter++ % candidates.length];
  }
}
