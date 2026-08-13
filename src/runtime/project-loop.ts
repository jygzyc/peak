import { executeCapacity } from "../utils/task-config.js";
import type { ResolvedTaskConfig, TaskType } from "../utils/types.js";
import { GraphClient } from "../graph/graph-client.js";
import type { ProjectGraph } from "../graph/types.js";
import { ExecutionRegistry } from "./execution-registry.js";
import { PHASE_TIMEOUT_MS, TaskExecutor } from "./task-executor.js";

interface Checkpoint { facts: number; hints: number; open: number; jointPlan: string }

/**
 * Lifecycle hooks the Runtime wires to the execution backend. `onInactive`
 * releases the per-Project execution target (the Docker container) the moment
 * the Project leaves active state — completed and stopped Projects must not
 * keep long-lived containers around while the Task keeps running. `onActivated`
 * re-establishes the target (idempotent `ensureWorkspace`) when a Project
 * re-enters active state inside the same Runtime, e.g. a dashboard
 * stop/resume round-trip, so the executor never runs against a removed
 * container.
 */
export interface ProjectLoopHooks {
  onInactive?: (status: "completed" | "stopped") => void;
  onActivated?: () => Promise<void>;
}

/**
 * In-memory supervise timer. Pure `due/mark` cycle on the supervise interval;
 * Runtime restarts re-supervise active Projects immediately because this
 * carries no persisted cursor. Formerly its own 6-line `graph-supervisor.ts`.
 */
class SuperviseTimer {
  private nextAt = 0;
  constructor(private readonly intervalMs: number) {}
  due(now = Date.now()): boolean { return now >= this.nextAt; }
  mark(now = Date.now()): void { this.nextAt = now + this.intervalMs; }
}

export class ProjectLoop {
  private checkpoint?: Checkpoint;
  private readonly supervisor: SuperviseTimer;

  /** Previous tick's Project status; undefined until the first tick. */
  private lastStatus?: string;

  constructor(
    readonly projectId: string,
    private readonly config: ResolvedTaskConfig,
    private readonly graph: GraphClient,
    private readonly executor: TaskExecutor,
    private readonly executions: ExecutionRegistry,
    private readonly jointPlanVersion: () => string | Promise<string>,
    private readonly hooks: ProjectLoopHooks = {},
  ) {
    this.supervisor = new SuperviseTimer(config.phase.supervise.intervalMs);
  }

  /**
   * One scheduler tick. Execute capacity is a per-Project budget: this Project
   * may run up to `executeCapacity` Execute executions in parallel, computed
   * from its own in-flight count, and never shares or consumes the budget of
   * other Projects. Plan and Supervise run on their own channels and never
   * consume it. Returns the number of Execute executions started this tick.
   */
  async tick(): Promise<number> {
    const project = await this.graph.getProject(this.projectId);
    const status = project.project.status;
    if (status !== "active") {
      // Cancel in-flight work, drop the scratch dir, and release the
      // execution target exactly once per entry into non-active state. The
      // guard also fires on the first tick against an already-finished
      // Project, removing a container the Runtime created at startup.
      if (this.lastStatus !== status) {
        this.executions.cancelProject(this.projectId);
        this.executor.cleanupRuntimeTmp();
        this.hooks.onInactive?.(status as "completed" | "stopped");
      }
      this.lastStatus = status;
      return 0;
    }
    // Re-establish the execution target after a stop/resume round-trip inside
    // this Runtime; skipped on the first tick when the Project is already
    // active (registerProject established the workspace). A failure leaves
    // lastStatus unchanged so the next tick retries.
    if (this.lastStatus !== undefined && this.lastStatus !== "active") {
      await this.hooks.onActivated?.();
    }
    this.lastStatus = "active";
    // Supervise channel (independent of Execute capacity): at most one active
    // supervise per Project, gated only by its interval and Worker availability.
    if (this.supervisor.due() && !this.executions.has(this.projectId, "supervise")) {
      const worker = this.executor.reserveWorker("supervise");
      if (worker) {
        this.supervisor.mark();
        this.dispatch("supervise", worker, (signal, executionId) => this.executor.supervise(this.projectId, executionId, signal, worker));
      }
    }
    // Plan channel (independent of Execute capacity): at most one active plan
    // per Project, gated only by whether Plan is needed and Worker availability.
    const jointPlan = await this.jointPlanVersion();
    if (this.planNeeded(project, jointPlan) && !this.executions.has(this.projectId, "plan")) {
      const worker = this.executor.reserveWorker("plan");
      if (worker) {
        this.checkpoint = checkpoint(project, jointPlan);
        this.dispatch("plan", worker, (signal, executionId) => this.executor.plan(this.projectId, executionId, signal, worker), () => { this.checkpoint = undefined; });
      }
    }
    // Execute channel: consumes this Project's own Execute budget. One Execute
    // per open Intent that is not already running and whose Worker can be
    // reserved.
    let started = 0;
    let slots = executeCapacity(this.config) - this.executions.count(this.projectId, "execute");
    for (const intent of project.intents.filter((item) => item.to === null)) {
      if (slots <= 0) break;
      if (this.executions.has(this.projectId, "execute", intent.id)) continue;
      const worker = this.executor.reserveWorker("execute");
      if (!worker) break;
      this.dispatch("execute", worker, (signal, executionId) => this.executor.execute(this.projectId, intent, executionId, signal, worker), undefined, intent.id);
      slots -= 1;
      started += 1;
    }
    return started;
  }

  dispose(): void {
    this.executions.cancelProject(this.projectId);
  }

  private planNeeded(project: ProjectGraph, jointPlan: string): boolean {
    const current = checkpoint(project, jointPlan);
    if (!this.checkpoint) return true;
    return current.facts !== this.checkpoint.facts || current.hints !== this.checkpoint.hints
      || (this.checkpoint.open > 0 && current.open === 0) || current.jointPlan !== this.checkpoint.jointPlan;
  }

  private dispatch(
    kind: TaskType,
    workerName: string,
    run: (signal: AbortSignal, executionId: string) => Promise<void>,
    failed?: () => void,
    intentId?: string,
  ): void {
    const executionId = this.executions.createId();
    const controller = new AbortController();
    const timeoutMs = PHASE_TIMEOUT_MS[kind];
    this.executions.add({
      executionId, projectId: this.projectId, kind, intentId, workerName,
      controller, startedAt: Date.now(), deadlineAt: Date.now() + timeoutMs,
    });
    void run(controller.signal, executionId).catch((error) => {
      failed?.();
      const message = (error as Error).message;
      process.stderr.write(`[peak] ${kind} failed project=${this.projectId}: ${message}\n`);
      this.executor.logEvent("phase_failed", { projectId: this.projectId, kind, executionId, intentId: intentId ?? null, message });
    }).finally(() => this.executions.remove(executionId));
  }
}

function checkpoint(project: ProjectGraph, jointPlan: string): Checkpoint {
  return { facts: project.facts.length, hints: project.hints.length, open: project.intents.filter((item) => item.to === null).length, jointPlan };
}
