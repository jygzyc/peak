import { createHash } from "node:crypto";
import type { WorkerDefinition } from "../worker/types.js";

export type { WorkerType } from "../worker/types.js";

export const TASK_TYPES = ["plan", "supervise", "execute"] as const;
export type TaskType = typeof TASK_TYPES[number];

/** Config-layer routing and scheduling metadata for one named Worker. */
export interface WorkerConfig extends WorkerDefinition {
  taskTypes: TaskType[];
  maxRunning: number;
  priority: number;
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

export const DEFAULT_SCHEDULER: SchedulerConfig = {
  maxRunningProjects: 4,
  intervalMs: 3_000,
};

export const DEFAULT_PHASE: ResolvedTaskConfig["phase"] = {
  plan: {},
  supervise: { intervalMs: 60_000 },
  execute: { maxArtifactBytes: 10 * 1024 * 1024, customProfile: [] },
};

export function customProfileDigest(profile: CustomProfileDefinition): string {
  return createHash("sha256")
    .update(`${profile.description}#${profile.prompt}`, "utf8")
    .digest("hex")
    .slice(0, 16);
}
