import type { TaskType, WorkerConfig, WorkerType } from "../config/types.js";

export interface SessionRef { workerType: WorkerType; value: string }
export interface ProcessSpec { argv: string[]; input?: string; env?: Record<string, string> }
export interface ProcessResult {
  stdout: string; stderr: string; returncode: number; timedOut: boolean; cancelled: boolean; started: boolean;
}
export interface WorkerResult extends ProcessResult { text: string; session?: SessionRef }
export interface WorkerRequest {
  workerName: string; config: WorkerConfig; taskType: TaskType; prompt: string; cwd: string;
  timeoutMs: number; signal?: AbortSignal; session?: SessionRef;
}
export interface WorkerDriver {
  readonly type: WorkerType;
  readonly canResume: boolean;
  execute(request: WorkerRequest): Promise<WorkerResult>;
  dispose(): void;
}
