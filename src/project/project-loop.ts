import { executeCapacity } from "../config/task-config.js";
import type { ResolvedTaskConfig, TaskType } from "../config/types.js";
import { GraphClient } from "../graph/graph-client.js";
import type { ProjectGraph } from "../graph/types.js";
import { ExecutionRegistry } from "../runtime/execution-registry.js";
import { PHASE_TIMEOUT_MS, TaskExecutor } from "../runtime/task-executor.js";
import { GraphSupervisor } from "./graph-supervisor.js";

interface Checkpoint { facts: number; hints: number; open: number; federation: number }


export class ProjectLoop {
  private checkpoint?: Checkpoint;
  private readonly supervisor: GraphSupervisor;

  constructor(
    readonly projectId: string,
    private readonly config: ResolvedTaskConfig,
    private readonly graph: GraphClient,
    private readonly executor: TaskExecutor,
    private readonly executions: ExecutionRegistry,
    private readonly pendingCount: () => number,
  ) {
    this.supervisor = new GraphSupervisor(config.phase.supervise.intervalMs);
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
    if (project.project.status !== "active") {
      this.executions.cancelProject(this.projectId);
      this.executor.cleanupRuntimeTmp();
      return 0;
    }
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
    if (this.planNeeded(project) && !this.executions.has(this.projectId, "plan")) {
      const worker = this.executor.reserveWorker("plan");
      if (worker) {
        this.checkpoint = checkpoint(project, this.pendingCount());
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

  private planNeeded(project: ProjectGraph): boolean {
    const current = checkpoint(project, this.pendingCount());
    if (!this.checkpoint) return true;
    return current.facts !== this.checkpoint.facts || current.hints !== this.checkpoint.hints
      || (this.checkpoint.open > 0 && current.open === 0) || current.federation !== this.checkpoint.federation;
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

function checkpoint(project: ProjectGraph, federation: number): Checkpoint {
  return { facts: project.facts.length, hints: project.hints.length, open: project.intents.filter((item) => item.to === null).length, federation };
}
