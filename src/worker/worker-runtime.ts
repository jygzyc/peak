import type { ResolvedTaskConfig, TaskType, WorkerType } from "../config/types.js";
import { ClaudeCodeDriver } from "./backends/claude-code.js";
import { CodexDriver } from "./backends/codex.js";
import { OpenCodeDriver } from "./backends/opencode.js";
import { PiDriver } from "./backends/pi.js";
import { ProcessRunner } from "./process-runner.js";
import type { SessionRef, WorkerDriver, WorkerResult } from "./types.js";

export class WorkerResources {
  readonly active = new Map<string, number>();
  readonly reserved = new Map<string, number>();
  readonly retryAfter = new Map<string, number>();
  private readonly drivers = new Map<WorkerType, WorkerDriver>();

  constructor(runner = new ProcessRunner(), drivers?: Iterable<WorkerDriver>) {
    const available = drivers ?? [
      new OpenCodeDriver(runner),
      new CodexDriver(runner),
      new PiDriver(),
      new ClaudeCodeDriver(runner),
    ];
    for (const driver of available) {
      if (this.drivers.has(driver.type)) throw new Error(`duplicate worker driver: ${driver.type}`);
      this.drivers.set(driver.type, driver);
    }
  }

  driver(type: WorkerType): WorkerDriver | undefined {
    return this.drivers.get(type);
  }

  dispose(): void {
    for (const driver of this.drivers.values()) driver.dispose();
  }
}

export class WorkerRuntime {
  constructor(
    readonly config: ResolvedTaskConfig,
    private readonly resources = new WorkerResources(),
  ) {}

  pick(taskType: TaskType): string | undefined {
    const selected = Object.entries(this.config.workers)
      .filter(([name, worker]) => worker.taskTypes.includes(taskType)
        && this.load(name) < worker.maxRunning
        && (this.resources.retryAfter.get(name) ?? 0) <= Date.now())
      .sort(([a, left], [b, right]) => left.priority - right.priority
        || this.load(a) - this.load(b)
        || a.localeCompare(b))[0]?.[0];
    if (selected) this.resources.reserved.set(selected, (this.resources.reserved.get(selected) ?? 0) + 1);
    return selected;
  }

  release(workerName: string): void {
    const reserved = this.resources.reserved.get(workerName) ?? 0;
    if (reserved <= 0) throw new Error(`worker reservation not found: ${workerName}`);
    this.resources.reserved.set(workerName, reserved - 1);
  }

  async execute(
    workerName: string,
    taskType: TaskType,
    prompt: string,
    timeoutMs: number,
    cwd: string,
    signal?: AbortSignal,
    currentSession?: SessionRef,
  ): Promise<WorkerResult> {
    const config = this.config.workers[workerName];
    if (!config) throw new Error(`worker not found: ${workerName}`);
    if (!config.taskTypes.includes(taskType)) throw new Error(`worker does not support ${taskType}: ${workerName}`);
    const driver = this.resources.driver(config.type);
    if (!driver) throw new Error(`worker driver not found: ${config.type}`);
    if (currentSession && (currentSession.workerType !== config.type || !driver.canResume)) {
      throw new Error(`worker cannot resume session: ${workerName}`);
    }

    const reservation = this.resources.reserved.get(workerName) ?? 0;
    if (reservation > 0) this.resources.reserved.set(workerName, reservation - 1);
    this.resources.active.set(workerName, (this.resources.active.get(workerName) ?? 0) + 1);
    try {
      const result = await driver.execute({
        workerName,
        config,
        taskType,
        prompt,
        timeoutMs,
        cwd,
        signal,
        session: currentSession,
      });
      if (result.returncode !== 0) this.resources.retryAfter.set(workerName, Date.now() + 30_000);
      return result;
    } finally {
      this.resources.active.set(workerName, (this.resources.active.get(workerName) ?? 1) - 1);
    }
  }

  private load(name: string): number {
    return (this.resources.active.get(name) ?? 0) + (this.resources.reserved.get(name) ?? 0);
  }
}
