import type { ResolvedTaskConfig, TaskType, WorkerType } from "../config/types.js";
import { ProcessRunner } from "./process-runner.js";
import { claudeCodeProtocol } from "./backends/claude-code.js";
import { codexProtocol } from "./backends/codex.js";
import { opencodeProtocol } from "./backends/opencode.js";
import { piProtocol } from "./backends/pi.js";
import type { SessionRef, WorkerCall, WorkerProtocol, WorkerResult } from "./types.js";

const DEFAULT_PROTOCOLS: Record<WorkerType, WorkerProtocol> = {
  opencode: opencodeProtocol,
  codex: codexProtocol,
  pi: piProtocol,
  "claude-code": claudeCodeProtocol,
};

/**
 * WorkerRuntime owns Worker selection, Execute reservations, the per-Worker
 * failure cooldown, and CLI subprocess orchestration. It shares a single
 * ProcessRunner across every Project and every protocol.
 *
 * Capacity is split by channel: Plan and Supervise are independent control
 * channels and never consume a Worker's `maxRunning`, so one Worker with
 * `maxRunning: 1` can run one Plan, one Supervise and one Execute at once but
 * never two Executes. Per-Project "at most one Plan / one Supervise" is
 * enforced by ExecutionRegistry, not by Worker capacity. A 30-second cooldown
 * still gates every phase after a non-zero exit.
 */
export class WorkerRuntime {
  private readonly executeActive = new Map<string, number>();
  private readonly executeReserved = new Map<string, number>();
  private readonly retryAfter = new Map<string, number>();

  constructor(
    readonly config: ResolvedTaskConfig,
    private readonly runner = new ProcessRunner(),
    private readonly protocols: Record<WorkerType, WorkerProtocol> = DEFAULT_PROTOCOLS,
  ) {}

  pick(taskType: TaskType): string | undefined {
    const selected = Object.entries(this.config.workers)
      .filter(([name, worker]) => worker.taskTypes.includes(taskType)
        && (taskType !== "execute" || this.executeLoad(name) < worker.maxRunning)
        && (this.retryAfter.get(name) ?? 0) <= Date.now())
      .sort(([a, left], [b, right]) => left.priority - right.priority
        || this.executeLoad(a) - this.executeLoad(b)
        || a.localeCompare(b))[0]?.[0];
    if (selected) {
      if (taskType === "execute") this.executeReserved.set(selected, (this.executeReserved.get(selected) ?? 0) + 1);
      // Control channels (plan/supervise) are not reservation-counted: they do
      // not consume maxRunning, so we leave the Execute counters untouched.
    }
    return selected;
  }

  release(workerName: string): void {
    const reserved = this.executeReserved.get(workerName) ?? 0;
    if (reserved <= 0) return; // control-channel picks hold no Execute reservation
    this.executeReserved.set(workerName, reserved - 1);
  }

  async execute(
    workerName: string,
    taskType: TaskType,
    prompt: string,
    timeoutMs: number,
    cwd: string,
    signal?: AbortSignal,
    currentSession?: SessionRef,
    options: { sessionDir?: string; onSpawn?: (pid: number) => void } = {},
  ): Promise<WorkerResult> {
    const config = this.config.workers[workerName];
    if (!config) throw new Error(`worker not found: ${workerName}`);
    if (!config.taskTypes.includes(taskType)) throw new Error(`worker does not support ${taskType}: ${workerName}`);
    const protocol = this.protocols[config.type];
    if (!protocol) throw new Error(`worker protocol not found: ${config.type}`);
    if (currentSession && (currentSession.workerType !== config.type || !protocol.canResume)) {
      throw new Error(`worker cannot resume session: ${workerName}`);
    }

    // Only Execute consumes maxRunning capacity; Plan/Supervise run through
    // the same subprocess but never touch the Execute counters.
    if (taskType === "execute") {
      const reservation = this.executeReserved.get(workerName) ?? 0;
      if (reservation > 0) this.executeReserved.set(workerName, reservation - 1);
      this.executeActive.set(workerName, (this.executeActive.get(workerName) ?? 0) + 1);
    }
    try {
      const call: WorkerCall = {
        workerName, config, taskType, prompt, cwd, session: currentSession, sessionDir: options.sessionDir,
      };
      const session = protocol.prepareSession ? protocol.prepareSession(call) : call.session;
      const spec = protocol.build(call, session);
      const process = await this.runner.run(spec, cwd, timeoutMs, signal, config.env, options.onSpawn);
      const parsed = protocol.parse(process);
      if (process.returncode !== 0) this.retryAfter.set(workerName, Date.now() + 30_000);
      return { ...process, text: parsed.text, session: parsed.session ?? session };
    } finally {
      if (taskType === "execute") {
        this.executeActive.set(workerName, (this.executeActive.get(workerName) ?? 1) - 1);
      }
    }
  }

  private executeLoad(name: string): number {
    return (this.executeActive.get(name) ?? 0) + (this.executeReserved.get(name) ?? 0);
  }
}
