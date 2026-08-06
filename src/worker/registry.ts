import type { TaskType, WorkerType } from "../config/types.js";
import { claudeCodeProtocol } from "./backends/claude-code.js";
import { codexProtocol } from "./backends/codex.js";
import { opencodeProtocol } from "./backends/opencode.js";
import { piProtocol } from "./backends/pi.js";
import type { WorkerProtocol } from "./types.js";

/** Skill discovery directory a Worker backend reads (see `config/paths.ts`). */
export type WorkerSkillDirectory = "agents" | "claude";

export interface WorkerRegistration {
  protocol: WorkerProtocol;
  /** Global Skill discovery directories this backend reads; empty means none. */
  skillDirectories: readonly WorkerSkillDirectory[];
}

/**
 * The single Worker backend registry: adding a backend means implementing its
 * stateless `WorkerProtocol` and adding exactly one entry here. Config
 * validation, Skill installation roots, WorkerRuntime dispatch, and the
 * `peak workers` listing all derive from this table.
 */
export const WORKER_REGISTRY: Readonly<Record<WorkerType, WorkerRegistration>> = {
  opencode: { protocol: opencodeProtocol, skillDirectories: ["agents"] },
  codex: { protocol: codexProtocol, skillDirectories: [] },
  pi: { protocol: piProtocol, skillDirectories: ["agents"] },
  "claude-code": { protocol: claudeCodeProtocol, skillDirectories: ["claude"] },
};

export const WORKER_TYPES = Object.keys(WORKER_REGISTRY) as WorkerType[];

export const WORKER_PROTOCOLS: Record<WorkerType, WorkerProtocol> = Object.fromEntries(
  Object.entries(WORKER_REGISTRY).map(([type, registration]) => [type, registration.protocol]),
) as Record<WorkerType, WorkerProtocol>;

export const TASK_TYPES: TaskType[] = ["plan", "supervise", "execute"];
