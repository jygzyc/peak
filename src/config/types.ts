export type WorkerType = "opencode" | "codex" | "pi" | "claude-code";
export type TaskType = "plan" | "supervise" | "execute";

export interface WorkerConfig {
  type: WorkerType;
  model?: string;
  taskTypes: TaskType[];
  maxRunning: number;
  priority: number;
  args: string[];
}

export interface SchedulerConfig {
  maxConcurrent: number;
  maxRunningProjects: number;
  maxProjectConcurrent: number;
  refillPerTick: number;
  intervalMs: number;
}

export interface ResolvedTaskConfig {
  configPath: string;
  taskDir: string;
  task: {
    name?: string;
    target: string;
    goal: string;
    workspace: string;
    skills: string[];
  };
  workers: Record<string, WorkerConfig>;
  scheduler: SchedulerConfig;
  tasks: {
    plan: { timeoutMs: number; maxIntents: number };
    supervise: { timeoutMs: number; intervalMs: number };
    execute: { timeoutMs: number; finalizeTimeoutMs: number; maxArtifactBytes: number };
  };
  federation?: { scope?: string };
}

export interface InstalledSkill {
  name: string;
  source: string;
  targets: string[];
}
