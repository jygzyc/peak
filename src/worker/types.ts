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
export interface WorkerDriverBase {
  type: WorkerType;
  canResume: boolean;
}
export interface WorkerDriver extends WorkerDriverBase {
  build(config: WorkerConfig, prompt: string, session?: SessionRef): ProcessSpec;
  parse(result: ProcessResult): { text: string; session?: SessionRef };
}
export interface DirectWorkerDriver extends WorkerDriverBase {
  execute(request: WorkerRequest): Promise<WorkerResult>;
}
