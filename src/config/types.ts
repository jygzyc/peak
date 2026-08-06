export type WorkerType = "opencode" | "codex" | "pi" | "claude-code";
export type TaskType = "plan" | "supervise" | "execute";

export interface WorkerConfig {
  type: WorkerType;
  model?: string;
  taskTypes: TaskType[];
  maxRunning: number;
  priority: number;
  /** Per-worker environment variables merged into the CLI subprocess env. */
  env: Record<string, string>;
}

export interface CustomProfileDefinition {
  description: string;
  prompt: string;
}

export interface SchedulerConfig {
  maxRunningProjects: number;
  intervalMs: number;
}

export interface ProjectConfig {
  id?: string;
  source: string;
  goal: string;
}

export interface TaskProjectConfig extends ProjectConfig {
  key: string;
}

export interface ResolvedTaskConfig {
  configPath: string;
  taskDir: string;
  board: {
    name?: string;
    skills: string[];
    projects: ProjectConfig[];
  };
  workers: Record<string, WorkerConfig>;
  scheduler: SchedulerConfig;
  phase: {
    plan: { customProfile?: CustomProfileDefinition };
    supervise: { intervalMs: number; customProfile?: CustomProfileDefinition };
    execute: { maxArtifactBytes: number; customProfile: CustomProfileDefinition[] };
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
