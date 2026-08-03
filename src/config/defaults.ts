import type { ResolvedTaskConfig, SchedulerConfig } from "./types.js";

export const DEFAULT_SCHEDULER: SchedulerConfig = {
  maxConcurrent: 4,
  maxRunningProjects: 4,
  maxProjectConcurrent: 2,
  refillPerTick: 4,
  intervalMs: 3_000,
};

export const DEFAULT_PHASE: ResolvedTaskConfig["phase"] = {
  plan: { maxIntents: 3 },
  supervise: { intervalMs: 60_000 },
  execute: { maxArtifactBytes: 100 * 1024 * 1024, customProfiles: [] },
};
