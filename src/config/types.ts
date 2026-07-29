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

export interface ProjectConfig {
  id?: string;
  name: string;
  goal: string;
}

export interface TaskProjectConfig extends ProjectConfig {
  key: string;
  origin: string;
}

export interface ResolvedTaskConfig {
  configPath: string;
  taskDir: string;
  board: {
    name?: string;
    workspace: string;
    skills: string[];
    projects: ProjectConfig[];
  };
  workers: Record<string, WorkerConfig>;
  scheduler: SchedulerConfig;
  phase: {
    plan: { maxIntents: number };
    supervise: { intervalMs: number };
    execute: { maxArtifactBytes: number };
  };
}

export interface InstalledSkill {
  name: string;
  targets: string[];
  temporaryTargets: string[];
}

export interface SkillInstallOptions {
  agentsDir?: string;
  claudeDir?: string;
}
