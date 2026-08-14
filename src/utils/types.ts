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
  /** Task Skills made available only while this profile is active. */
  skills: string[];
}

/** Where worker processes run: `local` (host subprocesses) or `docker` (one long-lived container per project, `docker exec`). */
export type ExecutionMode = "local" | "docker";

/** Task-level execution policy from task.json. Docker still creates one container per Project. */
export interface ExecutionConfig {
  /** Preferred backend. Docker unavailability falls back the whole Task to local execution. */
  mode: ExecutionMode;
  /** Docker `--network` value, e.g. `host` for listening sockets / OOB exfil. Default: bridge. */
  networkMode?: string;
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
  execution: ExecutionConfig;
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

/** Default port of the Board-local embedded Peak Server. */
export const DEFAULT_PHASE: ResolvedTaskConfig["phase"] = {
  plan: {},
  supervise: { intervalMs: 60_000 },
  execute: { maxArtifactBytes: 10 * 1024 * 1024, customProfile: [] },
};

export function customProfileDigest(profile: CustomProfileDefinition): string {
  return createHash("sha256")
    .update(JSON.stringify({ description: profile.description, prompt: profile.prompt, skills: profile.skills }), "utf8")
    .digest("hex")
    .slice(0, 16);
}
