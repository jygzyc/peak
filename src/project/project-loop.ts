import { randomUUID } from "node:crypto";
import type { ResolvedTaskConfig, TaskType } from "../config/types.js";
import { GraphClient } from "../graph/graph-client.js";
import type { ProjectGraph } from "../graph/types.js";
import { ExecutionRegistry } from "../runtime/execution-registry.js";
import { TaskExecutor } from "../runtime/task-executor.js";
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

  async tick(globalSlots: number): Promise<number> {
    const project = await this.graph.getProject(this.projectId);
    if (project.project.status !== "active") {
      this.executions.cancelProject(this.projectId);
      return 0;
    }
    let started = 0;
    const projectSlots = Math.max(0, this.config.scheduler.maxProjectConcurrent - this.executions.count(this.projectId));
    let available = Math.min(globalSlots, projectSlots, this.config.scheduler.refillPerTick);
    if (available > 0 && this.supervisor.due() && !this.executions.has(this.projectId, "supervise")) {
      this.supervisor.mark();
      this.dispatch("supervise", (signal, executionId) => this.executor.supervise(this.projectId, executionId, signal));
      available--; started++;
    }
    if (available > 0 && this.planNeeded(project) && !this.executions.has(this.projectId, "plan")) {
      this.checkpoint = checkpoint(project, this.pendingCount());
      this.dispatch("plan", (signal, executionId) => this.executor.plan(this.projectId, executionId, signal), () => { this.checkpoint = undefined; });
      available--; started++;
    }
    for (const intent of project.intents.filter((item) => item.to === null)) {
      if (available === 0) break;
      if (this.executions.has(this.projectId, "execute", intent.id)) continue;
      this.dispatch("execute", (signal, executionId) => this.executor.execute(this.projectId, intent, executionId, signal), undefined, intent.id);
      available--; started++;
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

  private dispatch(kind: TaskType, run: (signal: AbortSignal, executionId: string) => Promise<void>, failed?: () => void, intentId?: string): void {
    const executionId = randomUUID();
    const controller = new AbortController();
    this.executions.add({ executionId, projectId: this.projectId, kind, intentId, controller });
    void run(controller.signal, executionId).catch((error) => {
      failed?.();
      process.stderr.write(`[peak] ${kind} failed project=${this.projectId}: ${(error as Error).message}\n`);
    }).finally(() => this.executions.remove(executionId));
  }
}

function checkpoint(project: ProjectGraph, federation: number): Checkpoint {
  return { facts: project.facts.length, hints: project.hints.length, open: project.intents.filter((item) => item.to === null).length, federation };
}
