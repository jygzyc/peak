import type { ResolvedTaskConfig, SchedulerConfig } from "./types.js";

export const DEFAULT_SCHEDULER: SchedulerConfig = {
  maxRunningProjects: 4,
  intervalMs: 3_000,
};

export const DEFAULT_PHASE: ResolvedTaskConfig["phase"] = {
  plan: {},
  supervise: { intervalMs: 60_000 },
  execute: { maxArtifactBytes: 10 * 1024 * 1024, customProfile: [] },
};
