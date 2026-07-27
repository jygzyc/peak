import type { ResolvedTaskConfig, TaskType, WorkerType } from "../config/types.js";
import { ClaudeCodeDriver } from "./backends/claude-code.js";
import { CodexDriver } from "./backends/codex.js";
import { OpenCodeDriver } from "./backends/opencode.js";
import { PiDriver } from "./backends/pi.js";
import { ProcessRunner } from "./process-runner.js";
import type { DirectWorkerDriver, SessionRef, WorkerDriver, WorkerResult } from "./types.js";

export class WorkerResources {
  readonly active = new Map<string, number>();
  readonly reserved = new Map<string, number>();
  readonly retryAfter = new Map<string, number>();
  readonly piDriver = new PiDriver();

  dispose(): void {
    this.piDriver.dispose();
  }
}

export class WorkerRuntime {
  private readonly drivers = new Map<WorkerType, WorkerDriver | DirectWorkerDriver>();

  constructor(
    readonly config: ResolvedTaskConfig,
    private readonly resources = new WorkerResources(),
    private readonly runner = new ProcessRunner(),
  ) {
    for (const driver of [new OpenCodeDriver(), new CodexDriver(), this.resources.piDriver, new ClaudeCodeDriver()]) {
      this.drivers.set(driver.type, driver);
    }
  }

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
    const driver = this.drivers.get(config.type);
    if (currentSession && (currentSession.workerType !== config.type || !driver?.canResume)) {
      throw new Error(`worker cannot resume session: ${workerName}`);
    }
    const reservation = this.resources.reserved.get(workerName) ?? 0;
    if (reservation > 0) this.resources.reserved.set(workerName, reservation - 1);
    this.resources.active.set(workerName, (this.resources.active.get(workerName) ?? 0) + 1);
    try {
      if (!driver) throw new Error(`worker driver not found: ${config.type}`);
      const result = isDirectDriver(driver)
        ? await driver.execute({ workerName, config, taskType, prompt, timeoutMs, cwd, signal, session: currentSession })
        : await this.executeProcess(driver, config, prompt, timeoutMs, cwd, signal, currentSession);
      if (result.returncode !== 0) this.resources.retryAfter.set(workerName, Date.now() + 30_000);
      return result;
    } finally {
      this.resources.active.set(workerName, (this.resources.active.get(workerName) ?? 1) - 1);
    }
  }

  private async executeProcess(
    driver: WorkerDriver,
    config: ResolvedTaskConfig["workers"][string],
    prompt: string,
    timeoutMs: number,
    cwd: string,
    signal?: AbortSignal,
    currentSession?: SessionRef,
  ): Promise<WorkerResult> {
    const process = await this.runner.run(driver.build(config, prompt, currentSession), cwd, timeoutMs, signal);
    const parsed = driver.parse(process);
    return { ...process, text: parsed.text, session: parsed.session ?? currentSession };
  }

  private load(name: string): number {
    return (this.resources.active.get(name) ?? 0) + (this.resources.reserved.get(name) ?? 0);
  }
}

function isDirectDriver(driver: WorkerDriver | DirectWorkerDriver): driver is DirectWorkerDriver {
  return "execute" in driver;
}
