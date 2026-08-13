import type { WorkerType } from "./types.js";

/** Skill discovery directory a Worker reads (see `utils/paths.ts`). */
type WorkerSkillDirectory = "agents";

interface WorkerRegistration {
  /** Global Skill discovery directories this worker reads; empty means none. */
  skillDirectories: readonly WorkerSkillDirectory[];
}

/**
 * The single Worker registry. Peak embeds pi through its SDK as the only
 * worker (see pi-sdk.ts); worker type validation, Skill discovery, and CLI
 * listing derive from this table.
 */
export const WORKER_REGISTRY: Readonly<Record<WorkerType, WorkerRegistration>> = {
  pi: { skillDirectories: ["agents"] },
};

export const WORKER_TYPES = Object.keys(WORKER_REGISTRY) as WorkerType[];
