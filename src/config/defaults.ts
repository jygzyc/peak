import type { ResolvedTaskConfig, SchedulerConfig } from "./types.js";

export const DEFAULT_SCHEDULER: SchedulerConfig = {
  maxConcurrent: 4,
  maxRunningProjects: 4,
  maxProjectConcurrent: 2,
  refillPerTick: 4,
  intervalMs: 3_000,
};

export const DEFAULT_TASKS: ResolvedTaskConfig["tasks"] = {
  plan: { timeoutMs: 45_000, maxIntents: 3 },
  supervise: { timeoutMs: 45_000, intervalMs: 60_000 },
  execute: { timeoutMs: 600_000, finalizeTimeoutMs: 120_000, maxArtifactBytes: 100 * 1024 * 1024 },
};
