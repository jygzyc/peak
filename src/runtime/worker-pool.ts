import type { ResolvedTaskConfig, TaskType } from "../utils/types.js";
import { WorkerRuntime } from "../worker/worker-runtime.js";
import type { SessionRef, WorkerResult, WorkerRuntimeConfig } from "../worker/types.js";

/** Runtime-only phase routing and Worker scheduling policy. */
export class WorkerPool {
  private readonly executeActive = new Map<string, number>();
  private readonly executeReserved = new Map<string, number>();
  private readonly retryAfter = new Map<string, number>();

  constructor(
    private readonly config: ResolvedTaskConfig,
    private readonly workers = new WorkerRuntime(workerDefinitions(config)),
  ) {}

  pick(taskType: TaskType): string | undefined {
    const selected = Object.entries(this.config.workers)
      .filter(([name, worker]) => worker.taskTypes.includes(taskType)
        && (taskType !== "execute" || this.executeLoad(name) < worker.maxRunning)
        && (this.retryAfter.get(name) ?? 0) <= Date.now())
      .sort(([a, left], [b, right]) => left.priority - right.priority
        || this.executeLoad(a) - this.executeLoad(b)
        || a.localeCompare(b))[0]?.[0];
    if (selected && taskType === "execute") {
      this.executeReserved.set(selected, (this.executeReserved.get(selected) ?? 0) + 1);
    }
    return selected;
  }

  release(workerName: string, taskType: TaskType): void {
    if (taskType !== "execute") return;
    const reserved = this.executeReserved.get(workerName) ?? 0;
    if (reserved > 0) this.executeReserved.set(workerName, reserved - 1);
  }

  async execute(
    workerName: string,
    taskType: TaskType,
    prompt: string,
    timeoutMs: number,
    cwd: string,
    signal?: AbortSignal,
    currentSession?: SessionRef,
    options: { tmpDir?: string; onSpawn?: (pid: number) => void } = {},
  ): Promise<WorkerResult> {
    const route = this.config.workers[workerName];
    if (!route || !route.taskTypes.includes(taskType)) throw new Error(`worker is not routed for ${taskType}: ${workerName}`);
    if (taskType === "execute") {
      this.release(workerName, taskType);
      this.executeActive.set(workerName, (this.executeActive.get(workerName) ?? 0) + 1);
    }
    try {
      const result = await this.workers.execute(workerName, prompt, timeoutMs, cwd, signal, currentSession, options);
      if (result.returncode !== 0) this.retryAfter.set(workerName, Date.now() + 30_000);
      return result;
    } finally {
      if (taskType === "execute") this.executeActive.set(workerName, (this.executeActive.get(workerName) ?? 1) - 1);
    }
  }

  private executeLoad(name: string): number {
    return (this.executeActive.get(name) ?? 0) + (this.executeReserved.get(name) ?? 0);
  }
}

/** Strips config-only route metadata before it crosses into src/worker. */
function workerDefinitions(config: ResolvedTaskConfig): WorkerRuntimeConfig {
  return {
    workers: Object.fromEntries(Object.entries(config.workers).map(([name, worker]) => [name, {
      type: worker.type, model: worker.model, env: worker.env,
    }])),
  };
}
