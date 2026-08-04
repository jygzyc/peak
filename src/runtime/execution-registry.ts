import { randomBytes } from "node:crypto";
import type { TaskType } from "../config/types.js";
import { localTimestamp } from "../graph/api.js";

export interface ActiveExecution {
  executionId: string;
  projectId: string;
  kind: TaskType;
  intentId?: string;
  workerName?: string;
  processId?: number;
  startedAt: number;
  deadlineAt?: number;
  controller: AbortController;
}

/**
 * Immutable public DTO for an in-flight execution. Excludes the AbortController
 * and every internal handle so the Registry never leaks cancellation, prompts,
 * outputs, argv, env, or Worker objects to API consumers.
 */
export interface ExecutionSnapshot {
  executionId: string;
  projectId: string;
  kind: TaskType;
  intentId: string | null;
  workerName: string | null;
  processId: number | null;
  startedAt: string;
  deadlineAt: string | null;
}

export class ExecutionRegistry {
  private readonly values = new Map<string, ActiveExecution>();
  add(execution: ActiveExecution): void { this.values.set(execution.executionId, execution); }
  remove(executionId: string): void { this.values.delete(executionId); }
  createId(): string {
    let executionId: string;
    do executionId = randomBytes(4).toString("hex");
    while (this.values.has(executionId));
    return executionId;
  }
  /** Backfills the child PID once the CLI subprocess has spawned. */
  setProcessId(executionId: string, pid: number): void {
    const execution = this.values.get(executionId);
    if (execution) execution.processId = pid;
  }
  count(projectId?: string, kind?: TaskType): number {
    return [...this.values.values()].filter((item) => (!projectId || item.projectId === projectId)
      && (!kind || item.kind === kind)).length;
  }
  has(projectId: string, kind: TaskType, intentId?: string): boolean {
    return [...this.values.values()].some((item) => item.projectId === projectId && item.kind === kind && item.intentId === intentId);
  }
  /** Returns immutable snapshots, optionally filtered to one Project. */
  snapshot(projectId?: string): ExecutionSnapshot[] {
    return [...this.values.values()]
      .filter((item) => !projectId || item.projectId === projectId)
      .map((item) => ({
        executionId: item.executionId,
        projectId: item.projectId,
        kind: item.kind,
        intentId: item.intentId ?? null,
        workerName: item.workerName ?? null,
        processId: item.processId ?? null,
        startedAt: localTimestamp(new Date(item.startedAt)),
        deadlineAt: item.deadlineAt !== undefined ? localTimestamp(new Date(item.deadlineAt)) : null,
      }));
  }
  cancelProject(projectId: string): void {
    for (const execution of this.values.values()) if (execution.projectId === projectId) execution.controller.abort();
  }
  cancelAll(): void { for (const execution of this.values.values()) execution.controller.abort(); }
  /** Waits for cancelled dispatch promises to finish their ProcessRunner cleanup. */
  async waitForEmpty(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.values.size > 0) {
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${this.values.size} execution(s) to stop`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
