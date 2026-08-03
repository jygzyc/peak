import { randomBytes } from "node:crypto";
import type { TaskType } from "../config/types.js";

export interface ActiveExecution {
  executionId: string;
  projectId: string;
  kind: TaskType;
  intentId?: string;
  workerName?: string;
  controller: AbortController;
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
  count(projectId?: string): number {
    return projectId ? [...this.values.values()].filter((item) => item.projectId === projectId).length : this.values.size;
  }
  has(projectId: string, kind: TaskType, intentId?: string): boolean {
    return [...this.values.values()].some((item) => item.projectId === projectId && item.kind === kind && item.intentId === intentId);
  }
  cancelProject(projectId: string): void {
    for (const execution of this.values.values()) if (execution.projectId === projectId) execution.controller.abort();
  }
  cancelAll(): void { for (const execution of this.values.values()) execution.controller.abort(); }
}
